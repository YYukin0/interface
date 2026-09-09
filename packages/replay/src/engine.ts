import {
  SCHEMA_VERSION,
  applyTenantOverride,
  type A11yNode,
  type Action,
  type AssertionResult,
  type BusinessOutcome,
  type Capability,
  type Checkpoint,
  type FailureClass,
  type FailureDetail,
  type HandoffCoordinator,
  type Observation,
  type PolicyDecision,
  type PolicyEngine,
  type RecoverableCondition,
  type RecoveryAttempt,
  type ReplayEngine,
  type ReplayRequest,
  type ReplayResult,
  type ReplayStats,
  type Resolution,
  type Sensitivity,
  type Step,
  type StepRecord,
  type StuckReason,
  type SurfaceDriver,
  type TraceEvent,
  replayRequest as replayRequestSchema,
  refProperty,
} from '@cua/contracts';
import { EvidenceSink, FileEvidenceWriter, newRunId } from '@cua/evidence';
import { DefaultRedactor } from '@cua/redact';

import { bindParams } from './params.js';
import { FileCapabilityStore } from './store.js';

/**
 * =============================================================================
 * THE REPLAY ENGINE
 * =============================================================================
 * The production path. It takes an artifact and some parameters and produces one
 * of four results, and it does so without ever asking a model anything.
 *
 * I1 IS A PROPERTY OF THE DEPENDENCY GRAPH, NOT A RULE. There is no model client
 * in this package's `dependencies`, so the statement "replay is deterministic"
 * is checkable with `npm ls` rather than by reading for discipline. `stats.
 * llmCalls` is typed `z.literal(0)`, so every piece of evidence this engine
 * writes repeats the claim in a machine-checkable form.
 *
 * The other four sources of run-to-run variation are handled elsewhere and named
 * here so the list is in one place: the viewport is pinned and animations are off
 * (`openSession`), waiting is always on a condition and never on a clock
 * (`#settle`), locators are resolved by agreement across a bundle rather than by
 * a single selector (`SurfaceDriver.resolve`), and caller data is injected from
 * the request rather than read out of the artifact (`bindParams`).
 *
 * -----------------------------------------------------------------------------
 * THE RUNTIME STATE TABLE
 * -----------------------------------------------------------------------------
 * After a step acts, the screen is in one of a small number of states, and
 * telling them apart is most of what this file does. The order below is the
 * order they are tested in, and each position is a decision:
 *
 *   1. a blocking modal        A check evaluated under a modal is not evidence
 *                              of anything — it can only report "cannot see".
 *                              So the modal is cleared first, and only then do
 *                              the questions below have meaningful answers.
 *   2. a declared business     I2. "No such member" is the answer the caller
 *      outcome                 asked for, so it wins over every failure
 *                              interpretation of the same screen, and it is
 *                              tested before the step's own checkpoint rather
 *                              than after it times out.
 *   3. the step's checkpoint   The ordinary case. Waiting for it *is* the
 *                              slow-load handling; there is no separate
 *                              "is it slow?" test, because there is nothing
 *                              else such a test could do.
 *   4. session expiry          Only reachable once the checkpoint has failed,
 *                              which is correct: a live session that is merely
 *                              slow must never be re-authenticated underneath
 *                              a half-finished flow.
 *   5. everything else         `CHECKPOINT_FAILED`, reported as expected-vs-
 *                              observed.
 *
 * Two rows of the plan's table are deliberately absent from that list, because
 * they need no code. A *validation error* is either declared as a business
 * outcome — in which case row 2 catches it — or it is not, in which case the
 * checkpoint fails and row 5 reports it; "declared or not" is the whole
 * distinction and it lives in the artifact, not in a branch. And *locator drift*
 * is detected before the action rather than after it, in `#locate`, because the
 * point of detecting it is not to explain a failure but to avoid clicking the
 * wrong control.
 */

/**
 * How often the settle loop re-evaluates. Slower than the driver's own 150ms
 * because a round here costs several observations — the modal scan, each
 * declared outcome, and the checkpoint — and the thing being waited for is a
 * page load, which does not repay finer sampling.
 */
const POLL_MS = 250;

/**
 * A checkpoint timeout meaning "evaluate once and answer".
 *
 * The schema requires a positive integer, so this is the smallest legal way to
 * ask the driver a question without also asking it to wait. The settle loop owns
 * the waiting; the driver's own polling would nest one wait inside another and
 * make the effective timeout of a step the product of two numbers instead of
 * either of them.
 */
const ONE_SHOT_MS = 1;

/** Budget for getting a target to resolve, as a fraction of the step's own. */
const RESOLVE_SHARE = 0.4;

/**
 * What an escalation becomes when there is nowhere to escalate to.
 *
 * A deployment with no handoff configured must still get a usable answer rather
 * than a promise nobody will keep, so every stuck reason has a failure it
 * degrades to. The mapping is total by type, so adding a reason to the enum
 * breaks the build here.
 */
export const STUCK_TO_FAILURE: Readonly<Record<StuckReason, FailureClass>> = {
  locator_unresolved: 'LOCATOR_UNRESOLVED',
  locator_disagreement: 'LOCATOR_DISAGREEMENT',
  locator_ambiguous: 'LOCATOR_AMBIGUOUS',
  checkpoint_failed: 'CHECKPOINT_FAILED',
  policy_requires_confirmation: 'POLICY_DENIED',
  irreversible_action: 'POLICY_DENIED',
  session_expired: 'SESSION_UNRECOVERABLE',
  unknown_state: 'INTERNAL_ERROR',
  max_steps_exhausted: 'STEP_TIMEOUT',
  agent_requested_help: 'INTERNAL_ERROR',
};

/** Per-invocation options that are not part of the caller-facing contract. */
export interface RunOptions {
  /**
   * Continue on the screen the session is already showing, rather than
   * navigating to the capability's entry point first. Set by a hand-back from a
   * human takeover, and by nothing else.
   */
  readonly resumeInPlace?: boolean;
}

export interface ReplayEngineOptions {
  readonly driver: SurfaceDriver;
  readonly policy: PolicyEngine;
  /** Where artifacts are read from. Defaults to `capabilities/` on disk. */
  readonly store?: FileCapabilityStore;
  /**
   * Origin the capability's relative `entryPoint` is resolved against.
   *
   * The artifact stores a path and not a URL on purpose: the same capability
   * describes the same vendor product at every institution that runs it, and
   * only the origin differs. That is tenant configuration, and it arrives here.
   */
  readonly origin: string;
  readonly sink?: EvidenceSink;
  readonly evidenceRoot?: string;
  readonly redactor?: DefaultRedactor;
  readonly principalId?: string;
  /**
   * Detects that the application has bounced us back to sign-on.
   *
   * Supplied by the deployment rather than baked in, for the same reason
   * `openSession` is: what an expired session looks like is a property of the
   * application, and the alternative is this engine pattern-matching on English
   * error text, which is both web-specific and wrong the moment the product is
   * localised.
   */
  readonly sessionProbe?: Checkpoint;
  /** Re-enters credentials on the SAME live session. Backs `reauthenticate`. */
  readonly reauthenticate?: () => Promise<boolean>;
  /**
   * Where an intervention goes. Absent, escalations degrade to the failures in
   * `STUCK_TO_FAILURE` — a run that cannot reach a human must not report that
   * one is on the way.
   */
  readonly handoff?: Pick<HandoffCoordinator, 'raise' | 'cede'>;
  readonly now?: () => Date;
}

export class DeterministicReplayEngine implements ReplayEngine {
  readonly #o: ReplayEngineOptions;
  readonly #store: FileCapabilityStore;
  readonly #redactor: DefaultRedactor;
  readonly #now: () => Date;

  constructor(options: ReplayEngineOptions) {
    this.#o = options;
    this.#store = options.store ?? new FileCapabilityStore();
    this.#redactor = options.redactor ?? new DefaultRedactor();
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Invoke a capability.
   *
   * `resumeInPlace` picks the flow up on the screen the session is already
   * showing instead of navigating to the entry point first. Its one caller is a
   * hand-back from a human takeover; see `Run.execute`.
   */
  async run(request: ReplayRequest, options: RunOptions = {}): Promise<ReplayResult> {
    const parsed = replayRequestSchema.parse(request);

    const baseline = await this.#store.get({
      id: parsed.capabilityId,
      version: parsed.version,
      tenant: parsed.tenant,
      // Approval is checked below rather than here, so that "not approved" is a
      // reportable decision instead of an indistinguishable "not found".
      requireApproved: false,
    });

    if (baseline === null) {
      return await this.#refuseBeforeStarting(parsed, null, {
        class: 'INPUT_INVALID',
        stepId: null,
        expected: `a capability '${parsed.capabilityId}'${parsed.version === null ? '' : `@${parsed.version}`}`,
        observed: 'no such capability in the store',
        detail: null,
      });
    }

    if (parsed.requireApproved && baseline.approval.state !== 'approved') {
      return await this.#refuseBeforeStarting(parsed, baseline, {
        class: 'POLICY_DENIED',
        stepId: null,
        expected: "approval.state 'approved'",
        observed: `approval.state '${baseline.approval.state}'`,
        detail:
          'an agent may only invoke an approved capability unattended; clear ' +
          'requireApproved to run a draft by hand',
      });
    }

    const bound = bindParams(baseline.inputs, parsed.params);
    if (!bound.ok) {
      return await this.#refuseBeforeStarting(parsed, baseline, {
        class: bound.kind === 'invalid' ? 'INPUT_INVALID' : 'INTERNAL_ERROR',
        stepId: null,
        expected: 'parameters satisfying the capability input schema',
        observed: bound.errors.join('; '),
        detail: null,
      });
    }

    const resolved = applyTenantOverride(baseline, parsed.tenant);
    const redactor = this.#redactorFor(baseline, bound.values);
    const sink = this.#o.sink ?? new EvidenceSink();
    const startedAt = this.#now().toISOString();

    const writer = await FileEvidenceWriter.open(
      {
        runId: newRunId('replay', this.#now()),
        kind: 'replay',
        startedAt,
        endedAt: null,
        capabilityId: baseline.id,
        goal: null,
        target: this.#entryUrl(resolved.effective),
        // I1, in the evidence rather than only in the prose: a replay run that
        // named a model would be a replay run that had one.
        model: null,
        schemaVersion: SCHEMA_VERSION,
        gitSha: null,
      },
      { root: this.#o.evidenceRoot ?? 'evidence', redactor },
    );

    sink.bind(writer);
    try {
      const run = new Run(
        this.#o,
        redactor,
        this.#now,
        parsed,
        resolved.effective,
        bound.values,
        writer,
        sink,
        startedAt,
      );
      const result = await run.execute(options.resumeInPlace ?? false);
      await this.#store
        .recordReplayOutcome(baseline.id, baseline.version, result.kind === 'success')
        .catch(() => undefined);
      return result;
    } finally {
      sink.release();
    }
  }

  /**
   * Fail before opening a run directory.
   *
   * These three refusals — no such capability, not approved, bad parameters —
   * happen before anything touches the surface, and giving them an evidence
   * directory would fill `evidence/` with runs in which nothing ran. The result
   * still carries a `RunRef` because the contract requires one; it names a run
   * that deliberately does not exist, which is honest, and the `detail` says why.
   */
  async #refuseBeforeStarting(
    request: ReplayRequest,
    capability: Capability | null,
    failure: FailureDetail,
  ): Promise<ReplayResult> {
    const at = this.#now().toISOString();
    return {
      kind: 'failure',
      capabilityId: request.capabilityId,
      capabilityVersion: capability?.version ?? '0.0.0',
      tenant: request.tenant,
      evidence: { runId: '(not started)', path: '(no run directory: rejected before execution)' },
      stats: {
        startedAt: at,
        durationMs: 0,
        stepsExecuted: 0,
        stepsTotal: capability?.steps.length ?? 0,
        recoveriesPerformed: 0,
        llmCalls: 0,
      },
      steps: [],
      failure,
    };
  }

  /**
   * This run's redactor, told which exact strings it is protecting.
   *
   * Same reasoning as discovery: the pattern recognizers are deliberately
   * conservative, and a bare five-digit member id is indistinguishable from a
   * postcode. Exact-match on the values this invocation was handed closes that
   * gap without widening a single pattern, and it matters more in replay than in
   * discovery — a parameter is echoed back by the application on nearly every
   * screen the flow visits.
   */
  #redactorFor(capability: Capability, values: ReadonlyMap<string, string>): DefaultRedactor {
    const known = new Map<string, Sensitivity>();
    for (const [name, value] of values) {
      const classification = capability.sensitivity[name];
      if (classification !== undefined && classification !== 'none') known.set(value, classification);
    }
    return this.#redactor.withKnownValues(known);
  }

  #entryUrl(capability: Capability): string {
    return new URL(capability.surface.entryPoint, this.#o.origin).toString();
  }
}

// -----------------------------------------------------------------------------
// One invocation's mutable state
// -----------------------------------------------------------------------------

/**
 * A trace event minus the timestamp, which `#note` supplies.
 *
 * Distributive, so each arm of the union keeps its own required fields: an
 * `Omit` applied to the union as a whole would collapse to the keys they share
 * and let a malformed event through.
 */
type Noted = TraceEvent extends infer E ? (E extends { at: string } ? Omit<E, 'at'> : never) : never;

/** What a step asked the driver loop to do next. */
type Advance =
  | { readonly kind: 'next' }
  /** After a recovery that moved the application: restart the cursor here. */
  | { readonly kind: 'resume'; readonly at: number }
  | { readonly kind: 'terminal'; readonly result: ReplayResult };

/** What `#settle` concluded about the screen. */
type Settled =
  | { readonly kind: 'passed'; readonly assertion: AssertionResult | null }
  | { readonly kind: 'outcome'; readonly outcome: BusinessOutcome }
  | { readonly kind: 'dialog'; readonly message: string }
  | { readonly kind: 'session_expired' }
  | { readonly kind: 'checkpoint_failed'; readonly assertion: AssertionResult };

class Run {
  readonly #o: ReplayEngineOptions;
  readonly #redactor: DefaultRedactor;
  readonly #now: () => Date;
  readonly #request: ReplayRequest;
  readonly #capability: Capability;
  readonly #values: ReadonlyMap<string, string>;
  readonly #writer: FileEvidenceWriter;
  readonly #sink: EvidenceSink;
  readonly #startedAt: string;
  readonly #startedMs: number;

  readonly #records: StepRecord[] = [];
  readonly #outputs: Record<string, unknown> = {};
  readonly #passed = new Set<string>();
  /** Recovery attempts already spent, keyed `stepId:condition`. */
  readonly #attempts = new Map<string, number>();
  #recoveries = 0;
  #reauthUsed = false;
  #location: string;

  constructor(
    options: ReplayEngineOptions,
    redactor: DefaultRedactor,
    now: () => Date,
    request: ReplayRequest,
    capability: Capability,
    values: ReadonlyMap<string, string>,
    writer: FileEvidenceWriter,
    sink: EvidenceSink,
    startedAt: string,
  ) {
    this.#o = options;
    this.#redactor = redactor;
    this.#now = now;
    this.#request = request;
    this.#capability = capability;
    this.#values = values;
    this.#writer = writer;
    this.#sink = sink;
    this.#startedAt = startedAt;
    this.#startedMs = now().getTime();
    this.#location = new URL(capability.surface.entryPoint, options.origin).toString();
  }

  /**
   * Run the flow, from the entry point or from wherever a human left it.
   *
   * `resumeInPlace` is what a hand-back means. A human who took over may have
   * advanced the flow several screens — that is usually *why* they took over —
   * so re-navigating to the entry point would throw their work away and, worse,
   * would re-perform steps they have already performed by hand. Instead the
   * screen is asked where we are: `#resumePoint` walks the checkpoints and stops
   * at the first one that is not yet true. This is I7's rule and it is the same
   * code path re-authentication uses, which is the reason it was written there
   * rather than here.
   */
  async execute(resumeInPlace = false): Promise<ReplayResult> {
    if (!resumeInPlace) {
      const entered = await this.#enter();
      if (entered !== null) return entered;
    }

    const steps = this.#capability.steps;
    let cursor = resumeInPlace ? await this.#resumePoint() : 0;

    if (resumeInPlace) {
      await this.#note({
        event: 'control_transferred',
        from: 'operator',
        to: 'automation',
        reason:
          `resuming at ${steps[cursor]?.id ?? '(the end — every checkpoint already holds)'}, ` +
          `the first step whose checkpoint is not yet true`,
      });
    }

    while (cursor < steps.length) {
      if (this.#elapsed() >= this.#request.deadlineMs) {
        return await this.#fail({
          class: 'STEP_TIMEOUT',
          stepId: steps[cursor]?.id ?? null,
          expected: `the whole flow within ${this.#request.deadlineMs}ms`,
          observed: `still on step ${cursor + 1} of ${steps.length} after ${this.#elapsed()}ms`,
          detail: null,
        });
      }

      const step = steps[cursor];
      if (step === undefined) break;

      const advance = await this.#runStep(step, cursor);
      if (advance.kind === 'terminal') return advance.result;
      cursor = advance.kind === 'resume' ? advance.at : cursor + 1;
    }

    return await this.#conclude();
  }

  // ---------------------------------------------------------------------------
  // Entry
  // ---------------------------------------------------------------------------

  /**
   * Navigate to the entry point, through the policy engine like anything else.
   *
   * The session handed to this engine is usually already signed in and already
   * looking at this screen, so the navigation is often a no-op — and it happens
   * anyway, for two reasons. It is what makes every replay of the same artifact
   * start from the same screen, which is a precondition for the determinism
   * claim rather than a nicety; and skipping the policy check on the grounds
   * that it is "just setup" is exactly the bypass path I4 exists to forbid.
   */
  async #enter(): Promise<ReplayResult | null> {
    const url = new URL(this.#capability.surface.entryPoint, this.#o.origin).toString();
    const decision = this.#evaluate('navigate', 'safe', url, null, 0);
    await this.#note({ event: 'policy_evaluated', action: 'navigate', decision });

    if (decision.kind !== 'allow') {
      return await this.#fail({
        class: 'POLICY_DENIED',
        stepId: null,
        expected: `permission to open ${url}`,
        observed: describe(decision),
        detail: null,
      });
    }

    const result = await this.#o.driver.perform({ type: 'navigate', to: url }, null);
    if (!result.ok) {
      return await this.#fail({
        class: 'SURFACE_ERROR',
        stepId: null,
        expected: `the entry point ${url} to load`,
        observed: result.detail ?? 'the driver could not open it',
        detail: null,
      });
    }
    this.#location = url;
    return null;
  }

  // ---------------------------------------------------------------------------
  // One step
  // ---------------------------------------------------------------------------

  async #runStep(step: Step, index: number): Promise<Advance> {
    this.#sink.prefix = `step-${String(index + 1).padStart(2, '0')}-${step.id}`;
    const startedAt = this.#iso();
    const startedMs = this.#now().getTime();

    // Observed first, for three things at once: the location the policy engine
    // is about to judge, a fresh element tree for the resolver to work against,
    // and the screenshot that makes this step reconstructable.
    const before = await this.#observe();
    this.#location = before.location;

    const location = step.action.type === 'navigate' ? step.action.to : before.location;
    const decision = this.#evaluate(step.action.type, step.risk, location, step.id, index);
    await this.#note({ event: 'policy_evaluated', action: step.action.type, decision });

    if (decision.kind === 'deny') {
      this.#record(step, startedAt, startedMs, { status: 'failed' });
      return terminal(
        await this.#fail({
          class: 'POLICY_DENIED',
          stepId: step.id,
          expected: `permission to ${step.action.type} at ${location}`,
          observed: describe(decision),
          detail: null,
        }),
      );
    }

    if (decision.kind === 'require_confirmation') {
      this.#record(step, startedAt, startedMs, { status: 'failed' });
      return terminal(
        await this.#escalate('policy_requires_confirmation', step, describe(decision)),
      );
    }

    // ---- find the control -----------------------------------------------
    let ref: string | null = null;
    let resolution: Resolution | null = null;

    if (step.target !== null) {
      resolution = await this.#locate(step);
      await this.#note({ event: 'resolved', stepId: step.id,
        status: resolution.status,
        matchedBy: resolution.matchedBy,
        agreement: resolution.agreement, });

      if (resolution.status !== 'unique' || resolution.ref === null) {
        const reason = STUCK_FOR_RESOLUTION[resolution.status];
        this.#record(step, startedAt, startedMs, { status: 'failed', resolution });
        if (step.optional) return { kind: 'next' };
        return terminal(
          await this.#escalate(
            reason,
            step,
            `expected a unique ${step.target.expectedRole ?? 'element'} ` +
              `named '${step.target.expectedName ?? '(unnamed)'}'; ` +
              `${resolution.tried.length} locator candidate(s) resolved ${resolution.status} ` +
              `with agreement ${resolution.agreement.toFixed(2)}`,
          ),
        );
      }
      ref = resolution.ref;
    }

    // ---- substitute and act ---------------------------------------------
    const bound = this.#substitute(step.action);
    if (!bound.ok) {
      this.#record(step, startedAt, startedMs, { status: 'failed', resolution });
      return terminal(
        await this.#fail({
          class: 'INPUT_INVALID',
          stepId: step.id,
          expected: 'every referenced parameter to be supplied',
          observed: bound.error,
          detail: null,
        }),
      );
    }

    const actedMs = this.#now().getTime();
    const performed = await this.#o.driver.perform(bound.action, ref);
    await this.#note({ event: 'acted', stepId: step.id,
      action: step.action.type,
      ok: performed.ok,
      durationMs: Math.max(0, this.#now().getTime() - actedMs), });

    if (step.action.type === 'extract') {
      const name = refProperty(step.action.into);
      if (!performed.ok || performed.extracted === null) {
        this.#record(step, startedAt, startedMs, { status: 'failed', resolution });
        if (step.optional) return { kind: 'next' };
        return terminal(
          await this.#fail({
            class: 'OUTPUT_EXTRACTION_FAILED',
            stepId: step.id,
            expected: `a ${step.action.as} value for '${name}'`,
            observed: performed.detail ?? 'the element produced nothing readable',
            detail: null,
          }),
        );
      }
      // The caller gets the value; the evidence directory gets the redaction.
      // Both are correct — reading the balance is the point of the call, and
      // writing it to disk is the thing I3 forbids.
      this.#outputs[name] = performed.extracted;
    } else if (!performed.ok) {
      this.#record(step, startedAt, startedMs, { status: 'failed', resolution });
      if (step.optional) return { kind: 'next' };
      return terminal(
        await this.#fail({
          class: 'SURFACE_ERROR',
          stepId: step.id,
          expected: `the ${step.action.type} to be accepted`,
          observed: performed.detail ?? 'the driver reported a failure with no detail',
          detail: null,
        }),
      );
    }

    // ---- work out what the screen became ---------------------------------
    return await this.#verify(step, index, startedAt, startedMs, resolution);
  }

  /**
   * Settle, and recover, until the step is done or out of options.
   *
   * The recovery attempts accumulate onto the step's record rather than being
   * logged and forgotten, because "this step needed two retries every time" is
   * the earliest available signal that an artifact is going stale — long before
   * it starts failing.
   */
  async #verify(
    step: Step,
    index: number,
    startedAt: string,
    startedMs: number,
    resolution: Resolution | null,
  ): Promise<Advance> {
    const recoveries: RecoveryAttempt[] = [];

    for (;;) {
      const settled = await this.#settle(step);

      if (settled.kind === 'passed') {
        if (settled.assertion !== null && step.checkpoint !== null) {
          this.#passed.add(step.checkpoint.id);
          await this.#note({ event: 'checkpoint_evaluated', checkpointId: step.checkpoint.id,
            passed: true,
            expected: settled.assertion.expected,
            observed: settled.assertion.observed,
            waitedMs: settled.assertion.waitedMs, });
        }
        this.#record(step, startedAt, startedMs, {
          status: 'ok',
          resolution,
          checkpointPassed: step.checkpoint === null ? null : true,
          recoveries,
        });
        return { kind: 'next' };
      }

      if (settled.kind === 'outcome') {
        this.#record(step, startedAt, startedMs, {
          status: 'ok',
          resolution,
          checkpointPassed: step.checkpoint === null ? null : false,
          recoveries,
        });
        return terminal(await this.#outcome(settled.outcome));
      }

      const attempted = await this.#recover(step, settled, recoveries);
      if (attempted.kind === 'retry') continue;
      if (attempted.kind === 'resume') {
        this.#record(step, startedAt, startedMs, { status: 'skipped', resolution, recoveries });
        return { kind: 'resume', at: attempted.at };
      }

      // Out of recoveries. Report what the screen actually was.
      this.#record(step, startedAt, startedMs, {
        status: step.optional ? 'skipped' : 'failed',
        resolution,
        checkpointPassed: step.checkpoint === null ? null : false,
        recoveries,
      });
      if (step.optional) return { kind: 'next' };

      if (settled.kind === 'session_expired') {
        // Deliberately a failure and never an escalation: handing a human a
        // session that has already died gives them nothing to take over.
        return terminal(
          await this.#fail({
            class: 'SESSION_UNRECOVERABLE',
            stepId: step.id,
            expected: 'a live signed-on session',
            observed: 'the application returned to sign-on',
            detail: this.#o.reauthenticate
              ? 're-authentication was attempted and did not restore the flow'
              : 'no re-authentication was configured for this deployment',
          }),
        );
      }

      const assertion =
        settled.kind === 'checkpoint_failed'
          ? settled.assertion
          : { passed: false, expected: 'no blocking dialog', observed: settled.message, waitedMs: 0 };

      if (step.checkpoint !== null) {
        await this.#note({ event: 'checkpoint_evaluated', checkpointId: step.checkpoint.id,
          passed: false,
          expected: assertion.expected,
          observed: assertion.observed,
          waitedMs: assertion.waitedMs, });
      }

      return terminal(
        await this.#fail({
          class: 'CHECKPOINT_FAILED',
          stepId: step.id,
          expected: assertion.expected,
          observed: assertion.observed,
          detail: `after step '${step.intent}'`,
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // The state table
  // ---------------------------------------------------------------------------

  /**
   * Wait for the screen to become one of the states we know about.
   *
   * This is the only place replay waits, and it always waits *on a condition*.
   * There is no sleep here and none anywhere else in the engine, which is what
   * makes a run's result independent of how loaded the machine is — the
   * definition of determinism this system is claiming.
   *
   * A step with no checkpoint still passes through, for one round: a declared
   * business outcome can fire on any screen, and skipping the scan on
   * checkpoint-less steps would mean a flow whose last step is an `extract`
   * could read a value off the not-authorized page.
   */
  async #settle(step: Step): Promise<Settled> {
    const outcomes = this.#capability.businessOutcomes;
    const budget = step.checkpoint?.timeoutMs ?? 0;
    const started = this.#now().getTime();
    let last: AssertionResult | null = null;

    for (;;) {
      const dialog = await this.#dialogMessage();
      if (dialog !== null) return { kind: 'dialog', message: dialog };

      for (const outcome of outcomes) {
        if ((await this.#oneShot(outcome.detect)).passed) return { kind: 'outcome', outcome };
      }

      if (step.checkpoint === null) return { kind: 'passed', assertion: null };

      last = await this.#oneShot(step.checkpoint);
      const waited = this.#now().getTime() - started;
      if (last.passed) return { kind: 'passed', assertion: { ...last, waitedMs: waited } };
      if (waited >= budget) {
        last = { ...last, waitedMs: waited };
        break;
      }

      await this.#pause(POLL_MS);
    }

    if (this.#o.sessionProbe && (await this.#oneShot(this.#o.sessionProbe)).passed) {
      return { kind: 'session_expired' };
    }

    return {
      kind: 'checkpoint_failed',
      assertion: last ?? {
        passed: false,
        expected: step.checkpoint?.value ?? '(no checkpoint)',
        observed: '(never evaluated)',
        waitedMs: 0,
      },
    };
  }

  /**
   * Apply the step's recovery rules to whatever `#settle` found.
   *
   * The rules are closed by schema and the handling is closed here: a condition
   * with no rule is not recovered from, and a rule whose action cannot address
   * its condition is not attempted. "Try something" is how automation reaches a
   * state nobody can reconstruct.
   */
  async #recover(
    step: Step,
    settled: Settled,
    into: RecoveryAttempt[],
  ): Promise<{ kind: 'retry' } | { kind: 'resume'; at: number } | { kind: 'give_up' }> {
    const condition: RecoverableCondition | null =
      settled.kind === 'dialog'
        ? 'unexpected_dialog'
        : settled.kind === 'session_expired'
          ? 'session_expired'
          : settled.kind === 'checkpoint_failed'
            ? 'transient_load'
            : null;
    if (condition === null) return { kind: 'give_up' };

    // Session expiry is recovered outside the step's rule list, because the
    // remedy is not a property of the step: a compiler that watched a run in
    // which the session never died has no basis for emitting the rule, and a
    // deployment that cannot re-authenticate has no business claiming it.
    if (condition === 'session_expired') {
      if (this.#o.reauthenticate === undefined || this.#reauthUsed) return { kind: 'give_up' };
      this.#reauthUsed = true;
      const ok = await this.#o.reauthenticate();
      const attempt = this.#spend(step, condition);
      into.push({ condition, took: 'reauthenticate', attempt, succeeded: ok });
      await this.#noteRecovery(step, condition, 'reauthenticate', attempt, ok);
      if (!ok) return { kind: 'give_up' };
      this.#recoveries += 1;
      return { kind: 'resume', at: await this.#resumePoint() };
    }

    const rule = step.recover.find((r) => r.on === condition);
    if (rule === undefined) return { kind: 'give_up' };

    const attempt = this.#spend(step, condition);
    if (attempt > rule.maxAttempts) return { kind: 'give_up' };

    switch (rule.do) {
      case 'dismiss_dialog': {
        if (condition !== 'unexpected_dialog') return { kind: 'give_up' };
        // I4 applies to a recovery like any other action, and this one is not
        // decoration: the dialog is dismissed rather than accepted, because
        // accepting means answering "yes" to a question nobody read.
        const decision = this.#evaluate('dismiss_dialog', 'safe', this.#location, step.id, 0);
        await this.#note({ event: 'policy_evaluated', action: 'dismiss_dialog', decision });
        if (decision.kind !== 'allow') return { kind: 'give_up' };

        const done = await this.#o.driver.perform({ type: 'dismiss_dialog', accept: false }, null);
        into.push({ condition, took: 'dismiss_dialog', attempt, succeeded: done.ok });
        await this.#noteRecovery(step, condition, 'dismiss_dialog', attempt, done.ok);
        if (!done.ok) return { kind: 'give_up' };
        this.#recoveries += 1;
        return { kind: 'retry' };
      }

      case 'wait_retry': {
        // Waiting again, and NOT re-performing the action. The distinction is
        // the whole safety of this rule: `#settle` has already spent the
        // checkpoint's budget on a condition that may simply be slow, whereas
        // repeating the action that got us here is how one transfer becomes two.
        into.push({ condition, took: 'wait_retry', attempt, succeeded: true });
        await this.#noteRecovery(step, condition, 'wait_retry', attempt, true);
        this.#recoveries += 1;
        return { kind: 'retry' };
      }

      // Designed, deliberately not implemented, and listed so the switch stays
      // total. `scroll_into_view` addresses a resolution problem and would have
      // to run before the element is found, not after; `reload_and_resume` on a
      // legacy application means re-POSTing whatever got us here. Both are in
      // REPORT.md §7.
      case 'scroll_into_view':
      case 'reload_and_resume':
      case 'reauthenticate':
        return { kind: 'give_up' };
    }
  }

  /**
   * Where to pick the flow up after control was lost and regained.
   *
   * I7's rule, applied to re-authentication rather than to a human takeover, and
   * implemented once so the handoff layer inherits it: we do not resume at the
   * step index we happened to stop at, we resume at the first step whose
   * *precondition is not yet true*. The screen is the authority on where we are;
   * the cursor is only a memory of where we were.
   */
  async #resumePoint(): Promise<number> {
    this.#passed.clear();
    let at = 0;
    for (const [index, step] of this.#capability.steps.entries()) {
      if (step.checkpoint === null) continue;
      if (!(await this.#oneShot(step.checkpoint)).passed) break;
      this.#passed.add(step.checkpoint.id);
      at = index + 1;
    }
    return at;
  }

  /**
   * Resolve a target, polling until it settles or the step's share runs out.
   *
   * `not_found` is worth waiting on — a control that has not rendered yet looks
   * exactly like one that is gone. `ambiguous` and `disagreement` are not:
   * neither improves with time, and `disagreement` in particular means two
   * independent locators are pointing at *different live controls*, where acting
   * on the winner risks acting on the wrong one. That is the case where stopping
   * is strictly better than succeeding.
   */
  async #locate(step: Step): Promise<Resolution> {
    const target = step.target;
    if (target === null) throw new Error(`step ${step.id} has no target`);

    const budget = Math.round(step.timeoutMs * RESOLVE_SHARE);
    const started = this.#now().getTime();
    let last = await this.#o.driver.resolve(target);

    while (last.status === 'not_found' && this.#now().getTime() - started < budget) {
      await this.#pause(POLL_MS);
      // Re-observe: `resolve` works against the driver's latest tree, and a
      // control that appears after a slow load appears in a later one.
      await this.#o.driver.observe();
      last = await this.#o.driver.resolve(target);
    }
    return last;
  }

  // ---------------------------------------------------------------------------
  // Terminal results
  // ---------------------------------------------------------------------------

  /**
   * Every checkpoint the artifact promised held, and every required output has a
   * value. Anything less is reported as the specific thing that was missing.
   */
  async #conclude(): Promise<ReplayResult> {
    const missing = this.#capability.successCondition.checkpoints.filter((id) => !this.#passed.has(id));
    if (missing.length > 0) {
      return await this.#fail({
        class: 'CHECKPOINT_FAILED',
        stepId: null,
        expected: `checkpoints ${missing.join(', ')} to have passed`,
        observed: `they did not; passed: ${[...this.#passed].join(', ') || '(none)'}`,
        detail: 'the flow ran to the end without arriving where the artifact promised',
      });
    }

    const absent = this.#capability.successCondition.requiredOutputs.filter(
      (name) => this.#outputs[name] === undefined || this.#outputs[name] === null,
    );
    if (absent.length > 0) {
      return await this.#fail({
        class: 'OUTPUT_EXTRACTION_FAILED',
        stepId: null,
        expected: `values for ${absent.join(', ')}`,
        observed: 'the flow completed without producing them',
        detail: null,
      });
    }

    const result: ReplayResult = {
      kind: 'success',
      ...this.#base(),
      outputs: { ...this.#outputs },
    };
    await this.#finish('success', result);
    return result;
  }

  /** I2: a declared outcome is a successful invocation with a different answer. */
  async #outcome(outcome: BusinessOutcome): Promise<ReplayResult> {
    await this.#note({ event: 'business_outcome', code: outcome.code, message: outcome.description });
    const result: ReplayResult = {
      kind: 'outcome',
      ...this.#base(),
      code: outcome.code,
      message: outcome.description,
      retryable: outcome.retryable,
      // Whatever was legitimately readable before the outcome fired. Usually
      // nothing, and deliberately not suppressed when it is not.
      outputs: { ...this.#outputs },
    };
    await this.#finish('outcome', result);
    return result;
  }

  async #fail(failure: FailureDetail): Promise<ReplayResult> {
    const captured = await this.#capture();
    const redacted: FailureDetail = {
      ...failure,
      expected: this.#redactor.redactText(failure.expected).text,
      observed: this.#redactor.redactText(failure.observed).text,
      detail: failure.detail === null ? null : this.#redactor.redactText(failure.detail).text,
    };

    await this.#note({ event: 'failed', class: redacted.class,
      stepId: redacted.stepId,
      expected: redacted.expected,
      observed: redacted.observed,
      screenshotRef: captured.screenshotRef,
      snapshotRef: captured.snapshotRef, });

    const result: ReplayResult = { kind: 'failure', ...this.#base(), failure: redacted };
    await this.#finish('failure', result);
    return result;
  }

  /**
   * Stop and ask for a person, keeping the session alive.
   *
   * The order matters and is the substance of I7: pause the automation, cede the
   * lease, *then* publish the intervention. Publishing first would advertise a
   * session that automation might still be touching when the operator arrives.
   * Nothing here closes the browser context — the whole value of the handoff is
   * that the human gets the session with its cookies and its half-filled form,
   * not a fresh one.
   *
   * With no handoff configured this degrades to the equivalent failure, because
   * a run that cannot reach a human must not return a promise nobody will keep.
   */
  async #escalate(reason: StuckReason, step: Step | null, explanation: string): Promise<ReplayResult> {
    const captured = await this.#capture();
    const detail = this.#redactor.redactText(explanation).text;
    const resumeFrom = this.#lastPassedCheckpoint();

    if (this.#o.handoff === undefined) {
      return await this.#fail({
        class: STUCK_TO_FAILURE[reason],
        stepId: step?.id ?? null,
        expected: step === null ? 'a state the artifact describes' : step.intent,
        observed: detail,
        detail: 'no handoff coordinator is configured; escalation degraded to a failure',
      });
    }

    await this.#o.driver.pause();
    const lease = await this.#o.handoff.cede(this.#o.driver.sessionEndpoint(), reason);
    await this.#note({ event: 'control_transferred', from: 'automation',
      to: lease.holder,
      reason, });

    const intervention = await this.#o.handoff.raise({
      runId: this.#writer.runId,
      capabilityId: this.#capability.id,
      goal: null,
      stepId: step?.id ?? null,
      stepIntent: step?.intent ?? null,
      reason,
      explanation: detail,
      screenshotRef: captured.screenshotRef,
      observationRef: captured.snapshotRef,
      evidence: this.#writer.ref,
      resumeFrom,
    });

    await this.#note({ event: 'escalated', interventionId: intervention.id, reason });

    const result: ReplayResult = {
      kind: 'escalated',
      ...this.#base(),
      interventionId: intervention.id,
      reason,
      resumeFrom,
    };
    await this.#finish('escalated', result);
    return result;
  }

  #lastPassedCheckpoint(): string | null {
    let found: string | null = null;
    for (const step of this.#capability.steps) {
      if (step.checkpoint !== null && this.#passed.has(step.checkpoint.id)) found = step.checkpoint.id;
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  /**
   * Bind a step's value reference to the caller's parameter.
   *
   * The substituted string exists only inside the returned `Action` and lives
   * exactly as long as the driver call. Nothing built here is written anywhere;
   * the artifact keeps the reference and the evidence keeps the redaction.
   */
  #substitute(action: Step['action']): { ok: true; action: Action } | { ok: false; error: string } {
    if (action.type !== 'type' && action.type !== 'select') return { ok: true, action };
    if (action.value.from === 'literal') return { ok: true, action };

    const name = refProperty(action.value.ref);
    const value = this.#values.get(name);
    if (value === undefined) {
      return { ok: false, error: `step references '${action.value.ref}', which was not supplied` };
    }
    return {
      ok: true,
      action:
        action.type === 'type'
          ? { type: 'type', value: { from: 'literal', value }, clearFirst: action.clearFirst }
          : { type: 'select', value: { from: 'literal', value } },
    };
  }

  #evaluate(
    action: Action['type'],
    risk: Step['risk'],
    location: string,
    stepId: string | null,
    stepIndex: number,
  ): PolicyDecision {
    return this.#o.policy.evaluate({
      principal: {
        kind: 'calling-agent',
        id: this.#o.principalId ?? 'replay',
        tenant: this.#request.tenant,
      },
      phase: 'replay',
      capabilityId: this.#capability.id,
      stepId,
      action,
      risk,
      location,
      stepIndex,
    });
  }

  async #oneShot(checkpoint: Checkpoint): Promise<AssertionResult> {
    return await this.#o.driver.check({ ...checkpoint, timeoutMs: ONE_SHOT_MS });
  }

  /**
   * A blocking modal, if there is one.
   *
   * Detected as an `alertdialog` node in the tree rather than through any
   * browser-specific channel, which is deliberate: a desktop driver reporting a
   * modal window produces the same shape, so this branch stays above the seam.
   */
  async #dialogMessage(): Promise<string | null> {
    const observation = await this.#o.driver.observe();
    const found = findRole(observation.root, 'alertdialog');
    return found === null ? null : (found.name ?? '(a dialog with no message)');
  }

  async #observe(): Promise<Observation> {
    const observation = await this.#o.driver.observe({ withScreenshot: true });
    await this.#note({ event: 'observed', location: observation.location,
      digest: observation.digest,
      nodeCount: countNodes(observation.root),
      truncated: observation.truncated,
      screenshotRef: observation.screenshotRef, });
    return observation;
  }

  async #capture(): Promise<{ screenshotRef: string | null; snapshotRef: string | null }> {
    this.#sink.prefix = 'outcome';
    try {
      return await this.#o.driver.captureEvidence();
    } catch {
      // Evidence capture must never be what ends a run: we are already reporting
      // one problem and a second one would replace it in the caller's hands.
      return { screenshotRef: null, snapshotRef: null };
    }
  }

  #record(
    step: Step,
    startedAt: string,
    startedMs: number,
    detail: {
      status: StepRecord['status'];
      resolution?: Resolution | null;
      checkpointPassed?: boolean | null;
      recoveries?: readonly RecoveryAttempt[];
    },
  ): void {
    const resolution = detail.resolution ?? null;
    this.#records.push({
      stepId: step.id,
      intent: step.intent,
      startedAt,
      durationMs: Math.max(0, this.#now().getTime() - startedMs),
      resolution: resolution?.status ?? null,
      matchedBy: resolution?.matchedBy ?? null,
      agreement: resolution?.agreement ?? null,
      checkpointPassed: detail.checkpointPassed ?? null,
      recoveries: [...(detail.recoveries ?? [])],
      status: detail.status,
      screenshotRef: null,
    });
  }

  #spend(step: Step, condition: RecoverableCondition): number {
    const key = `${step.id}:${condition}`;
    const next = (this.#attempts.get(key) ?? 0) + 1;
    this.#attempts.set(key, next);
    return next;
  }

  async #noteRecovery(
    step: Step,
    condition: RecoverableCondition,
    took: string,
    attempt: number,
    succeeded: boolean,
  ): Promise<void> {
    await this.#note({ event: 'recovery_attempted', stepId: step.id,
      condition,
      took,
      attempt,
      succeeded, });
  }

  #base(): Omit<Extract<ReplayResult, { kind: 'failure' }>, 'kind' | 'failure'> {
    return {
      capabilityId: this.#capability.id,
      capabilityVersion: this.#capability.version,
      tenant: this.#request.tenant,
      evidence: this.#writer.ref,
      stats: this.#stats(),
      steps: [...this.#records],
    };
  }

  #stats(): ReplayStats {
    return {
      startedAt: this.#startedAt,
      durationMs: this.#elapsed(),
      stepsExecuted: this.#records.filter((r) => r.status === 'ok').length,
      stepsTotal: this.#capability.steps.length,
      recoveriesPerformed: this.#recoveries,
      llmCalls: 0,
    };
  }

  async #finish(
    outcome: 'success' | 'outcome' | 'failure' | 'escalated',
    result: ReplayResult,
  ): Promise<void> {
    await this.#note({ event: 'run_finished', outcome, durationMs: this.#elapsed() });
    await this.#writer.finalize(result, this.#iso());
  }

  /** Append a trace event, filling in the timestamp every one of them needs. */
  async #note(event: Noted): Promise<void> {
    await this.#writer.append({ ...event, at: this.#iso() } as TraceEvent);
  }

  /**
   * The one timer in the engine, and it is a poll interval rather than a wait
   * for anything to happen. Every condition is still evaluated by looking.
   */
  async #pause(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  #elapsed(): number {
    return Math.max(0, this.#now().getTime() - this.#startedMs);
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

// -----------------------------------------------------------------------------

/** Which stuck reason a non-unique resolution corresponds to. */
const STUCK_FOR_RESOLUTION: Readonly<Record<Resolution['status'], StuckReason>> = {
  unique: 'unknown_state',
  not_found: 'locator_unresolved',
  ambiguous: 'locator_ambiguous',
  disagreement: 'locator_disagreement',
};

function terminal(result: ReplayResult): Advance {
  return { kind: 'terminal', result };
}

function describe(decision: PolicyDecision): string {
  return decision.kind === 'allow' ? 'allowed' : `${decision.rule}: ${decision.reason}`;
}

function findRole(node: A11yNode, role: string): A11yNode | null {
  if (node.role === role) return node;
  for (const child of node.children) {
    const found = findRole(child, role);
    if (found !== null) return found;
  }
  return null;
}

function countNodes(node: A11yNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}
