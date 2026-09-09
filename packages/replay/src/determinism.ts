import { createHash } from 'node:crypto';

import type { ReplayResult } from '@cua/contracts';

/**
 * =============================================================================
 * WHAT "THE SAME RESULT" MEANS
 * =============================================================================
 * The claim under test is that one artifact plus one set of parameters produces
 * the same answer every time. Asserting that two `ReplayResult`s are byte-equal
 * would test something else and fail immediately, because a result also carries
 * when it started, how long it took and which directory it wrote to — all of
 * which are *supposed* to differ between runs.
 *
 * So determinism needs a definition rather than a comparison, and this module is
 * it: the projection below is the part of a result that a caller acts on. Two
 * runs are identical when this matches. Everything omitted is either a clock, a
 * path, or a duration, and each omission is one the caller cannot branch on.
 *
 * It lives in the package rather than in the test on purpose. If the test owned
 * the definition, a change that made replay less deterministic could be absorbed
 * by widening the test's idea of "same" — and nobody reviewing that diff would
 * see it as a change to the guarantee. Here it is a change to an exported
 * function with a doc comment about what it promises.
 */

/** The part of a result a caller can branch on. */
export interface DeterministicProjection {
  readonly kind: ReplayResult['kind'];
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly tenant: string | null;
  /** `success`/`outcome` only. */
  readonly outputs: Record<string, unknown> | null;
  readonly outcome: { code: string; retryable: boolean } | null;
  readonly failure: { class: string; stepId: string | null; expected: string; observed: string } | null;
  readonly escalation: { reason: string; resumeFrom: string | null } | null;
  readonly steps: readonly {
    stepId: string;
    status: string;
    resolution: string | null;
    matchedBy: string | null;
    agreement: number | null;
    checkpointPassed: boolean | null;
    recoveries: readonly { condition: string; took: string; succeeded: boolean }[];
  }[];
  readonly stepsExecuted: number;
  readonly stepsTotal: number;
  readonly recoveriesPerformed: number;
  /** Always 0. Included so a projection that changed would show it. */
  readonly llmCalls: number;
}

export function project(result: ReplayResult): DeterministicProjection {
  return {
    kind: result.kind,
    capabilityId: result.capabilityId,
    capabilityVersion: result.capabilityVersion,
    tenant: result.tenant,
    outputs: result.kind === 'success' || result.kind === 'outcome' ? { ...result.outputs } : null,
    outcome:
      result.kind === 'outcome' ? { code: result.code, retryable: result.retryable } : null,
    failure:
      result.kind === 'failure'
        ? {
            class: result.failure.class,
            stepId: result.failure.stepId,
            expected: result.failure.expected,
            observed: result.failure.observed,
          }
        : null,
    escalation:
      result.kind === 'escalated'
        ? { reason: result.reason, resumeFrom: result.resumeFrom }
        : null,
    steps: result.steps.map((s) => ({
      stepId: s.stepId,
      status: s.status,
      resolution: s.resolution,
      matchedBy: s.matchedBy,
      agreement: s.agreement,
      checkpointPassed: s.checkpointPassed,
      recoveries: s.recoveries.map((r) => ({
        condition: r.condition,
        took: r.took,
        succeeded: r.succeeded,
      })),
    })),
    stepsExecuted: result.stats.stepsExecuted,
    stepsTotal: result.stats.stepsTotal,
    recoveriesPerformed: result.stats.recoveriesPerformed,
    llmCalls: result.stats.llmCalls,
  };
}

/**
 * A short hash of the projection, for comparing many runs at a glance.
 *
 * Useful in evidence and in a stability dashboard: five runs that produced one
 * distinct digest is the determinism claim, stated as a number a reader can
 * check without diffing five JSON documents.
 */
export function determinismDigest(result: ReplayResult): string {
  return createHash('sha256').update(JSON.stringify(project(result))).digest('hex').slice(0, 16);
}
