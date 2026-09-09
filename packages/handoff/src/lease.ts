import { controlLease, type ControlHolder, type ControlLease } from '@cua/contracts';

/**
 * =============================================================================
 * THE CONTROL LEASE
 * =============================================================================
 * Who is allowed to act on a session, as a state machine rather than as a
 * convention.
 *
 * This is the whole increment of this package over the live-view tools it
 * borrows its transport from. Steel's viewer and Browserbase's Live View are
 * debugging windows: the browser is there, and anyone holding the URL may reach
 * into it at any moment, including while the automation is mid-step. For
 * debugging that is exactly right. For an action against a member's account it
 * is not, because "the automation clicked Transfer and so did a human, 40ms
 * apart" is not a thing an audit log can be written about afterwards.
 *
 * So control is a resource with one holder:
 *
 *        ┌──────────────┐  cede   ┌──────┐  claim   ┌──────────┐
 *        │  automation  │────────▶│ none │─────────▶│ operator │
 *        └──────────────┘         └──────┘          └──────────┘
 *               ▲                     ▲                   │
 *               └─────────────────────┴───────────────────┘
 *                        handBack           expire
 *
 * Three rules give the diagram its teeth:
 *
 *   1. **A lease is never stolen.** There is no `takeControl`. It is released by
 *      its holder or it expires — nothing else moves it.
 *   2. **Expiry lands on `none`, not back on `automation`.** An operator who
 *      shuts their laptop mid-takeover leaves a session in an unknown state, and
 *      resuming automation into it is precisely how an unattended irreversible
 *      action happens. The run is abandoned instead, and a person is told.
 *   3. **Nothing here closes the session.** Losing the lease is losing
 *      permission to act, not losing the browser. The brief is explicit that the
 *      human takes over the *same* live session, and every transition below
 *      preserves that.
 *
 * The registry is in-memory and single-process, which is honest for this build
 * and named in REPORT §7: a real deployment puts the lease in the same store as
 * the run and gives it a compare-and-set, because two consoles on two machines
 * is the case that makes the guarantee non-trivial.
 */

/** How long an operator may hold a session before the lease lapses. */
export const DEFAULT_LEASE_MS = 15 * 60_000;

export class LeaseError extends Error {
  constructor(
    message: string,
    readonly current: ControlLease,
  ) {
    super(message);
    this.name = 'LeaseError';
  }
}

export class LeaseRegistry {
  readonly #leases = new Map<string, ControlLease>();
  readonly #ttlMs: number;
  readonly #now: () => Date;

  constructor(options: { ttlMs?: number; now?: () => Date } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_LEASE_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * The current holder, with expiry applied.
   *
   * Expiry is evaluated on read rather than on a timer on purpose: a timer is a
   * second source of truth that can be missed, paused by a debugger, or fire
   * after the process has moved on. Reading is the only way anyone learns who
   * holds the lease, so it is the only place the answer has to be right.
   */
  of(sessionId: string): ControlLease {
    const held = this.#leases.get(sessionId);
    if (held === undefined) return this.#make(sessionId, 'automation', null, null);
    if (Date.parse(held.expiresAt) > this.#now().getTime()) return held;

    const lapsed = this.#make(
      sessionId,
      'none',
      null,
      `lease held by ${held.holder} expired at ${held.expiresAt}`,
    );
    this.#leases.set(sessionId, lapsed);
    return lapsed;
  }

  /** True when `holder` may act right now. Checked before every action, both sides. */
  holds(sessionId: string, holder: ControlHolder): boolean {
    return this.of(sessionId).holder === holder;
  }

  /** Automation steps back. The session stays open; that is the entire point. */
  cede(sessionId: string, reason: string): ControlLease {
    const current = this.of(sessionId);
    if (current.holder === 'operator') {
      throw new LeaseError('cannot cede a lease an operator already holds', current);
    }
    return this.#set(this.#make(sessionId, 'none', null, reason));
  }

  /**
   * An operator takes control.
   *
   * Refused while automation still holds the lease, and that refusal is load
   * bearing rather than defensive. It means an operator opening the console URL
   * during a healthy run cannot type into the page underneath a step in flight:
   * they get a view and an error, and the automation has to stop first.
   */
  claim(sessionId: string, operatorId: string): ControlLease {
    const current = this.of(sessionId);
    if (current.holder === 'operator') {
      throw new LeaseError(
        current.holderId === operatorId
          ? 'you already hold this session'
          : `already held by operator ${current.holderId}`,
        current,
      );
    }
    if (current.holder === 'automation') {
      throw new LeaseError('automation still holds this session; it has not asked for help', current);
    }
    return this.#set(this.#make(sessionId, 'operator', operatorId, 'claimed by operator'));
  }

  /**
   * The operator gives control back.
   *
   * `resume` returns the lease to automation; the other two dispositions leave
   * it on `none`, because a run somebody finished by hand or judged unsafe has
   * no automation left to resume — handing the lease back would invite exactly
   * that.
   */
  handBack(sessionId: string, operatorId: string, toAutomation: boolean): ControlLease {
    const current = this.of(sessionId);
    if (current.holder !== 'operator' || current.holderId !== operatorId) {
      throw new LeaseError(`operator ${operatorId} does not hold this session`, current);
    }
    return this.#set(
      toAutomation
        ? this.#make(sessionId, 'automation', null, `handed back by ${operatorId}`)
        : this.#make(sessionId, 'none', null, `released by ${operatorId}; run is over`),
    );
  }

  #set(lease: ControlLease): ControlLease {
    this.#leases.set(lease.sessionId, lease);
    return lease;
  }

  #make(
    sessionId: string,
    holder: ControlHolder,
    holderId: string | null,
    reason: string | null,
  ): ControlLease {
    const since = this.#now();
    // Parsed rather than constructed, so a lease that would not survive a round
    // trip through the contract cannot exist in memory either.
    return controlLease.parse({
      sessionId,
      holder,
      holderId,
      since: since.toISOString(),
      expiresAt: new Date(since.getTime() + this.#ttlMs).toISOString(),
      reason,
    });
  }
}
