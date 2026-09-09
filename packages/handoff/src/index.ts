/**
 * Human takeover of the same live session.
 *
 *   lease.ts        who may act, as a state machine — the increment over the
 *                   live-view tools this package borrows its transport from
 *   token.ts        a console URL is a credential, so it is signed and expires
 *   coordinator.ts  detect → route → cede → record → resume, and the evidence
 *   server.ts       the console: frames out over SSE, input in over POST
 *
 * The one thing every file here holds to: nothing in this package closes a
 * session. Losing the lease is losing permission to act, not losing the browser
 * — which is what makes the takeover the *same* session (I7).
 */
export { LeaseRegistry, LeaseError, DEFAULT_LEASE_MS } from './lease.js';
export { ConsoleTokenIssuer, type ConsoleClaim } from './token.js';
export {
  LocalHandoffCoordinator,
  type HandoffCoordinatorOptions,
} from './coordinator.js';
export {
  startOperatorConsole,
  type OperatorConsole,
  type OperatorConsoleOptions,
} from './server.js';
