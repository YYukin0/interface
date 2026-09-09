import { agentAction, type AgentAction, type DiscoveryInput } from '@cua/contracts';

/**
 * =============================================================================
 * THE MODEL'S ACTION VOCABULARY, AS TOOLS
 * =============================================================================
 * `agentAction` in contracts is the authority on what the model may ask for.
 * This file is the same union expressed as JSON Schema, because that is the
 * shape an API tool definition takes.
 *
 * Two things stop the duplication rotting. First, `TOOLS` is checked against
 * `agentAction.options` by a test, so a tool added to one and forgotten in the
 * other fails the build rather than failing at 3am in a discovery run. Second,
 * nothing here is trusted: whatever the model returns is parsed by the zod
 * schema before it is looked at, so a malformed or invented tool call is a
 * rejected turn, not an exception halfway through an action.
 *
 * The descriptions are load-bearing and are written for a reader who cannot see
 * the code — they are the only place the model learns that `ref`s expire, that
 * `assert` is how a checkpoint gets created, and that `stuck` is a legitimate
 * answer rather than a failure to try hard enough.
 */

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

const REF = {
  type: 'string',
  description:
    'A ref from the CURRENT observation, e.g. "f2e17". Refs are reassigned on every ' +
    'observation — never reuse one from an earlier step, and never invent one.',
} as const;

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
): ToolSchema {
  return {
    name,
    description,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const TOOLS: readonly ToolSchema[] = [
  tool('click', 'Click an element.', { ref: REF }, ['ref']),
  tool('double_click', 'Double-click an element.', { ref: REF }, ['ref']),
  tool(
    'type',
    'Type text into a field, replacing whatever is there. To use a run parameter, ' +
      'pass its reference (for example "$.inputs.memberId") as the text — you will ' +
      'not be shown the value and must not try to guess it.',
    { ref: REF, text: { type: 'string', description: 'Literal text, or "$.inputs.<name>".' } },
    ['ref', 'text'],
  ),
  tool(
    'select',
    'Choose an option in a dropdown, by its visible label.',
    { ref: REF, option: { type: 'string' } },
    ['ref', 'option'],
  ),
  tool(
    'set_checked',
    'Set a checkbox or radio to a specific state.',
    { ref: REF, checked: { type: 'boolean' } },
    ['ref', 'checked'],
  ),
  tool(
    'press_key',
    'Press a key on the focused element, e.g. "Enter" or "Tab".',
    { key: { type: 'string' } },
    ['key'],
  ),
  tool(
    'navigate',
    'Go to a URL directly. Prefer clicking a link when one exists — a URL you ' +
      'construct may not be one the application would ever produce.',
    { url: { type: 'string' } },
    ['url'],
  ),
  tool('scroll_into_view', 'Bring an off-screen element into view.', { ref: REF }, ['ref']),
  tool(
    'extract',
    'Read a value off the screen and give it a name in this capability\'s output. ' +
      'Use this for every value the goal asks you to report; do not paraphrase ' +
      'screen contents in your rationale instead.',
    {
      ref: REF,
      name: { type: 'string', description: 'Output name, e.g. "savingsBalance".' },
      as: {
        type: 'string',
        enum: ['text', 'money', 'number', 'integer', 'date', 'boolean', 'table'],
      },
    },
    ['ref', 'name', 'as'],
  ),
  tool(
    'dismiss_dialog',
    'Accept or dismiss a native browser dialog that is blocking the page.',
    { accept: { type: 'boolean' } },
    ['accept'],
  ),
  tool(
    'assert',
    'Record that you believe you have arrived somewhere ("the member detail page ' +
      'for the requested member is open"). These become the replayed capability\'s ' +
      'checkpoints, so assert after each meaningful transition rather than at the end.',
    { description: { type: 'string' } },
    ['description'],
  ),
  tool(
    'done',
    'The goal is achieved. Everything the caller asked for has been extracted.',
    { summary: { type: 'string' } },
    ['summary'],
  ),
  tool(
    'stuck',
    'You cannot make progress. This is a legitimate outcome and is preferred over ' +
      'guessing: a human takes over the same live session from here.',
    {
      reason: {
        type: 'string',
        enum: [
          'locator_unresolved',
          'locator_disagreement',
          'locator_ambiguous',
          'checkpoint_failed',
          'policy_requires_confirmation',
          'irreversible_action',
          'session_expired',
          'unknown_state',
          'max_steps_exhausted',
          'agent_requested_help',
        ],
      },
      explanation: { type: 'string' },
    },
    ['reason', 'explanation'],
  ),
];

/**
 * Every action carries a `rationale`, and it is a separate tool-agnostic field
 * rather than a property of each tool.
 *
 * The brief asks the evidence to show what the agent did *and why*. Making the
 * "why" part of the request the model fills in — instead of hoping it narrates
 * in free text we then have to parse — is what makes `rationale` reliably
 * present on every recorded step.
 */
export const RATIONALE_PROPERTY = {
  rationale: {
    type: 'string',
    description: 'One sentence: why this action, now. Recorded in the audit trail.',
  },
} as const;

/** `TOOLS` with `rationale` spliced into every schema, as sent to the API. */
export function toolsWithRationale(): readonly ToolSchema[] {
  return TOOLS.map((t) => ({
    ...t,
    input_schema: {
      ...t.input_schema,
      properties: { ...t.input_schema.properties, ...RATIONALE_PROPERTY },
      required: [...t.input_schema.required, 'rationale'],
    },
  }));
}

export interface ParsedCall {
  readonly action: AgentAction;
  readonly rationale: string;
}

/**
 * Turn a raw tool call into something the loop may act on, or explain why not.
 *
 * The rejection message goes back to the model as a tool result. That is the
 * difference between a system that crashes on a bad tool call and one that
 * tells the model `ref "e4" is not in the current observation` and lets it try
 * again — and the same channel carries policy denials, so there is exactly one
 * way for the loop to say "no, because".
 */
export function parseCall(
  name: string,
  raw: unknown,
): { ok: true; call: ParsedCall } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `arguments for '${name}' must be an object` };
  }

  const { rationale, ...rest } = raw as Record<string, unknown>;
  const parsed = agentAction.safeParse({ tool: name, ...rest });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || name}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `'${name}' arguments are invalid — ${issues}` };
  }

  return {
    ok: true,
    call: {
      action: parsed.data,
      // A missing rationale is not worth rejecting a valid action over; the
      // trace records that the model did not give one, which is itself signal.
      rationale: typeof rationale === 'string' && rationale.trim().length > 0
        ? rationale.trim()
        : '(no rationale given)',
    },
  };
}

/** How declared inputs are shown to the model: names and shapes, no values. */
export function describeInputs(inputs: readonly DiscoveryInput[]): string {
  if (inputs.length === 0) return 'This run has no parameters.';
  const lines = inputs.map(
    (i) => `  $.inputs.${i.name} — ${i.description} (classification: ${i.classification})`,
  );
  return [
    'Parameters available to this run. Their values are withheld from you on purpose;',
    'pass the reference itself as the text and the system substitutes the real value:',
    ...lines,
  ].join('\n');
}
