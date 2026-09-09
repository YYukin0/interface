import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  handoffRecord as handoffRecordSchema,
  interventionRequest as interventionRequestSchema,
  operatorInputEvent as operatorInputEventSchema,
  type ControlLease,
  type HandoffCoordinator,
  type HandoffDisposition,
  type HandoffRecord,
  type InterventionRequest,
  type OperatorInputEvent,
} from '@cua/contracts';
import { DefaultRedactor } from '@cua/redact';

import { LeaseError, LeaseRegistry } from './lease.js';
import { ConsoleTokenIssuer } from './token.js';

/**
 * =============================================================================
 * DETECT → ROUTE → CEDE → RECORD → RESUME
 * =============================================================================
 * The coordinator is the bookkeeping around a takeover: it decides who may act
 * (`LeaseRegistry`), mints the console URL (`ConsoleTokenIssuer`), and writes
 * down what happened.
 *
 * Two things it deliberately is not:
 *
 * **It is not a queue.** `raise` writes a file and prints a URL. A real
 * deployment enqueues to whatever the operations team already lives in —
 * ServiceNow, Jira, a pager — and the substitution is this one method. Naming
 * that as the seam is more useful than building a worse queue.
 *
 * **It does not own the session.** It never closes a browser and never resumes a
 * run; it hands out and takes back permission. The engine keeps its session
 * open across the whole escalation, which is what makes the human's takeover the
 * same live session rather than a new one (I7).
 *
 * The evidence it writes is the answer to "who did what to this member's
 * account, and when". In a regulated back office that record matters as much as
 * the automation — arguably more, because the automation is reviewable in
 * advance and the human is not.
 */

/** Everything about one takeover, from raise to hand-back. */
interface Session {
  readonly sessionId: string;
  intervention: InterventionRequest;
  readonly inputs: OperatorInputEvent[];
  readonly observationBefore: string;
  claimedAt: Date | null;
  operatorId: string | null;
}

export interface HandoffCoordinatorOptions {
  /** Where `handoff-<id>/` directories go. Defaults to `evidence`. */
  readonly evidenceRoot?: string;
  /**
   * Base URL of the operator console.
   *
   * A function is allowed, and is the normal case: the console binds an
   * ephemeral port, so its origin is not known until after it is listening —
   * while the coordinator has to exist first, because the server takes one.
   * Resolving lazily breaks that cycle without making the field mutable.
   */
  readonly consoleOrigin?: string | (() => string);
  readonly leases?: LeaseRegistry;
  readonly tokens?: ConsoleTokenIssuer;
  readonly redactor?: DefaultRedactor;
  /**
   * Digest of what is on screen, used to bracket the takeover. Optional because
   * a coordinator can be useful without one; when absent the record says so
   * rather than inventing a hash.
   */
  readonly observe?: () => Promise<string>;
  /** Called with the console URL when an intervention is raised. */
  readonly announce?: (intervention: InterventionRequest) => void;
  readonly now?: () => Date;
}

export class LocalHandoffCoordinator implements HandoffCoordinator {
  readonly leases: LeaseRegistry;
  readonly tokens: ConsoleTokenIssuer;

  readonly #root: string;
  readonly #origin: () => string;
  readonly #redactor: DefaultRedactor;
  readonly #observe: (() => Promise<string>) | null;
  readonly #announce: (i: InterventionRequest) => void;
  readonly #now: () => Date;

  /** Keyed by intervention id; a session id would collide across two takeovers. */
  readonly #open = new Map<string, Session>();

  /**
   * The session automation most recently stepped away from.
   *
   * The engine's escalation is `cede` then `raise`, in that order and for a
   * reason — control is released before anyone is invited to take it, never the
   * other way round. That ordering is also how these two calls find each other:
   * `cede` names the session, `raise` describes the problem, and only the pair
   * together says "this intervention is about that session".
   *
   * Passing the id through `raise` would be more explicit, and would mean adding
   * a field to `InterventionRequest` that exists to paper over a two-call
   * protocol. This is one line and the protocol is documented in both places.
   */
  #cededSession: string | null = null;

  constructor(options: HandoffCoordinatorOptions = {}) {
    this.leases = options.leases ?? new LeaseRegistry();
    this.tokens = options.tokens ?? new ConsoleTokenIssuer();
    this.#root = options.evidenceRoot ?? 'evidence';
    const origin = options.consoleOrigin ?? 'http://127.0.0.1:8090';
    this.#origin = typeof origin === 'function' ? origin : () => origin;
    this.#redactor = options.redactor ?? new DefaultRedactor();
    this.#observe = options.observe ?? null;
    this.#announce = options.announce ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
  }

  async raise(
    request: Omit<InterventionRequest, 'id' | 'createdAt' | 'status' | 'consoleUrl'>,
  ): Promise<InterventionRequest> {
    const id = `iv-${request.runId}`;
    // Falls back to the run id when nothing was ceded, which is not a normal
    // escalation — but an intervention nobody can claim is worse than one keyed
    // to a session that turns out to be idle.
    const sessionId = this.#cededSession ?? request.runId;
    const token = this.tokens.issue(sessionId, id);

    const intervention = interventionRequestSchema.parse({
      ...request,
      id,
      createdAt: this.#now().toISOString(),
      // The token is in the URL because that is the only place a link can carry
      // it, and the token is short-lived because of it. See `token.ts`.
      consoleUrl: `${this.#origin()}/?t=${token}`,
      status: 'open',
    });

    this.#open.set(id, {
      sessionId,
      intervention,
      inputs: [],
      observationBefore: (await this.#digest()) ?? '(not observed)',
      claimedAt: null,
      operatorId: null,
    });

    const dir = this.#dirFor(id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'intervention.json'),
      JSON.stringify(intervention, null, 2) + '\n',
      'utf8',
    );

    this.#announce(intervention);
    return intervention;
  }

  async cede(sessionId: string, reason: string): Promise<ControlLease> {
    this.#cededSession = sessionId;
    return this.leases.cede(sessionId, reason);
  }

  async claim(interventionId: string, operatorId: string): Promise<ControlLease> {
    const session = this.#require(interventionId);
    const lease = this.leases.claim(session.sessionId, operatorId);

    session.claimedAt = this.#now();
    session.operatorId = operatorId;
    session.intervention = { ...session.intervention, status: 'claimed' };
    await this.#persist(session);
    return lease;
  }

  async handBack(
    interventionId: string,
    disposition: HandoffDisposition,
    note: string | null,
  ): Promise<HandoffRecord> {
    const session = this.#require(interventionId);
    if (session.operatorId === null || session.claimedAt === null) {
      throw new LeaseError(
        'nobody has claimed this intervention',
        this.leases.of(session.sessionId),
      );
    }

    const lease = this.leases.handBack(session.sessionId, session.operatorId, disposition === 'resume');

    const record = handoffRecordSchema.parse({
      interventionId,
      operatorId: session.operatorId,
      startedAt: session.claimedAt.toISOString(),
      endedAt: this.#now().toISOString(),
      inputEvents: session.inputs,
      observationBefore: session.observationBefore,
      // Taken after the hand-back, so it reflects the state automation is about
      // to inherit. The pair is the evidence of what the human changed — which
      // is the question an auditor asks, and the one a video cannot answer
      // without somebody watching it.
      observationAfter: (await this.#digest()) ?? '(not observed)',
      disposition,
      note,
    });

    session.intervention = {
      ...session.intervention,
      status: disposition === 'abort' ? 'abandoned' : 'resolved',
    };
    await this.#persist(session);
    await writeFile(
      join(this.#dirFor(interventionId), 'handoff.json'),
      JSON.stringify({ ...record, leaseAfter: lease }, null, 2) + '\n',
      'utf8',
    );

    this.#open.delete(interventionId);
    return record;
  }

  async lease(sessionId: string): Promise<ControlLease> {
    return this.leases.of(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /**
   * Record one human input.
   *
   * Called by the console server for every event it accepts, *after* the lease
   * check, so the file is a record of what was allowed to happen rather than of
   * what was attempted. Attempts that the lease refused are not silently
   * dropped either — the server logs those separately, because "somebody tried
   * to type into a session they did not hold" is the more interesting line.
   *
   * The text of a keystroke goes through the redactor on its way in. An
   * operator taking over a stuck sign-on is going to type a password, and this
   * is precisely the sink I3 was written for: we record THAT they typed into a
   * field, never what.
   */
  record(interventionId: string, event: OperatorInputEvent): void {
    const session = this.#open.get(interventionId);
    if (session === undefined) return;
    session.inputs.push(
      operatorInputEventSchema.parse({
        ...event,
        text: event.text === null ? null : this.#redactor.redactText(event.text).text,
      }),
    );
  }

  /** Everything recorded so far, for a console that wants to show it. */
  inputsOf(interventionId: string): readonly OperatorInputEvent[] {
    return this.#open.get(interventionId)?.inputs ?? [];
  }

  interventionOf(interventionId: string): InterventionRequest | null {
    return this.#open.get(interventionId)?.intervention ?? null;
  }

  // ---------------------------------------------------------------------------

  #require(interventionId: string): Session {
    const session = this.#open.get(interventionId);
    if (session === undefined) throw new Error(`no open intervention ${interventionId}`);
    return session;
  }

  /** The session an intervention is about, for a caller polling the lease. */
  sessionIdOf(interventionId: string): string | null {
    return this.#open.get(interventionId)?.sessionId ?? null;
  }

  #dirFor(interventionId: string): string {
    return join(this.#root, `handoff-${interventionId}`);
  }

  async #persist(session: Session): Promise<void> {
    await writeFile(
      join(this.#dirFor(session.intervention.id), 'intervention.json'),
      JSON.stringify(session.intervention, null, 2) + '\n',
      'utf8',
    );
  }

  async #digest(): Promise<string | null> {
    if (this.#observe === null) return null;
    return this.#observe().catch(() => null);
  }
}
