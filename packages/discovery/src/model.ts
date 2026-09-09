import Anthropic from '@anthropic-ai/sdk';

import { parseCall, toolsWithRationale, type ParsedCall } from './tools.js';

/**
 * =============================================================================
 * THE MODEL, BEHIND AN INTERFACE
 * =============================================================================
 * `DecisionModel` is text in, one tool call out. The loop owns prompt
 * construction, policy, evidence and recovery; this file owns "ask something
 * that might be wrong, and never let it throw".
 *
 * The interface exists for two reasons that are not "testability in the
 * abstract". First, every test in this package runs against `ScriptedModel`, so
 * the loop's behaviour under a policy denial, a dead end, or a hallucinated ref
 * is asserted deterministically and for free — the real model is exercised once,
 * for the evidence, not on every `npm test`. Second, it is the wall that keeps
 * I1 honest: `packages/replay` cannot depend on a model SDK, and the only import
 * of one in the whole system is the line at the top of this file.
 */

export interface ModelReply {
  /** Null when the model did not produce a usable tool call. */
  readonly call: ParsedCall | null;
  /** Why not, phrased for the model — it goes back as the next turn's feedback. */
  readonly error: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface DecisionModel {
  /** Recorded in the run manifest, so evidence names the model that produced it. */
  readonly id: string;
  decide(system: string, user: string): Promise<ModelReply>;
}

// -----------------------------------------------------------------------------
// The real one
// -----------------------------------------------------------------------------

/**
 * Credentials come from `CUA_LLM_*`, deliberately not from `ANTHROPIC_API_KEY`.
 *
 * Inheriting the ambient Anthropic variables would be convenient and is exactly
 * the wrong default: on a developer machine those are usually pointed at
 * whatever tooling the developer is running, sometimes a proxy or a gateway with
 * a different model behind it. A discovery run would then silently be conducted
 * by a model the evidence does not name, which quietly makes the artifact's
 * provenance a fiction. Requiring its own variables means the run either has
 * credentials chosen for it or does not start.
 */
export const ENV = {
  apiKey: 'CUA_LLM_API_KEY',
  baseUrl: 'CUA_LLM_BASE_URL',
  model: 'CUA_LLM_MODEL',
  toolChoice: 'CUA_LLM_TOOL_CHOICE',
} as const;

export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Forced tool use is the default and the design; `auto` is an escape hatch for
 * endpoints that will not accept it.
 *
 * Not every Anthropic-compatible endpoint is Claude. Kimi's, for one, enables
 * extended thinking unconditionally — `thinking: {type:'disabled'}` is refused
 * with "only type=enabled is allowed for this model" — and its API rejects
 * thinking alongside a required tool choice. Forced tool use there is not a
 * preference the caller can express; the request simply 400s, and discovery
 * stops on `model_gave_up` before it has taken a single step.
 *
 * Relaxing to `auto` costs less than it looks like it should, because the loop
 * already treats a prose reply as a recoverable turn: `decide` returns the
 * "every turn must be exactly one tool call" feedback and the model gets
 * another go, against the step budget. So `any` buys determinism-of-shape from
 * a model that honours it, and `auto` buys a run at all from one that cannot.
 */
export type ToolChoiceMode = 'any' | 'auto';

export const DEFAULT_TOOL_CHOICE: ToolChoiceMode = 'any';

export function parseToolChoice(raw: string | undefined): ToolChoiceMode {
  if (raw === undefined || raw === '') return DEFAULT_TOOL_CHOICE;
  if (raw === 'any' || raw === 'auto') return raw;
  throw new Error(`${ENV.toolChoice} must be 'any' or 'auto', not '${raw}'`);
}

export interface AnthropicModelOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly toolChoice?: ToolChoiceMode;
}

export class AnthropicDecisionModel implements DecisionModel {
  readonly id: string;
  readonly #client: Anthropic;
  readonly #maxTokens: number;
  readonly #toolChoice: ToolChoiceMode;

  constructor(options: AnthropicModelOptions) {
    this.id = options.model ?? DEFAULT_MODEL;
    this.#maxTokens = options.maxTokens ?? 1024;
    this.#toolChoice = options.toolChoice ?? DEFAULT_TOOL_CHOICE;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
    });
  }

  /** Reads `CUA_LLM_*`; returns null rather than throwing when unconfigured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicDecisionModel | null {
    const apiKey = env[ENV.apiKey];
    if (!apiKey) return null;
    const model = env[ENV.model];
    const baseUrl = env[ENV.baseUrl];
    return new AnthropicDecisionModel({
      apiKey,
      ...(model === undefined ? {} : { model }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      // Throws on a typo rather than silently forcing tools at an endpoint that
      // will reject the request: the failure would otherwise surface fourteen
      // steps later as `model_gave_up`.
      toolChoice: parseToolChoice(env[ENV.toolChoice]),
    });
  }

  async decide(system: string, user: string): Promise<ModelReply> {
    let response: Anthropic.Message;
    try {
      response = await this.#client.messages.create({
        model: this.id,
        max_tokens: this.#maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        tools: toolsWithRationale() as unknown as Anthropic.Tool[],
        // Forced tool use by default, and temperature 0. Prose is not an action,
        // and a turn spent explaining what it would like to do is a turn off the
        // step budget. Determinism is not achievable here, but reducing the
        // sampling variance makes a rerun of the same discovery meaningfully
        // comparable. See `ToolChoiceMode` for when this has to relax to 'auto'.
        tool_choice: { type: this.#toolChoice },
        temperature: 0,
      });
    } catch (cause) {
      // A transport failure is reported, never thrown: the loop decides whether
      // it is worth another step, and a run that dies mid-flight leaves a live
      // browser session and half an evidence directory behind.
      return { call: null, error: `model call failed: ${messageOf(cause)}`, tokensIn: 0, tokensOut: 0 };
    }

    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;

    const use = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!use) {
      return {
        call: null,
        error: 'you replied with prose; every turn must be exactly one tool call',
        tokensIn,
        tokensOut,
      };
    }

    const parsed = parseCall(use.name, use.input);
    return parsed.ok
      ? { call: parsed.call, error: null, tokensIn, tokensOut }
      : { call: null, error: parsed.error, tokensIn, tokensOut };
  }
}

// -----------------------------------------------------------------------------
// The test one
// -----------------------------------------------------------------------------

/**
 * Answers from a script, optionally reading the prompt to decide.
 *
 * The function form is what makes the loop's error paths testable: a step can
 * assert that the prompt it was given actually contains the policy denial, and
 * only then choose a different action — which is the behaviour we care about,
 * rather than merely that the loop did not crash.
 */
export type ScriptedStep = ParsedCall | ((user: string) => ParsedCall | ModelReply);

export class ScriptedDecisionModel implements DecisionModel {
  readonly id = 'scripted';
  readonly #steps: readonly ScriptedStep[];
  #at = 0;

  /** Every prompt this model was shown, in order. Asserted against in tests. */
  readonly prompts: string[] = [];

  constructor(steps: readonly ScriptedStep[]) {
    this.#steps = steps;
  }

  get consumed(): number {
    return this.#at;
  }

  async decide(_system: string, user: string): Promise<ModelReply> {
    this.prompts.push(user);
    const step = this.#steps[this.#at++];
    if (step === undefined) {
      return { call: null, error: 'the script ran out of steps', tokensIn: 0, tokensOut: 0 };
    }

    const produced = typeof step === 'function' ? step(user) : step;
    if ('call' in produced || 'error' in produced) return produced as ModelReply;
    return { call: produced as ParsedCall, error: null, tokensIn: 0, tokensOut: 0 };
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
