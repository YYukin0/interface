import { z } from 'zod';
import {
  capabilityId,
  checkpointId,
  isoTimestamp,
  outcomeCode,
  runRef,
  semVer,
  stepId,
  stuckReason,
  tenantId,
} from './common.js';
import { recoverableCondition, recoveryAction } from './capability.js';
import { resolutionStatus } from './surface.js';

/**
 * =============================================================================
 * THE REPLAY CONTRACT
 * =============================================================================
 * This is what an AI agent gets back when it invokes a capability in production.
 *
 * The central design commitment is the four-arm result union. The brief demands
 * that expected business outcomes, recoverable conditions, and hard failures be
 * distinguished; we encode that in the *type*, not in a convention, so a caller
 * physically cannot read `outputs` off a failure or treat "no such member" as a
 * crash (I2).
 *
 * Recoverable conditions deliberately do NOT get an arm of their own: by
 * definition they were recovered from, so they belong in the step record as
 * evidence, not in the caller's result. A condition that could not be recovered
 * from is a failure or an escalation.
 */

/**
 * Hard failures. Exhaustive and closed — `switch` over this without a `default`
 * so that adding a class breaks the build everywhere it must be handled.
 */
export const failureClass = z.enum([
  /** A checkpoint did not hold: we did not arrive where the artifact promised. */
  'CHECKPOINT_FAILED',
  /** No locator candidate resolved. The control is gone or renamed. */
  'LOCATOR_UNRESOLVED',
  /**
   * Candidates resolved to different elements. Worse than unresolved: acting on
   * the winner risks acting on the wrong control, so we never guess.
   */
  'LOCATOR_DISAGREEMENT',
  /** Candidates resolved to several elements and hints could not disambiguate. */
  'LOCATOR_AMBIGUOUS',
  /** The policy engine denied the action (I4). */
  'POLICY_DENIED',
  /** A step exceeded its budget after exhausting its recovery rules. */
  'STEP_TIMEOUT',
  /** The driver or the application itself errored (5xx, crash, navigation lost). */
  'SURFACE_ERROR',
  /** Supplied parameters did not validate against the capability's input schema. */
  'INPUT_INVALID',
  /** We reached the right screen but could not coerce a declared output. */
  'OUTPUT_EXTRACTION_FAILED',
  /** Session died and re-authentication was unavailable or also failed. */
  'SESSION_UNRECOVERABLE',
  /** A bug in this system. Never used for anything the target app did. */
  'INTERNAL_ERROR',
]);

/** What a recovery rule actually did, kept as evidence on the step record. */
export const recoveryAttempt = z
  .object({
    condition: recoverableCondition,
    took: recoveryAction,
    attempt: z.number().int().min(1),
    succeeded: z.boolean(),
  })
  .strict();

export const stepRecord = z
  .object({
    stepId,
    intent: z.string(),
    startedAt: isoTimestamp,
    durationMs: z.number().int().min(0),
    resolution: resolutionStatus.nullable(),
    /** Which locator strategy won, for stability analysis across runs. */
    matchedBy: z.string().nullable(),
    /** Agreement across candidates; a downward trend predicts coming drift. */
    agreement: z.number().min(0).max(1).nullable(),
    checkpointPassed: z.boolean().nullable(),
    recoveries: z.array(recoveryAttempt).default([]),
    status: z.enum(['ok', 'skipped', 'failed']),
    screenshotRef: z.string().nullable().default(null),
  })
  .strict();

export const replayStats = z
  .object({
    startedAt: isoTimestamp,
    durationMs: z.number().int().min(0),
    stepsExecuted: z.number().int().min(0),
    stepsTotal: z.number().int().min(0),
    recoveriesPerformed: z.number().int().min(0),
    /**
     * Always 0. Asserted in tests as a machine-checkable statement of I1: the
     * production path does not consult a model. The field exists so the claim
     * appears in every piece of evidence rather than only in prose.
     */
    llmCalls: z.literal(0),
  })
  .strict();

export const failureDetail = z
  .object({
    class: failureClass,
    stepId: stepId.nullable(),
    /** What the artifact said should be true. */
    expected: z.string(),
    /** What was actually observed. Redacted before it is written (I3). */
    observed: z.string(),
    /** Free-form debugging detail, redacted. */
    detail: z.string().nullable().default(null),
  })
  .strict();

const resultBase = {
  capabilityId,
  capabilityVersion: semVer,
  tenant: tenantId.nullable(),
  evidence: runRef,
  stats: replayStats,
  steps: z.array(stepRecord),
};

export const replayResult = z.discriminatedUnion('kind', [
  /** The capability did what it promised. `outputs` conforms to its output schema. */
  z.object({ kind: z.literal('success'), ...resultBase, outputs: z.record(z.string(), z.unknown()) }).strict(),

  /**
   * A declared business outcome. This is a SUCCESSFUL INVOCATION (I2) — the
   * caller asked a question and got a real answer. `outputs` may be partially
   * populated with whatever was legitimately readable.
   */
  z
    .object({
      kind: z.literal('outcome'),
      ...resultBase,
      code: outcomeCode,
      message: z.string(),
      retryable: z.boolean(),
      outputs: z.record(z.string(), z.unknown()),
    })
    .strict(),

  /** A hard failure. No outputs, by construction. */
  z.object({ kind: z.literal('failure'), ...resultBase, failure: failureDetail }).strict(),

  /**
   * Suspended awaiting a human.
   *
   * The brief names three categories; this is a deliberate fourth. A run that has
   * paused with its session alive is none of the three — reporting it as failure
   * would be wrong (nothing is broken and it may still succeed) and reporting it
   * as an outcome would be a lie. The caller needs to know it holds a promise,
   * not a result, so escalation gets its own arm and carries the intervention id
   * to poll.
   */
  z
    .object({
      kind: z.literal('escalated'),
      ...resultBase,
      interventionId: z.string().min(1),
      reason: stuckReason,
      /** Where the run will pick up once control returns (I7). */
      resumeFrom: checkpointId.nullable(),
    })
    .strict(),
]);

/** Inputs to one invocation. Validated against the capability's input schema. */
export const replayRequest = z
  .object({
    capabilityId,
    /** Exact version, or null to take the newest approved one. */
    version: semVer.nullable().default(null),
    tenant: tenantId.nullable().default(null),
    params: z.record(z.string(), z.unknown()),
    /**
     * Refuse to run anything not `approved`. Agents set this; humans testing a
     * draft may clear it.
     */
    requireApproved: z.boolean().default(true),
    /** Whole-run budget, independent of per-step timeouts. */
    deadlineMs: z.number().int().positive().max(600_000).default(120_000),
  })
  .strict();

/**
 * The production execution path.
 *
 * I1: implementations of this interface live in `packages/replay`, which must not
 * depend on any model SDK. That is enforced by a dependency check in CI rather
 * than by convention — determinism guaranteed by discipline is not guaranteed.
 */
export interface ReplayEngine {
  run(request: ReplayRequest): Promise<ReplayResult>;
}

export type FailureClass = z.infer<typeof failureClass>;
export type RecoveryAttempt = z.infer<typeof recoveryAttempt>;
export type StepRecord = z.infer<typeof stepRecord>;
export type ReplayStats = z.infer<typeof replayStats>;
export type FailureDetail = z.infer<typeof failureDetail>;
export type ReplayResult = z.infer<typeof replayResult>;
export type ReplayRequest = z.infer<typeof replayRequest>;
