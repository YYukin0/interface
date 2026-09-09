import { z } from 'zod';
import {
  SCHEMA_VERSION,
  capabilityId,
  checkpointId,
  isoTimestamp,
  jsonSchemaObject,
  looksSensitive,
  outcomeCode,
  refProperty,
  semVer,
  sensitivity,
  stepId,
  tenantId,
} from './common.js';
import { action, checkpoint, surfaceKind, target } from './surface.js';
import type { ActionType } from './surface.js';

/**
 * =============================================================================
 * THE CAPABILITY ARTIFACT
 * =============================================================================
 * This is the product of the system. Everything else exists to produce it or to
 * execute it.
 *
 * It is simultaneously three things, and the shape below is a compromise between
 * all three — which is the point:
 *   1. a TOOL CONTRACT a calling agent can discover and invoke by name;
 *   2. a REVIEWABLE DOCUMENT a human approves before it runs unattended;
 *   3. an EXECUTABLE PLAN the deterministic replay engine runs.
 *
 * Prior art we read the source of, and what we took or refused:
 *   - browser-use/workflow-use — took: ordered selector bundles, text-based
 *     disambiguation hints, per-step verification. Refused: `extra: 'allow'`
 *     (leaks recorder internals into the artifact, violating I5), a flat
 *     `input_schema` with three scalar types and no outputs, and the validator
 *     forcing every workflow to end in an AI `extract` step.
 *   - Skyvern code-caching — took: the explore→replay split and per-block
 *     caching. Refused: caching *generated code*, which cannot be reviewed,
 *     diffed across tenants, or type-checked against a caller.
 *   - Stagehand — took: cache the resolved selector plus enough metadata to
 *     re-validate before use; never cache secrets.
 *   - MCP tool definitions — took: name / description / inputSchema /
 *     outputSchema as the discovery contract.
 */

export const riskClass = z.enum([
  /** Read-only or trivially undone: navigate, read, type into a field. */
  'safe',
  /** Changes state but is correctable by a human: submit a form, save a draft. */
  'mutating',
  /** No undo: transfer funds, delete a record, send a notice to a member. */
  'irreversible',
]);

/**
 * Conditions replay may recover from on its own. This list is closed on purpose:
 * anything not enumerated here is a hard failure, because "try something" is how
 * automation ends up in a state nobody can reconstruct.
 */
export const recoverableCondition = z.enum([
  'transient_load',
  'unexpected_dialog',
  'stale_element',
  'session_expired',
  'navigation_lost',
]);

export const recoveryAction = z.enum([
  'wait_retry',
  'dismiss_dialog',
  'scroll_into_view',
  'reload_and_resume',
  'reauthenticate',
]);

export const recoveryRule = z
  .object({
    on: recoverableCondition,
    do: recoveryAction,
    maxAttempts: z.number().int().min(1).max(5).default(2),
  })
  .strict();

/** Actions that act on a specific control and are meaningless without one. */
export const ACTIONS_REQUIRING_TARGET = [
  'click',
  'double_click',
  'type',
  'select',
  'set_checked',
  'scroll_into_view',
  'extract',
] as const satisfies readonly ActionType[];

/** Actions that address the page or the session, never an element. */
export const ACTIONS_FORBIDDING_TARGET = [
  'navigate',
  'dismiss_dialog',
] as const satisfies readonly ActionType[];

/**
 * One step of the flow.
 *
 * `intent` is prose and `target` is machine detail, on purpose: a reviewer should
 * be able to approve a capability by reading the intents top to bottom without
 * ever looking at an XPath.
 */
export const step = z
  .object({
    id: stepId,
    /** Human-readable purpose, e.g. "Open the member search screen". */
    intent: z.string().min(3).max(200),
    action,
    /** Null for actions that need no element (`navigate`, `dismiss_dialog`). */
    target: target.nullable().default(null),
    /**
     * Risk is per-step, not per-capability: a lookup flow is typically four safe
     * steps followed by one mutating submit, and blocking the whole capability
     * because of its last step would be useless.
     */
    risk: riskClass,
    /** Assert we actually arrived. Also the resume point after a handoff (I7). */
    checkpoint: checkpoint.nullable().default(null),
    recover: z.array(recoveryRule).default([]),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
    /** If true, a failure here is logged and skipped instead of stopping the run. */
    optional: z.boolean().default(false),
  })
  .strict()
  .superRefine((s, ctx) => {
    const needsTarget = (ACTIONS_REQUIRING_TARGET as readonly string[]).includes(s.action.type);
    const forbidsTarget = (ACTIONS_FORBIDDING_TARGET as readonly string[]).includes(s.action.type);

    if (needsTarget && s.target === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: `action '${s.action.type}' requires a target`,
      });
    }
    if (forbidsTarget && s.target !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: `action '${s.action.type}' does not act on an element; target must be null`,
      });
    }

    // I3, enforced structurally rather than by review: caller data must arrive
    // as a parameter. A literal that looks like an account number, an amount, or
    // a credential is almost always a discovery run that was never generalised,
    // and it would freeze real data into a file that gets committed.
    if (
      (s.action.type === 'type' || s.action.type === 'select') &&
      s.action.value.from === 'literal' &&
      looksSensitive(s.action.value.value)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'value', 'value'],
        message:
          'literal looks like sensitive data; promote it to an input parameter ' +
          '($.inputs.*) so it never lands in the artifact',
      });
    }

    // An irreversible step with no checkpoint cannot be verified after the fact,
    // and there is no undo. Refuse to record one.
    if (s.risk === 'irreversible' && s.checkpoint === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkpoint'],
        message: 'irreversible steps must declare a checkpoint',
      });
    }

    // `optional` means "skip on failure". Combined with a mutating action that
    // is a silent partial write — the caller gets success having done half the job.
    if (s.optional && s.risk !== 'safe') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optional'],
        message: `only 'safe' steps may be optional; '${s.risk}' steps must not be skippable`,
      });
    }
  });

/**
 * A legitimate business result, NOT an error (I2).
 *
 * "No such member" is an answer the caller asked for. The brief's glossary calls
 * conflating this with failure the most common design mistake in this problem,
 * so outcomes are first-class in the schema rather than a convention in code:
 * they are declared up front, detected by the same checkpoint machinery as
 * success, and surfaced through a distinct arm of the result union.
 */
export const businessOutcome = z
  .object({
    code: outcomeCode,
    /** Shown to the calling agent; it may be put in a prompt, so keep it plain. */
    description: z.string().min(3),
    /** Detected with the ordinary checkpoint machinery — no special-casing. */
    detect: checkpoint,
    /** Whether the caller might succeed by retrying with different inputs. */
    retryable: z.boolean().default(false),
  })
  .strict();

export const successCondition = z
  .object({
    /** Checkpoints that must all have passed. */
    checkpoints: z.array(checkpointId).default([]),
    /** Output property names that must be non-null. */
    requiredOutputs: z.array(z.string()).default([]),
  })
  .strict();

/**
 * What this capability is bound to.
 *
 * `app` names the *vendor product*, not the tenant. That is the whole basis of
 * cross-tenant reuse: hundreds of institutions run the same core-banking product
 * with different branding, so the baseline artifact belongs to the product and
 * each tenant contributes only a sparse override.
 */
export const surfaceBinding = z
  .object({
    kind: surfaceKind,
    app: z.string().min(1),
    appVersion: z.string().nullable().default(null),
    /** Relative entry path; the concrete origin comes from tenant config, not here. */
    entryPoint: z.string().min(1),
  })
  .strict();

export const provenance = z
  .object({
    discoveredBy: z.string().min(1),
    discoveredAt: isoTimestamp,
    /**
     * I5: a pointer, never the transcript itself. The artifact stays reviewable
     * and free of whatever the model happened to see.
     */
    traceRef: z.string().min(1),
    compilerVersion: semVer,
    humanEdits: z
      .array(
        z
          .object({ at: isoTimestamp, by: z.string(), note: z.string() })
          .strict(),
      )
      .default([]),
  })
  .strict();

/**
 * Gate for unattended execution. `draft` capabilities may be replayed manually
 * but never invoked by an agent without a human in the loop.
 */
export const approval = z
  .object({
    state: z.enum(['draft', 'review', 'approved', 'deprecated']),
    by: z.string().nullable().default(null),
    at: isoTimestamp.nullable().default(null),
    /** Successful replays / total replays. Feeds the approval decision. */
    observedStability: z.number().min(0).max(1).nullable().default(null),
  })
  .strict();

/**
 * A tenant's sparse patch over the baseline.
 *
 * Sparse, not a copy: if tenant B moved one button, tenant B stores one step
 * override. Two properties follow that we care about more than the storage
 * saving — a baseline fix reaches every tenant automatically, and the *size* of
 * a tenant's override set is a direct drift signal. When it crosses a threshold,
 * that tenant has diverged enough to deserve its own baseline recording.
 */
export const capabilityOverride = z
  .object({
    note: z.string().nullable().default(null),
    entryPoint: z.string().nullable().default(null),
    steps: z
      .record(
        stepId,
        z
          .object({
            target: target.nullable().default(null),
            timeoutMs: z.number().int().positive().nullable().default(null),
            skip: z.boolean().default(false),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

const capabilityBase = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: capabilityId,
    /** Version of this capability. Breaking the input/output contract is a major. */
    version: semVer,

    // ---- the tool contract a calling agent sees -----------------------------
    displayName: z.string().min(3),
    /**
     * Goes into the calling agent's prompt, so it must say what the capability
     * does AND when to use it — the same standard MCP tool descriptions are held
     * to. This is prompt context, not a code comment.
     */
    description: z.string().min(10),
    inputs: jsonSchemaObject,
    outputs: jsonSchemaObject,
    /**
     * Data classification per input/output property name. Drives redaction (I3)
     * and decides whether a value may be inlined as a literal in a step.
     */
    sensitivity: z.record(z.string(), sensitivity).default({}),
    businessOutcomes: z.array(businessOutcome).default([]),

    // ---- the executable plan ------------------------------------------------
    surface: surfaceBinding,
    steps: z.array(step).min(1),
    successCondition,

    // ---- governance ---------------------------------------------------------
    provenance,
    approval,
    tenantOverrides: z.record(tenantId, capabilityOverride).default({}),
  })
  .strict(); // I5: unknown keys are rejected, so recorder internals cannot leak in.

/**
 * The capability, with its cross-field rules enforced.
 *
 * These checks live in the schema rather than in a linter script on purpose.
 * A rule that only runs when someone remembers to run it is documentation, not a
 * constraint — and every one of these describes a way a capability can be
 * internally inconsistent while every individual field is valid. That class of
 * bug is invisible in review and shows up as a mystifying replay failure.
 */
export const capability = capabilityBase.superRefine((c, ctx) => {
  const at = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  // ---- identifiers are unique -------------------------------------------
  const seenSteps = new Set<string>();
  c.steps.forEach((s, i) => {
    if (seenSteps.has(s.id)) at(['steps', i, 'id'], `duplicate step id '${s.id}'`);
    seenSteps.add(s.id);
  });

  const checkpoints = new Map<string, string>();
  c.steps.forEach((s, i) => {
    if (!s.checkpoint) return;
    if (checkpoints.has(s.checkpoint.id)) {
      at(['steps', i, 'checkpoint', 'id'], `duplicate checkpoint id '${s.checkpoint.id}'`);
    }
    checkpoints.set(s.checkpoint.id, s.id);
  });
  c.businessOutcomes.forEach((o, i) => {
    if (checkpoints.has(o.detect.id)) {
      at(['businessOutcomes', i, 'detect', 'id'], `duplicate checkpoint id '${o.detect.id}'`);
    }
    checkpoints.set(o.detect.id, `outcome:${o.code}`);
  });

  const seenOutcomes = new Set<string>();
  c.businessOutcomes.forEach((o, i) => {
    if (seenOutcomes.has(o.code)) at(['businessOutcomes', i, 'code'], `duplicate outcome '${o.code}'`);
    seenOutcomes.add(o.code);
  });

  // ---- declared inputs and outputs are the only ones referenced ----------
  const declaredInputs = new Set(Object.keys(c.inputs.properties ?? {}));
  const declaredOutputs = new Set(Object.keys(c.outputs.properties ?? {}));

  c.steps.forEach((s, i) => {
    const a = s.action;
    if ((a.type === 'type' || a.type === 'select') && a.value.from === 'input') {
      const prop = refProperty(a.value.ref);
      if (!declaredInputs.has(prop)) {
        at(['steps', i, 'action', 'value', 'ref'], `'${prop}' is not a declared input`);
      }
    }
    if (a.type === 'extract') {
      const prop = refProperty(a.into);
      if (!declaredOutputs.has(prop)) {
        at(['steps', i, 'action', 'into'], `'${prop}' is not a declared output`);
      }
    }
  });

  // Every declared output must actually be produced, or the contract is a lie:
  // a caller reading the schema would expect a value nothing ever writes.
  const written = new Set(
    c.steps.flatMap((s) => (s.action.type === 'extract' ? [refProperty(s.action.into)] : [])),
  );
  for (const name of declaredOutputs) {
    if (!written.has(name)) {
      at(['outputs', 'properties', name], `declared output '${name}' is never extracted by any step`);
    }
  }

  // ---- the success condition must be checkable ---------------------------
  c.successCondition.checkpoints.forEach((id, i) => {
    if (!checkpoints.has(id)) {
      at(['successCondition', 'checkpoints', i], `unknown checkpoint '${id}'`);
    }
  });
  c.successCondition.requiredOutputs.forEach((name, i) => {
    if (!declaredOutputs.has(name)) {
      at(['successCondition', 'requiredOutputs', i], `'${name}' is not a declared output`);
    }
  });
  if (
    c.successCondition.checkpoints.length === 0 &&
    c.successCondition.requiredOutputs.length === 0
  ) {
    at(
      ['successCondition'],
      'a capability with no success condition cannot verify it did anything; ' +
        'declare at least one checkpoint or required output',
    );
  }

  // ---- classification covers what crosses the boundary -------------------
  for (const name of [...declaredInputs, ...declaredOutputs]) {
    if (!(name in c.sensitivity)) {
      at(
        ['sensitivity', name],
        `'${name}' has no data classification; every input and output must be ` +
          `classified so the redactor knows how to treat it`,
      );
    }
  }
  // A `secret` may never be a capability parameter: credentials come from the
  // environment, never from a caller and never through an artifact (I3).
  for (const [name, tag] of Object.entries(c.sensitivity)) {
    if (tag === 'secret') {
      at(['sensitivity', name], `'${name}' is classified 'secret' and must not be a capability parameter`);
    }
  }

  // ---- approval implies reviewability ------------------------------------
  if (c.approval.state === 'approved' && c.approval.by === null) {
    at(['approval', 'by'], 'an approved capability must record who approved it');
  }

  // ---- tenant overrides patch things that exist --------------------------
  for (const [tenant, override] of Object.entries(c.tenantOverrides)) {
    for (const id of Object.keys(override.steps)) {
      if (!seenSteps.has(id)) {
        at(['tenantOverrides', tenant, 'steps', id], `overrides unknown step '${id}'`);
      }
    }
  }
});

export type RiskClass = z.infer<typeof riskClass>;
export type RecoverableCondition = z.infer<typeof recoverableCondition>;
export type RecoveryAction = z.infer<typeof recoveryAction>;
export type RecoveryRule = z.infer<typeof recoveryRule>;
export type Step = z.infer<typeof step>;
export type BusinessOutcome = z.infer<typeof businessOutcome>;
export type SuccessCondition = z.infer<typeof successCondition>;
export type SurfaceBinding = z.infer<typeof surfaceBinding>;
export type Provenance = z.infer<typeof provenance>;
export type Approval = z.infer<typeof approval>;
export type CapabilityOverride = z.infer<typeof capabilityOverride>;
export type Capability = z.infer<typeof capability>;

/** The unrefined object schema. Use it only to derive variants; parse with `capability`. */
export { capabilityBase };
