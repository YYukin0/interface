import { z } from 'zod';
import {
  capabilityId,
  checkpointId,
  isoTimestamp,
  runRef,
  stepId,
  stuckReason,
} from './common.js';

/**
 * =============================================================================
 * CONTROL TRANSFER
 * =============================================================================
 * The brief is explicit that a human must operate the SAME live session the
 * automation was using — not a fresh one — and then hand control back.
 *
 * We read the reference implementation in
 * `research/steel-browser/api/src/plugins/browser-socket/casting.handler.ts`
 * (MIT). The transport is settled and unremarkable: CDP `Page.startScreencast`
 * (jpeg, q75) out over a WebSocket, `Input.dispatchMouseEvent` /
 * `Input.dispatchKeyEvent` back in, `Page.screencastFrameAck` on every frame or
 * the stream stalls, 30s ping to detect dead connections.
 *
 * The one thing Steel's live view does not have is the one thing this problem
 * needs: a notion of WHO HOLDS CONTROL. Its viewer lets anyone interfere at any
 * moment, which is right for a debugging tool and wrong for a regulated
 * back-office action. `ControlLease` is our addition and the substance of this
 * module — the transport is a detail we are happy to borrow.
 *
 * We chose CDP over the off-the-shelf Xvfb + x11vnc + noVNC route for one
 * reason: every operator input arrives as a structured event we can record, so
 * "what did the human do" becomes queryable evidence. VNC would only give us a
 * video.
 */

export const controlHolder = z.enum(['automation', 'operator', 'none']);

/**
 * Single source of truth for who may act on a session.
 *
 * Both the replay engine and the operator console check the lease before every
 * action, so control transfer is enforced rather than merely coordinated. A lease
 * is never implicitly stolen; it is released by its holder or it expires.
 */
export const controlLease = z
  .object({
    sessionId: z.string().min(1),
    holder: controlHolder,
    /** Operator identity while held by a human; null otherwise. */
    holderId: z.string().nullable().default(null),
    since: isoTimestamp,
    /**
     * Leases expire so an operator who closes their laptop does not strand a
     * session forever. On expiry the holder becomes `none` and the run is
     * abandoned rather than silently resumed — resuming under a lease nobody was
     * watching is how you get an unattended irreversible action.
     */
    expiresAt: isoTimestamp,
    reason: z.string().nullable().default(null),
  })
  .strict();

/**
 * Raised when the system stops and asks for a person.
 *
 * It must carry enough context to act on without reading the logs: which
 * capability and goal, which step, what the screen looked like, and why we
 * stopped.
 */
export const interventionRequest = z
  .object({
    id: z.string().min(1),
    createdAt: isoTimestamp,
    runId: z.string().min(1),
    capabilityId: capabilityId.nullable(),
    /** The natural-language goal, for interventions raised during discovery. */
    goal: z.string().nullable().default(null),
    stepId: stepId.nullable(),
    stepIntent: z.string().nullable(),
    reason: stuckReason,
    /** Prose for the operator, already redacted (I3). */
    explanation: z.string().min(1),
    screenshotRef: z.string().nullable(),
    observationRef: z.string().nullable(),
    evidence: runRef,
    /** URL of the operator console for this live session. Treat as a credential. */
    consoleUrl: z.string().min(1),
    /** Where the run resumes once control returns (I7) — a checkpoint, not a step. */
    resumeFrom: checkpointId.nullable(),
    status: z.enum(['open', 'claimed', 'resolved', 'abandoned', 'expired']),
  })
  .strict();

/**
 * A single human input, recorded as structured evidence.
 *
 * Coordinates are normalised to [0,1] so the record stays meaningful across
 * viewport sizes, and so it means something to a desktop driver too.
 */
export const operatorInputEvent = z
  .object({
    at: isoTimestamp,
    kind: z.enum(['mouse', 'key', 'navigation', 'scroll']),
    /** `mouseDown`, `keyDown`, … — mirrors the CDP input vocabulary. */
    detail: z.string(),
    x: z.number().min(0).max(1).nullable().default(null),
    y: z.number().min(0).max(1).nullable().default(null),
    /**
     * Redacted before persistence. We record THAT the operator typed into a
     * field, never what they typed — they may well be entering a credential,
     * which is exactly the case I3 exists for.
     */
    text: z.string().nullable().default(null),
  })
  .strict();

/** What the operator decided to do with the run. */
export const handoffDisposition = z.enum([
  /** Human unblocked it; automation continues from `resumeFrom`. */
  'resume',
  /** Human finished the task by hand; the run is complete. */
  'completed_manually',
  /** Human judged it unsafe or impossible; the run stops. */
  'abort',
]);

/**
 * The audit record of one takeover. This is the answer to "who did what to this
 * member's account, and when" — in a regulated environment it matters as much as
 * the automation itself.
 */
export const handoffRecord = z
  .object({
    interventionId: z.string().min(1),
    operatorId: z.string().min(1),
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    inputEvents: z.array(operatorInputEvent),
    /** Observation digests bracketing the takeover: what the human changed. */
    observationBefore: z.string(),
    observationAfter: z.string(),
    disposition: handoffDisposition,
    note: z.string().nullable().default(null),
  })
  .strict();

/**
 * Detect → route → cede → record → resume.
 *
 * `packages/handoff` implements this against a local file-backed queue and the
 * console in `apps/operator`. In a real deployment `raise` would enqueue to a
 * work-management system; that substitution is the seam, and it is the only part
 * of this module we consider stubbed.
 */
export interface HandoffCoordinator {
  /** Publish an intervention and return it with its console URL populated. */
  raise(
    request: Omit<InterventionRequest, 'id' | 'createdAt' | 'status' | 'consoleUrl'>,
  ): Promise<InterventionRequest>;

  /** Automation releases the lease. The session stays alive — that is the point. */
  cede(sessionId: string, reason: string): Promise<ControlLease>;

  /** An operator claims the lease. Fails if it is already held. */
  claim(interventionId: string, operatorId: string): Promise<ControlLease>;

  /** Operator hands control back, supplying their disposition and audit record. */
  handBack(
    interventionId: string,
    disposition: HandoffDisposition,
    note: string | null,
  ): Promise<HandoffRecord>;

  /** Current holder. Checked before every action on both sides. */
  lease(sessionId: string): Promise<ControlLease>;
}

export type ControlHolder = z.infer<typeof controlHolder>;
export type ControlLease = z.infer<typeof controlLease>;
export type InterventionRequest = z.infer<typeof interventionRequest>;
export type OperatorInputEvent = z.infer<typeof operatorInputEvent>;
export type HandoffDisposition = z.infer<typeof handoffDisposition>;
export type HandoffRecord = z.infer<typeof handoffRecord>;
