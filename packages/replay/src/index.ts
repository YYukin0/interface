/**
 * The cheap half: the same artifact, executed the same way, with no model.
 *
 *   params.ts       the caller's parameters, checked against the tool contract
 *   store.ts        artifacts on disk, with git as the version history
 *   engine.ts       the runtime state table, recovery, and the four-arm result
 *   determinism.ts  what "the same result twice" is defined to mean
 *
 * I1 is enforced by this package's dependency list, not by its prose: there is
 * no model SDK in it, and `@cua/discovery` — the one package that has one — is
 * not reachable from here.
 */
export {
  DeterministicReplayEngine,
  STUCK_TO_FAILURE,
  type ReplayEngineOptions,
  type RunOptions,
} from './engine.js';
export { FileCapabilityStore, STABILITY_FILE } from './store.js';
export { bindParams, type BindResult } from './params.js';
export { project, determinismDigest, type DeterministicProjection } from './determinism.js';
