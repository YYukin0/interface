import { z } from 'zod';
import { capabilityId, jsonSchemaObject, semVer, tenantId } from './common.js';
import type { Capability } from './capability.js';
import type { ReplayResult } from './replay.js';

/**
 * =============================================================================
 * THE AGENT-FACING CATALOGUE
 * =============================================================================
 * D6 claims a capability *is* a tool contract. This module is where that claim
 * is cashed: the conversion is a pure function with no I/O, because if turning
 * an artifact into a callable tool required a database lookup or a template,
 * the artifact would not really be the contract.
 *
 * Shape follows MCP's `tools/list` → `tools/call` convention (name, description,
 * inputSchema, outputSchema) so the catalogue can be exposed over MCP without
 * translation. We are not taking a dependency on an MCP SDK to say so.
 */

/**
 * Behavioural hints for the calling agent, derived from the steps rather than
 * declared by hand — a hand-written `readOnlyHint` drifts from the flow it
 * describes, and this one cannot.
 */
export const toolAnnotations = z
  .object({
    /** Every step is `safe`: the capability observes without changing anything. */
    readOnlyHint: z.boolean(),
    /** Some step is `irreversible`. Always requires a human (I8). */
    destructiveHint: z.boolean(),
    /** Safe to call twice with the same arguments. Read-only implies idempotent. */
    idempotentHint: z.boolean(),
    /** False for `draft`/`review`/`deprecated`: not callable unattended. */
    availableUnattended: z.boolean(),
  })
  .strict();

export const toolDefinition = z
  .object({
    /** Stable, agent-visible name. The capability id doubles as it. */
    name: capabilityId,
    version: semVer,
    title: z.string(),
    /** Prompt context for the caller: what it does AND when to use it. */
    description: z.string(),
    inputSchema: jsonSchemaObject,
    outputSchema: jsonSchemaObject,
    /**
     * Declared business outcomes, surfaced to the caller up front.
     *
     * This is the part a generic tool schema cannot express and the reason we
     * did not simply reuse one: the agent needs to know before calling that
     * `MEMBER_NOT_FOUND` is a possible *answer*, not an error to retry through.
     */
    outcomes: z.array(
      z.object({ code: z.string(), description: z.string(), retryable: z.boolean() }).strict(),
    ),
    annotations: toolAnnotations,
  })
  .strict();

/** Pure projection of an artifact into the calling agent's view of it. */
export function toToolDefinition(c: Capability): ToolDefinition {
  const risks = c.steps.map((s) => s.risk);
  const readOnly = risks.every((r) => r === 'safe');

  return {
    name: c.id,
    version: c.version,
    title: c.displayName,
    description: c.description,
    inputSchema: c.inputs,
    outputSchema: c.outputs,
    outcomes: c.businessOutcomes.map((o) => ({
      code: o.code,
      description: o.description,
      retryable: o.retryable,
    })),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: risks.includes('irreversible'),
      idempotentHint: readOnly,
      availableUnattended: c.approval.state === 'approved',
    },
  };
}

export const catalogFilter = z
  .object({
    tenant: tenantId.nullable().default(null),
    app: z.string().nullable().default(null),
    /** Default true: agents see only approved capabilities. */
    approvedOnly: z.boolean().default(true),
    /** Default false: hide anything that could take an irreversible action. */
    includeDestructive: z.boolean().default(false),
  })
  .strict();

/**
 * What an AI agent talks to.
 *
 * `invoke` returns a `ReplayResult` rather than throwing, so the four-arm
 * distinction survives all the way to the caller. An agent that receives
 * `{ kind: 'outcome', code: 'MEMBER_NOT_FOUND' }` should tell the member their
 * id was not found; one that receives `{ kind: 'failure' }` should not.
 */
export interface CapabilityCatalog {
  list(filter?: CatalogFilter): Promise<readonly ToolDefinition[]>;
  describe(name: string, version?: string | null): Promise<ToolDefinition | null>;
  invoke(
    name: string,
    args: Record<string, unknown>,
    options?: { tenant?: string | null; version?: string | null },
  ): Promise<ReplayResult>;
}

export type ToolAnnotations = z.infer<typeof toolAnnotations>;
export type ToolDefinition = z.infer<typeof toolDefinition>;
export type CatalogFilter = z.infer<typeof catalogFilter>;
