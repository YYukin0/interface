/**
 * Deterministic guardrails. Consulted before every action in both phases (I4).
 *
 *   engine.ts  evaluation order and the decision it produces
 *   load.ts    reading and validating the policy document
 */
export { AllowlistPolicyEngine, RULES } from './engine.js';
export { loadPolicy, loadPolicyEngine, DENY_ALL } from './load.js';
