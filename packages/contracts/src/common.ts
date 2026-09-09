import { z } from 'zod';

/**
 * Version of the *capability artifact format* itself — not of any individual
 * capability. Bumping this is a breaking change for every stored artifact and
 * requires a migration in whatever implements `CapabilityStore` — here, the
 * file-backed store in `packages/replay`.
 */
export const SCHEMA_VERSION = '1.0.0' as const;

/**
 * Fraction of a capability's steps a tenant may override before we stop calling
 * it "the same flow with tweaks". Past this, the tenant has diverged enough that
 * patching the baseline is a fiction and it deserves its own recording.
 *
 * 0.3 is a judgement call, not a measurement: with a five-step flow it means two
 * overridden steps is fine and three is a warning. It is configurable per
 * deployment; the value matters less than having the signal at all.
 */
export const DRIFT_REBASELINE_THRESHOLD = 0.3;

export const semVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be semver MAJOR.MINOR.PATCH');

export const isoTimestamp = z.string().datetime({ offset: true });

/**
 * Dotted, lowercase capability identifier, e.g. `member.read_savings_balance`.
 *
 * Deliberately namespaced: a calling agent sees a flat catalogue of these, so the
 * first segment carries the domain and keeps names from colliding across apps.
 */
export const capabilityId = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/,
    'must be dot-separated lowercase segments, e.g. member.read_savings_balance',
  );

export const tenantId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase slug');

export const stepId = z.string().regex(/^s\d+$/, 'must look like s1, s2, …');

export const checkpointId = z
  .string()
  .regex(/^chk\.[a-z0-9_]+$/, 'must look like chk.on_detail');

/**
 * Business outcome codes are SCREAMING_SNAKE because they cross the wire to the
 * calling agent and end up in its prompts. They are part of the public contract
 * and may not be renamed without a major version bump.
 */
export const outcomeCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be SCREAMING_SNAKE_CASE');

/**
 * Data-classification tag. Drives redaction (I3) and decides whether a value may
 * ever appear as a literal inside an artifact.
 *
 * - `none`       — safe to persist and to show the model
 * - `identifier` — account/member numbers: persist redacted, may be passed as a param
 * - `pii`        — names, addresses, DOB
 * - `financial`  — balances, transaction amounts, card numbers
 * - `secret`     — credentials and tokens: never persisted anywhere, env only
 */
export const sensitivity = z.enum([
  'none',
  'identifier',
  'pii',
  'financial',
  'secret',
]);

/**
 * Why a run stopped and asked for a human.
 *
 * Lives here rather than in `replay.ts` because both phases raise it: discovery
 * gets stuck too, and the handoff layer must not have to depend on the replay
 * engine to describe why it was called.
 */
export const stuckReason = z.enum([
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
]);

/**
 * A reference into the capability's own input or output document, e.g.
 * `$.inputs.memberId`. Steps never embed caller data directly; they point at it,
 * so the same artifact serves every invocation (and so PII never lands in the file).
 */
export const valueRef = z
  .string()
  .regex(
    /^\$\.(inputs|outputs)\.[A-Za-z_][A-Za-z0-9_]*$/,
    'must look like $.inputs.memberId or $.outputs.savingsBalance',
  );

export const inputRef = z
  .string()
  .regex(/^\$\.inputs\.[A-Za-z_][A-Za-z0-9_]*$/);

export const outputRef = z
  .string()
  .regex(/^\$\.outputs\.[A-Za-z_][A-Za-z0-9_]*$/);

/** `$.inputs.memberId` → `memberId`. */
export function refProperty(ref: string): string {
  const dot = ref.lastIndexOf('.');
  return dot === -1 ? ref : ref.slice(dot + 1);
}

/**
 * Heuristic classifier used where the full redactor is unavailable — notably in
 * schema validation, which must stay synchronous and dependency-free.
 *
 * Deliberately conservative and deliberately dumb: it exists to stop an obvious
 * account number from being frozen into an artifact, not to be the redaction
 * pipeline. `packages/redact` is the real one, and it is the one that guards the
 * three sinks in I3.
 */
export function looksSensitive(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // Currency amounts.
  if (/^[$€£]\s?[\d,]+(\.\d{2})?$/.test(v)) return true;
  // Runs of digits long enough to be an account, card, or government id.
  if (/^\d[\d\s-]{3,}$/.test(v)) return true;
  // Email addresses.
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return true;
  // Anything that reads like a secret.
  if (/(password|passwd|secret|token|api[_-]?key|bearer)/i.test(v)) return true;
  return false;
}

/**
 * A JSON Schema document, stored verbatim as data.
 *
 * D6: we deliberately do NOT model the caller-facing contract with zod. The
 * artifact must be consumable by any agent runtime as a tool definition, so the
 * `inputs`/`outputs` fields hold literal JSON Schema. zod validates the envelope
 * around them; the schema documents themselves stay library-agnostic.
 *
 * This is the one place `passthrough` is correct — JSON Schema has an open
 * keyword set and we must not silently drop `pattern`, `enum`, `format`, …
 */
export const jsonSchemaObject = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

/** Pointer to a persisted run directory under `evidence/`. */
export const runRef = z
  .object({
    runId: z.string().min(1),
    /** Repo-relative directory, e.g. `evidence/replay-2026-09-09T10-22-03Z`. */
    path: z.string().min(1),
  })
  .strict();

export type SemVer = z.infer<typeof semVer>;
export type IsoTimestamp = z.infer<typeof isoTimestamp>;
export type CapabilityId = z.infer<typeof capabilityId>;
export type TenantId = z.infer<typeof tenantId>;
export type StepId = z.infer<typeof stepId>;
export type CheckpointId = z.infer<typeof checkpointId>;
export type OutcomeCode = z.infer<typeof outcomeCode>;
export type Sensitivity = z.infer<typeof sensitivity>;
export type StuckReason = z.infer<typeof stuckReason>;
export type ValueRef = z.infer<typeof valueRef>;
export type JsonSchemaObject = z.infer<typeof jsonSchemaObject>;
export type RunRef = z.infer<typeof runRef>;
