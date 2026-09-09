import { z } from 'zod';
import { capabilityId, isoTimestamp, sensitivity, stepId } from './common.js';
import type { Sensitivity } from './common.js';
import { policyDecision } from './policy.js';
import { stuckReason } from './common.js';
import { failureClass } from './replay.js';
import { actionType, resolutionStatus } from './surface.js';

/**
 * =============================================================================
 * EVIDENCE
 * =============================================================================
 * One run produces one directory:
 *
 *   evidence/<runId>/
 *     manifest.json      RunManifest — what this run was
 *     trace.jsonl        one TraceEvent per line, append-only
 *     result.json        ReplayResult, or the compiled Capability for discovery
 *     screenshots/       PNGs, sensitive regions blacked out before writing
 *     snapshots/         a11y tree dumps at failures
 *     trace.zip          Playwright trace, when the surface is web
 *     intervention.json  present only if a human was involved
 *
 * Everything here has passed the redactor (I3). The trace is the raw record the
 * artifact is deliberately decoupled from (I5): the artifact points at it by
 * path and never inlines it.
 */

export const runKind = z.enum(['discovery', 'replay', 'compile']);

export const runManifest = z
  .object({
    runId: z.string().min(1),
    kind: runKind,
    startedAt: isoTimestamp,
    endedAt: isoTimestamp.nullable().default(null),
    capabilityId: capabilityId.nullable().default(null),
    /** Present for discovery runs. */
    goal: z.string().nullable().default(null),
    target: z.string(),
    /** Null on replay, and asserted so in tests — the machine-checkable form of I1. */
    model: z.string().nullable().default(null),
    schemaVersion: z.string(),
    gitSha: z.string().nullable().default(null),
  })
  .strict();

/**
 * A redaction that happened.
 *
 * The detection/redaction split is borrowed from Presidio and is the single most
 * useful property of this design: we can log that a credit card was found at
 * step 3 with 0.9 confidence, and prove the pipeline is working, without the log
 * itself becoming the leak we were trying to prevent.
 */
export const redactionRecord = z
  .object({
    entity: z.string(),
    classification: sensitivity,
    confidence: z.number().min(0).max(1),
    /** Where it was found: `prompt`, `artifact`, `log`, `screenshot`. */
    sink: z.enum(['prompt', 'artifact', 'log', 'screenshot']),
    count: z.number().int().min(1),
  })
  .strict();

/**
 * The structured log of what happened and why.
 *
 * Discriminated so downstream tooling can `switch` exhaustively rather than
 * string-matching a message field.
 */
export const traceEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('run_started'), at: isoTimestamp, manifest: runManifest }).strict(),

  z
    .object({
      event: z.literal('observed'),
      at: isoTimestamp,
      location: z.string(),
      digest: z.string(),
      nodeCount: z.number().int().min(0),
      truncated: z.boolean(),
      screenshotRef: z.string().nullable(),
    })
    .strict(),

  /**
   * Discovery only: the model's chosen action and its stated reason.
   * `rationale` is the "why" the brief asks the evidence to capture.
   */
  z
    .object({
      event: z.literal('model_decided'),
      at: isoTimestamp,
      stepIndex: z.number().int().min(0),
      action: actionType,
      rationale: z.string(),
      tokensIn: z.number().int().min(0),
      tokensOut: z.number().int().min(0),
    })
    .strict(),

  z
    .object({
      event: z.literal('policy_evaluated'),
      at: isoTimestamp,
      action: actionType,
      decision: policyDecision,
    })
    .strict(),

  z
    .object({
      event: z.literal('resolved'),
      at: isoTimestamp,
      stepId: stepId.nullable(),
      status: resolutionStatus,
      matchedBy: z.string().nullable(),
      agreement: z.number().min(0).max(1),
    })
    .strict(),

  z
    .object({
      event: z.literal('acted'),
      at: isoTimestamp,
      stepId: stepId.nullable(),
      action: actionType,
      ok: z.boolean(),
      durationMs: z.number().int().min(0),
    })
    .strict(),

  z
    .object({
      event: z.literal('checkpoint_evaluated'),
      at: isoTimestamp,
      checkpointId: z.string(),
      passed: z.boolean(),
      expected: z.string(),
      observed: z.string(),
      waitedMs: z.number().int().min(0),
    })
    .strict(),

  z
    .object({
      event: z.literal('recovery_attempted'),
      at: isoTimestamp,
      stepId: stepId.nullable(),
      condition: z.string(),
      took: z.string(),
      attempt: z.number().int().min(1),
      succeeded: z.boolean(),
    })
    .strict(),

  /** A declared business outcome fired. Logged at info, not error (I2). */
  z
    .object({
      event: z.literal('business_outcome'),
      at: isoTimestamp,
      code: z.string(),
      message: z.string(),
    })
    .strict(),

  z
    .object({
      event: z.literal('escalated'),
      at: isoTimestamp,
      interventionId: z.string(),
      reason: stuckReason,
    })
    .strict(),

  z
    .object({
      event: z.literal('control_transferred'),
      at: isoTimestamp,
      from: z.string(),
      to: z.string(),
      reason: z.string(),
    })
    .strict(),

  z.object({ event: z.literal('redacted'), at: isoTimestamp, record: redactionRecord }).strict(),

  z
    .object({
      event: z.literal('failed'),
      at: isoTimestamp,
      class: failureClass,
      stepId: stepId.nullable(),
      expected: z.string(),
      observed: z.string(),
      screenshotRef: z.string().nullable(),
      snapshotRef: z.string().nullable(),
    })
    .strict(),

  z
    .object({
      event: z.literal('run_finished'),
      at: isoTimestamp,
      outcome: z.enum(['success', 'outcome', 'failure', 'escalated']),
      durationMs: z.number().int().min(0),
    })
    .strict(),
]);

/**
 * Applied at all three sinks: artifact writes, log writes, and outbound prompts.
 * There is no path to disk or to a model that skips it (I3).
 */
export interface Redactor {
  /** Returns the scrubbed text plus what was found, for the audit log. */
  redactText(input: string): { text: string; found: readonly RedactionRecord[] };

  /**
   * Blacks out sensitive regions before a screenshot is written. Region
   * detection uses accessibility bounding boxes rather than OCR — cheaper, and
   * exact for the field-level data we care about.
   */
  redactImage(
    png: Uint8Array,
    regions: readonly (readonly [number, number, number, number])[],
  ): Promise<Uint8Array>;

  /** Classify a value so the compiler can refuse to inline it as a literal. */
  classify(value: string): { classification: Sensitivity; confidence: number };
}

export interface EvidenceWriter {
  readonly runId: string;
  readonly dir: string;
  append(event: TraceEvent): Promise<void>;
  writeScreenshot(png: Uint8Array, label: string): Promise<string>;
  writeSnapshot(json: unknown, label: string): Promise<string>;
  /** `endedAt` stamps the manifest; omitted, the run is left looking unfinished. */
  finalize(result: unknown, endedAt?: string): Promise<void>;
}

export type RunKind = z.infer<typeof runKind>;
export type RunManifest = z.infer<typeof runManifest>;
export type RedactionRecord = z.infer<typeof redactionRecord>;
export type TraceEvent = z.infer<typeof traceEvent>;
