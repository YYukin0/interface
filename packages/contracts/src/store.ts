import { z } from 'zod';
import {
  DRIFT_REBASELINE_THRESHOLD,
  capabilityId,
  semVer,
  stepId,
  tenantId,
} from './common.js';
import { capability } from './capability.js';
import type { Capability } from './capability.js';

/**
 * =============================================================================
 * STORAGE AND CROSS-TENANT RESOLUTION
 * =============================================================================
 * The brief's hardest scale question: hundreds of institutions run ~20 apps
 * each, and many run the *same vendor product* branded and versioned
 * differently. Re-recording every flow per tenant is thousands of recordings and
 * a maintenance problem nobody can staff.
 *
 * Our answer is one baseline per (vendor product, flow) plus a sparse per-tenant
 * patch. Three properties follow, and they are the reason for the shape rather
 * than a happy accident:
 *
 *   1. A fix to the baseline reaches every tenant at once.
 *   2. A tenant's divergence is *measurable* — the override count is a drift
 *      signal, available without running anything.
 *   3. Review stays tractable: a reviewer reads one baseline and a short diff,
 *      not four hundred near-identical files.
 *
 * The honest limitation, stated here so it also reaches REPORT.md: this handles
 * cosmetic and structural variation — renamed controls, moved columns, extra
 * confirmation screens. It does not handle a tenant whose *business process*
 * differs. That is a different capability, and the drift score is how we notice
 * we have been pretending otherwise.
 */

export const appliedOverride = z
  .object({
    stepId,
    fields: z.array(z.enum(['target', 'timeoutMs', 'skip'])),
  })
  .strict();

export const resolvedCapability = z
  .object({
    /** The capability with tenant overrides applied. Ready to execute. */
    effective: capability,
    tenant: tenantId.nullable(),
    baselineVersion: semVer,
    applied: z.array(appliedOverride),
    /**
     * Overridden steps ÷ total steps. Past DRIFT_REBASELINE_THRESHOLD this
     * tenant has diverged enough that patching is a fiction.
     */
    driftScore: z.number().min(0).max(1),
    needsRebaseline: z.boolean(),
  })
  .strict();

/**
 * Applies a tenant's sparse patch to a baseline capability.
 *
 * Pure and total: no I/O, and an unknown tenant resolves to the baseline
 * unchanged rather than failing. That default matters — a new institution should
 * run the shared flow on day one and accumulate overrides only where it actually
 * differs, instead of being blocked pending a recording.
 */
export function applyTenantOverride(
  baseline: Capability,
  tenant: string | null,
): ResolvedCapability {
  const override = tenant === null ? undefined : baseline.tenantOverrides[tenant];

  if (!override) {
    return {
      effective: baseline,
      tenant,
      baselineVersion: baseline.version,
      applied: [],
      driftScore: 0,
      needsRebaseline: false,
    };
  }

  const applied: AppliedOverride[] = [];

  const steps = baseline.steps.map((step) => {
    const patch = override.steps[step.id];
    if (!patch) return step;

    const fields: ('target' | 'timeoutMs' | 'skip')[] = [];
    let next = step;

    if (patch.target !== null) {
      next = { ...next, target: patch.target };
      fields.push('target');
    }
    if (patch.timeoutMs !== null) {
      next = { ...next, timeoutMs: patch.timeoutMs };
      fields.push('timeoutMs');
    }
    if (patch.skip) {
      // Skipping is expressed as `optional`, which the step schema only permits
      // for safe steps — so a tenant cannot quietly skip a mutating step and
      // still be told the run succeeded.
      next = { ...next, optional: true };
      fields.push('skip');
    }

    if (fields.length > 0) applied.push({ stepId: step.id, fields });
    return next;
  });

  const effective: Capability = {
    ...baseline,
    steps,
    ...(override.entryPoint !== null
      ? { surface: { ...baseline.surface, entryPoint: override.entryPoint } }
      : {}),
  };

  const driftScore = baseline.steps.length === 0 ? 0 : applied.length / baseline.steps.length;

  return {
    effective,
    tenant,
    baselineVersion: baseline.version,
    applied,
    driftScore,
    needsRebaseline: driftScore > DRIFT_REBASELINE_THRESHOLD,
  };
}

export const capabilityQuery = z
  .object({
    id: capabilityId,
    /** Null takes the newest version satisfying `requireApproved`. */
    version: semVer.nullable().default(null),
    tenant: tenantId.nullable().default(null),
    requireApproved: z.boolean().default(true),
  })
  .strict();

/**
 * Persistence. File-backed in this implementation (D10) — one JSON file per
 * capability version under `capabilities/`, which makes artifacts reviewable in
 * a pull request. That is a feature, not a limitation of the prototype: a
 * capability changing is exactly the kind of change that should get code review.
 */
export interface CapabilityStore {
  get(query: CapabilityQuery): Promise<Capability | null>;
  /** Baseline plus tenant overrides, ready to execute. */
  resolve(query: CapabilityQuery): Promise<ResolvedCapability | null>;
  list(filter?: { app?: string; approvedOnly?: boolean }): Promise<readonly Capability[]>;
  save(c: Capability): Promise<void>;
  /** Record a replay outcome so `approval.observedStability` can be maintained. */
  recordReplayOutcome(id: string, version: string, succeeded: boolean): Promise<void>;
}

export type AppliedOverride = z.infer<typeof appliedOverride>;
export type ResolvedCapability = z.infer<typeof resolvedCapability>;
export type CapabilityQuery = z.infer<typeof capabilityQuery>;
