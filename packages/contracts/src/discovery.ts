import { z } from 'zod';
import {
  capabilityId,
  isoTimestamp,
  runRef,
  sensitivity,
  stuckReason,
  tenantId,
  valueRef,
} from './common.js';
import { extractAs, surfaceKind, target } from './surface.js';
import { capability, riskClass } from './capability.js';

/**
 * =============================================================================
 * DISCOVERY
 * =============================================================================
 * The expensive, non-deterministic half. Runs once per capability.
 *
 * The critical distinction from replay, and the reason this file exists
 * separately: **the model works in refs, the artifact works in locator bundles.**
 *
 * A `ref` (`e17`) is an opaque handle valid only inside the observation that
 * produced it. The model never sees or invents a selector — it points at a node
 * in the tree it was shown. The compiler is what converts "the model clicked
 * e17" into "here are four ways to find that control again, ordered by
 * durability". Keeping the model out of the selector business is what stops it
 * hallucinating an XPath that happens to match today.
 */

/**
 * A parameter the run may use, declared without its value.
 *
 * This is the mechanism that keeps raw data away from the model. The prompt
 * shows the model that a `memberId` exists and what shape it has; the actual
 * digits are handed to `DiscoveryRunner.run` separately and substituted inside
 * the driver. The model asks to type `$.inputs.memberId` and never learns what
 * that is.
 *
 * The safety argument is the obvious one (I3: raw PII never reaches the model),
 * but the engineering argument is at least as strong. The design this replaced
 * had the compiler infer which typed literals were really parameters — an
 * inference that is wrong whenever a member id happens to look like a date
 * filter, and wrong silently. Declaring
 * inputs up front replaces that guess with a fact, and a step compiled from
 * `$.inputs.memberId` is parameterised because it was *recorded* that way.
 */
export const discoveryInput = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'must be a plain identifier'),
    /** Shown to the model, so it must describe the shape without giving a value. */
    description: z.string().min(3),
    classification: sensitivity,
  })
  .strict();

export const discoveryRequest = z
  .object({
    goal: z.string().min(5),
    /** Concrete entry point for this run, e.g. `http://localhost:8080/admin/index.htm`. */
    entryUrl: z.string().min(1),
    surface: surfaceKind,
    /** Vendor product this run is teaching us about; becomes `surface.app`. */
    app: z.string().min(1),
    tenant: tenantId.nullable().default(null),
    /** Proposed id for the resulting capability; the compiler may refine it. */
    proposedId: capabilityId.nullable().default(null),
    /** Parameters this run may reference. Values are supplied out of band. */
    inputs: z.array(discoveryInput).default([]),
    maxSteps: z.number().int().positive().max(100).default(25),
    deadlineMs: z.number().int().positive().max(1_800_000).default(300_000),
    model: z.string().min(1),
    /**
     * Whether the run may take `mutating` actions. Defaults to false so that
     * exploring an unfamiliar app cannot, by accident, submit a real form.
     * Irreversible actions are never permitted here regardless (I8).
     */
    allowMutating: z.boolean().default(false),
  })
  .strict();

/**
 * The model's action vocabulary.
 *
 * Note it is NOT the same union as `Action` in surface.ts: this one addresses
 * elements by `ref` and carries the model's intermediate values, while `Action`
 * addresses them by locator bundle and carries parameter references. The
 * compiler translates between them. Fusing the two would drag ephemeral refs
 * into the persisted artifact.
 */
export const agentAction = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('click'), ref: z.string().min(1) }).strict(),
  z.object({ tool: z.literal('double_click'), ref: z.string().min(1) }).strict(),
  z.object({ tool: z.literal('type'), ref: z.string().min(1), text: z.string() }).strict(),
  z.object({ tool: z.literal('select'), ref: z.string().min(1), option: z.string() }).strict(),
  z.object({ tool: z.literal('set_checked'), ref: z.string().min(1), checked: z.boolean() }).strict(),
  z.object({ tool: z.literal('press_key'), key: z.string().min(1) }).strict(),
  z.object({ tool: z.literal('navigate'), url: z.string().min(1) }).strict(),
  z.object({ tool: z.literal('scroll_into_view'), ref: z.string().min(1) }).strict(),
  z
    .object({
      tool: z.literal('extract'),
      ref: z.string().min(1),
      /** Name this value should have in the capability's output schema. */
      name: z.string().min(1),
      as: extractAs,
    })
    .strict(),
  z.object({ tool: z.literal('dismiss_dialog'), accept: z.boolean() }).strict(),
  /**
   * Assert the model believes it has arrived somewhere. These become the
   * capability's checkpoints, which is why we ask for them explicitly rather
   * than inferring every checkpoint after the fact — the model knows what it was
   * looking for, and that intent is not recoverable from a DOM diff.
   */
  z.object({ tool: z.literal('assert'), description: z.string().min(3) }).strict(),
  z.object({ tool: z.literal('done'), summary: z.string().min(3) }).strict(),
  /** The model's own escape hatch; routes straight to a human (I4/§3.6). */
  z
    .object({
      tool: z.literal('stuck'),
      reason: stuckReason,
      explanation: z.string().min(3),
    })
    .strict(),
]);

export const agentDecision = z
  .object({
    /**
     * Why this action, in the model's words. Persisted to the trace: the brief
     * asks the evidence to show what the agent did *and why*, and this is the
     * only place the "why" exists.
     */
    rationale: z.string().min(1),
    action: agentAction,
  })
  .strict();

export const stopReason = z.enum([
  'goal_reached',
  'max_steps',
  'deadline',
  /** No observable state change across several actions; we are going in circles. */
  'dead_end',
  'policy_blocked',
  'escalated',
  'model_gave_up',
  'surface_error',
]);

export const discoveryStats = z
  .object({
    startedAt: isoTimestamp,
    durationMs: z.number().int().min(0),
    stepsTaken: z.number().int().min(0),
    modelCalls: z.number().int().min(0),
    tokensIn: z.number().int().min(0),
    tokensOut: z.number().int().min(0),
    policyDenials: z.number().int().min(0),
  })
  .strict();

export const discoveryResult = z.discriminatedUnion('kind', [
  /**
   * The goal was reached. Note this yields a TRACE, not a capability — compiling
   * is a separate, inspectable step (I5). A discovery run that silently emitted
   * an artifact would make it impossible to see what the compiler decided.
   */
  z
    .object({
      kind: z.literal('completed'),
      summary: z.string(),
      evidence: runRef,
      stats: discoveryStats,
    })
    .strict(),
  z
    .object({
      kind: z.literal('stopped'),
      reason: stopReason,
      detail: z.string(),
      evidence: runRef,
      stats: discoveryStats,
    })
    .strict(),
  z
    .object({
      kind: z.literal('escalated'),
      interventionId: z.string().min(1),
      reason: stuckReason,
      evidence: runRef,
      stats: discoveryStats,
    })
    .strict(),
]);

// -----------------------------------------------------------------------------
// The recording: what the compiler actually reads
// -----------------------------------------------------------------------------

/**
 * A value the model supplied to a control.
 *
 * This union is the mechanism that makes I3 structural rather than procedural.
 * The compiler's job includes turning "the model typed 12345" into "this
 * capability takes a `memberId` parameter" — and to do that it needs the value's
 * *shape*, never the value. So the recorder classifies at capture time and
 * writes one arm or the other:
 *
 *   - `literal` for data classified `none` (an option label, a date filter),
 *     which may legitimately be frozen into the artifact;
 *   - `redacted` for everything else, carrying only what is needed to declare a
 *     parameter — its classification, its length, and an inferred pattern.
 *
 * Because the sensitive arm has nowhere to put a value, a member id cannot
 * reach an artifact even if every later stage is wrong about everything.
 */
export const recordedValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }).strict(),
  z
    .object({
      kind: z.literal('redacted'),
      classification: sensitivity,
      /** e.g. `^[0-9]{5}$`, derived from the shape of what was typed. */
      inferredPattern: z.string().nullable(),
      length: z.number().int().min(0),
      /**
       * The declared parameter this came from, e.g. `$.inputs.memberId`, or null
       * when the model typed a sensitive literal of its own invention.
       *
       * A reference is a name, not a value, so storing it costs nothing — and
       * without it the compiler cannot tell two parameters of the same
       * classification and length apart, which makes a two-parameter capability
       * uncompilable. It is also exactly the distinction behind the warning
       * codes: a `ref` compiles silently, a null gets
       * `sensitive_literal_promoted` and a human's attention.
       */
      ref: valueRef.nullable().default(null),
    })
    .strict(),
]);

/**
 * The action as it goes to disk: the same vocabulary as `agentAction`, minus the
 * payload.
 *
 * `agentAction` has to carry the text the model typed, because the driver needs
 * that string to act. `recordedAction` deliberately has nowhere to put it. The
 * value is carried instead by `RecordedStep.value`, whose sensitive arm stores a
 * length and a pattern rather than a string.
 *
 * Without this split the `recordedValue` union would be decorative: a member id
 * would be masked in one field and sitting in plaintext two fields away, and
 * every reviewer would have to notice that on their own. Enforcing it in the
 * schema means the recording *cannot* be written wrong, rather than being
 * written right by whoever remembers.
 */
export const recordedAction = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('click') }).strict(),
  z.object({ tool: z.literal('double_click') }).strict(),
  z.object({ tool: z.literal('type'), clearFirst: z.boolean().default(true) }).strict(),
  z.object({ tool: z.literal('select') }).strict(),
  z.object({ tool: z.literal('set_checked'), checked: z.boolean() }).strict(),
  z.object({ tool: z.literal('press_key'), key: z.string().min(1) }).strict(),
  z.object({ tool: z.literal('navigate'), url: z.string().min(1) }).strict(),
  z.object({ tool: z.literal('scroll_into_view') }).strict(),
  z
    .object({
      tool: z.literal('extract'),
      name: z.string().min(1),
      as: extractAs,
    })
    .strict(),
  z.object({ tool: z.literal('dismiss_dialog'), accept: z.boolean() }).strict(),
  z.object({ tool: z.literal('assert'), description: z.string().min(3) }).strict(),
]);

/**
 * Strip an `agentAction` down to what may be persisted.
 *
 * Kept next to both schemas so the two cannot drift apart, and total over the
 * vocabulary so a new tool has to declare which side of the line it falls on.
 * `done` and `stuck` return null: they end a run rather than acting on it, and
 * nothing about them belongs in a step list.
 */
export function toRecordedAction(action: AgentAction): RecordedAction | null {
  switch (action.tool) {
    case 'click':
    case 'double_click':
    case 'select':
    case 'scroll_into_view':
      return { tool: action.tool };
    case 'type':
      return { tool: 'type', clearFirst: true };
    case 'set_checked':
      return { tool: 'set_checked', checked: action.checked };
    case 'press_key':
      return { tool: 'press_key', key: action.key };
    case 'navigate':
      return { tool: 'navigate', url: action.url };
    case 'extract':
      return { tool: 'extract', name: action.name, as: action.as };
    case 'dismiss_dialog':
      return { tool: 'dismiss_dialog', accept: action.accept };
    case 'assert':
      return { tool: 'assert', description: action.description };
    case 'done':
    case 'stuck':
      return null;
  }
}

/**
 * One action as it happened, with everything the compiler needs and nothing it
 * does not.
 *
 * The locator bundle is harvested *at the moment of acting*, which is the only
 * moment it can be: the DOM that produced it is gone by the time compilation
 * runs. This is why discovery and compilation can be separate steps at all —
 * the expensive, unrepeatable observation is captured here, and the cheap,
 * re-runnable inference happens later against it.
 */
export const recordedStep = z
  .object({
    index: z.number().int().min(0),
    at: isoTimestamp,
    rationale: z.string(),
    action: recordedAction,
    /** Null for actions that address the page rather than an element. */
    target: target.nullable(),
    value: recordedValue.nullable(),
    /** Inferred from the action and the control, and flagged for review. */
    risk: riskClass,
    locationBefore: z.string(),
    locationAfter: z.string(),
    digestBefore: z.string(),
    digestAfter: z.string(),
    ok: z.boolean(),
    /** Result of an `extract`, already classified and redacted if need be. */
    extracted: recordedValue.nullable(),
    /**
     * Accessible `role:name` pairs that were absent before this action and
     * present after it. The raw material for checkpoint inference: what the
     * screen gained is a far better "did it work" signal than what it lost.
     */
    appeared: z.array(z.string()),
  })
  .strict();

// -----------------------------------------------------------------------------
// Compilation: recording → capability
// -----------------------------------------------------------------------------

/**
 * Things the compiler had to decide for itself. Surfaced rather than buried,
 * because each one is a place a human reviewer should look before approving.
 */
export const compileWarning = z.enum([
  /** A typed literal was turned into an input parameter; confirm the inference. */
  'literal_promoted_to_parameter',
  /** A literal looked sensitive and was promoted whether or not it was a parameter. */
  'sensitive_literal_promoted',
  /** Fewer than two viable locator strategies; this step is fragile. */
  'weak_locator_bundle',
  /** No checkpoint could be inferred; the step proceeds unverified. */
  'no_checkpoint_inferred',
  /** Exploratory detours were dropped from the recorded flow. */
  'noise_filtered',
  /**
   * A parameter was declared for the run but no step referenced it. Dropped from
   * the contract rather than published: an input a caller must supply and nothing
   * consumes is a contract that lies about what it needs.
   */
  'declared_input_unused',
  /** Risk class was inferred, not observed; verify before approving. */
  'risk_inferred',
  /** The run saw no error states, so no business outcomes were declared. */
  'no_business_outcomes_declared',
]);

export const compileResult = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('compiled'),
      capability,
      warnings: z.array(
        z.object({ code: compileWarning, stepId: z.string().nullable(), detail: z.string() }).strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rejected'),
      /** Why no valid capability could be produced from this trace. */
      reasons: z.array(z.string()).min(1),
    })
    .strict(),
]);

/**
 * Runs the model against a live surface. Lives in `packages/discovery`, which is
 * the ONLY package permitted to depend on a model SDK (I1).
 *
 * The values for `request.inputs` arrive here rather than on the request, and
 * that separation is the whole point: `DiscoveryRequest` is a plain data object
 * that gets logged, echoed and serialised, and it has nowhere to put a member
 * id. The map lives only in memory, for the length of one call.
 */
export interface DiscoveryRunner {
  run(request: DiscoveryRequest, values: ReadonlyMap<string, string>): Promise<DiscoveryResult>;
}

/**
 * Turns a completed discovery trace into a reviewable capability.
 *
 * Deliberately a separate step rather than something the loop does inline: the
 * artifact must be decoupled from the raw model transcript (I5), and separating
 * them means the compiler can be re-run and improved against traces already
 * captured, without paying for another discovery run.
 */
export interface CapabilityCompiler {
  compile(evidence: RunRefLike): Promise<CompileResult>;
}

type RunRefLike = z.infer<typeof runRef>;

export type DiscoveryInput = z.infer<typeof discoveryInput>;
export type DiscoveryRequest = z.infer<typeof discoveryRequest>;
export type AgentAction = z.infer<typeof agentAction>;
export type AgentDecision = z.infer<typeof agentDecision>;
export type StopReason = z.infer<typeof stopReason>;
export type DiscoveryStats = z.infer<typeof discoveryStats>;
export type DiscoveryResult = z.infer<typeof discoveryResult>;
export type RecordedValue = z.infer<typeof recordedValue>;
export type RecordedAction = z.infer<typeof recordedAction>;
export type RecordedStep = z.infer<typeof recordedStep>;
export type CompileWarning = z.infer<typeof compileWarning>;
export type CompileResult = z.infer<typeof compileResult>;
