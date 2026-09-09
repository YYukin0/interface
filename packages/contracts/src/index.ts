/**
 * All shared types for the computer-use automation system.
 *
 * Read in this order:
 *   common.ts      primitives, identifiers, data classification
 *   surface.ts     THE SEAM — perception and action, independent of web/desktop
 *   capability.ts  THE ARTIFACT — the reusable, reviewable, invocable capability
 *   discovery.ts   the LLM half: agent vocabulary, and trace → capability
 *   replay.ts      THE RESULT CONTRACT — success / outcome / failure / escalated
 *   policy.ts      guardrails
 *   handoff.ts     control transfer to a human
 *   store.ts       persistence and cross-tenant override resolution
 *   catalog.ts     how a calling agent discovers and invokes a capability
 *   evidence.ts    what we record and how it gets redacted
 *
 * Invariants that these types exist to enforce are listed in AGENTS.md §3.
 */
export * from './common.js';
export * from './surface.js';
export * from './capability.js';
export * from './discovery.js';
export * from './replay.js';
export * from './policy.js';
export * from './handoff.js';
export * from './store.js';
export * from './catalog.js';
export * from './evidence.js';
