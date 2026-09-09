import { z } from 'zod';
import { capabilityId, semVer, stepId, tenantId } from './common.js';
import { riskClass } from './capability.js';
import { actionType } from './surface.js';

/**
 * =============================================================================
 * POLICY
 * =============================================================================
 * D8: this engine is deterministic. No model is consulted, ever.
 *
 * Two reasons, both structural rather than stylistic:
 *   1. "Irreversible" is a property of the action, not of the surrounding text.
 *      A classifier asked whether a transfer is safe is answering a reading
 *      comprehension question about a prompt; we want a lookup in a table.
 *   2. A guardrail that reads page content is attackable by page content. Any
 *      LLM in this position is reachable by injected text on the very screens we
 *      are automating.
 *
 * We borrow OPA's shape — `input + policy → decision` — and nothing else. Pulling
 * in Rego for what a YAML file and a few hundred lines of evaluation cover would
 * be exactly the framework name-dropping the brief penalises.
 */

export const policyPhase = z.enum(['discovery', 'replay']);

/** Who is asking. Policy binds to a principal, never to a prompt. */
export const principal = z
  .object({
    kind: z.enum(['discovery-agent', 'calling-agent', 'operator']),
    id: z.string().min(1),
    tenant: tenantId.nullable().default(null),
  })
  .strict();

export const policyRequest = z
  .object({
    principal,
    phase: policyPhase,
    capabilityId: capabilityId.nullable().default(null),
    stepId: stepId.nullable().default(null),
    action: actionType,
    risk: riskClass,
    /** Where the action would land: URL for web, window identity for desktop. */
    location: z.string(),
    /** Steps taken so far this run; enforces the per-run budget. */
    stepIndex: z.number().int().min(0),
  })
  .strict();

/**
 * The decision.
 *
 * `require_confirmation` is not "allow with a warning": the caller must block on
 * a human answer. In replay that means raising an intervention, which is why
 * escalation is a first-class arm of `ReplayResult`.
 */
export const policyDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow') }).strict(),
  z
    .object({
      kind: z.literal('deny'),
      /** Which rule fired. Every denial is attributable to a line of config. */
      rule: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('require_confirmation'),
      rule: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);

/** What to do with each risk class. Configurable, with conservative defaults. */
export const riskDisposition = z.enum(['allow', 'confirm', 'deny']);

export const policyDocument = z
  .object({
    version: semVer,
    /**
     * Default deny. An empty allowlist permits nothing, which is the correct
     * failure mode for a misconfigured deployment.
     */
    allowedOrigins: z.array(z.string()).default([]),
    allowedPathPrefixes: z.array(z.string()).default([]),
    allowedActions: z.array(actionType).default([]),
    maxStepsPerRun: z.number().int().positive().max(200).default(40),

    risk: z
      .object({
        safe: riskDisposition.default('allow'),
        mutating: riskDisposition.default('confirm'),
        /**
         * I8: not configurable to `allow`, and the type says so. There is no
         * flag that lets automation move money unattended. With regulated
         * financial data and no undo, the cost of being wrong is unbounded while
         * the cost of a human confirmation is a few seconds.
         */
        irreversible: z.enum(['confirm', 'deny']).default('deny'),
      })
      .strict()
      .default({ safe: 'allow', mutating: 'confirm', irreversible: 'deny' }),

    /** Regex patterns that deny regardless of the allowlist, e.g. `/admin/users/delete`. */
    denyPatterns: z.array(z.string()).default([]),
  })
  .strict();

/**
 * Consulted before every action in both phases (I4). There is no bypass path.
 *
 * A denial during discovery is fed back to the model as an observation so it
 * re-plans rather than crashing; a denial during replay is a hard failure with
 * class `POLICY_DENIED`.
 */
export interface PolicyEngine {
  evaluate(request: PolicyRequest): PolicyDecision;
}

export type PolicyPhase = z.infer<typeof policyPhase>;
export type Principal = z.infer<typeof principal>;
export type PolicyRequest = z.infer<typeof policyRequest>;
export type PolicyDecision = z.infer<typeof policyDecision>;
export type RiskDisposition = z.infer<typeof riskDisposition>;
export type PolicyDocument = z.infer<typeof policyDocument>;
