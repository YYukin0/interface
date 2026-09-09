import {
  SCHEMA_VERSION,
  type A11yNode,
  type Action,
  type AgentAction,
  type DiscoveryRequest,
  type DiscoveryResult,
  type DiscoveryRunner,
  type DiscoveryStats,
  type Observation,
  type PolicyDecision,
  type PolicyEngine,
  type RecordedStep,
  type RecordedValue,
  type RiskClass,
  type Sensitivity,
  type StopReason,
  type SurfaceDriver,
  type Target,
  toRecordedAction,
} from '@cua/contracts';
import { FileEvidenceWriter, RecordingWriter, newRunId, type EvidenceSink } from '@cua/evidence';
import { DefaultRedactor, atSink } from '@cua/redact';

import type { DecisionModel } from './model.js';
import { systemPrompt, turnPrompt, type HistoryEntry } from './prompt.js';
import { inferRisk, policyActionOf } from './risk.js';
import { landmarks, record, recordExtracted, resolve, sanitiseTarget } from './values.js';

/**
 * =============================================================================
 * THE DISCOVERY LOOP
 * =============================================================================
 * observe → decide → policy → act → record, until the goal, the budget, or the
 * model's own patience runs out.
 *
 * The shape is unremarkable; three details in it are not.
 *
 * 1. THE MODEL IS NEVER THE LAST WORD. Between its decision and the surface sit
 *    a ref check, a value substitution and a policy evaluation, and each of
 *    those can refuse. A refusal is fed back as the next turn's context rather
 *    than raised — a discovery run that crashes because the model asked for
 *    something disallowed has thrown away the twelve steps that were fine.
 *
 * 2. THE BUNDLE IS HARVESTED BEFORE THE ACTION, NOT AFTER. One click can replace
 *    the whole document, and with it every fact about the element that was
 *    clicked. This is the one ordering in the file that cannot be relaxed.
 *
 * 3. STOPPING IS A FIRST-CLASS OUTCOME. `done`, `stuck`, dead end, budget and
 *    deadline all land in `StopReason`, and none of them is an exception. The
 *    brief asks what happens when the agent gets stuck; the answer has to be a
 *    value the caller can switch on, not a stack trace.
 */

/** Consecutive actions with no observable change before we call it a dead end. */
export const DEAD_END_STREAK = 3;

/**
 * Actions whose whole purpose is to move the application somewhere else. Only
 * these count toward a dead end; see `#detectDeadEnd`.
 */
export const ATTEMPTS_TO_MOVE: ReadonlySet<AgentAction['tool']> = new Set([
  'click',
  'double_click',
  'press_key',
  'navigate',
  'dismiss_dialog',
]);

/** Consecutive unusable model replies before we stop asking. */
export const MAX_INVALID_TURNS = 3;

export interface DiscoveryLoopOptions {
  readonly driver: SurfaceDriver;
  readonly model: DecisionModel;
  readonly policy: PolicyEngine;
  /** Late-bound destination for the driver's captures; see sink.ts. */
  readonly sink: EvidenceSink;
  readonly evidenceRoot?: string;
  readonly redactor?: DefaultRedactor;
  /** Identifies the principal in policy decisions and the audit trail. */
  readonly principalId?: string;
  readonly now?: () => Date;
}

export class DiscoveryLoop implements DiscoveryRunner {
  readonly #options: DiscoveryLoopOptions;
  readonly #redactor: DefaultRedactor;
  readonly #now: () => Date;

  constructor(options: DiscoveryLoopOptions) {
    this.#options = options;
    this.#redactor = options.redactor ?? new DefaultRedactor();
    this.#now = options.now ?? (() => new Date());
  }

  async run(request: DiscoveryRequest, values: ReadonlyMap<string, string>): Promise<DiscoveryResult> {
    const run = await this.#open(request, values);
    try {
      return await run.execute(values);
    } finally {
      this.#options.sink.release();
    }
  }

  /**
   * Build this run's redactor, and give it the values it is protecting.
   *
   * Without this the pattern recognizers are on their own, and they are
   * deliberately conservative — a bare `12345` is not treated as a member id
   * because it is equally a postcode or a step count, and redacting every
   * five-digit run would shred the evidence. Exact-match on the values this run
   * was handed closes that gap without widening any pattern: the moment the
   * application echoes a member id back into a field's value, a page heading or
   * an error message, it is caught because we know the string, not because we
   * guessed its shape.
   *
   * The redactor is per-run and derived by copy, so one run cannot learn another
   * run's parameters.
   */
  #redactorFor(request: DiscoveryRequest, values: ReadonlyMap<string, string>): DefaultRedactor {
    const known = new Map<string, Sensitivity>();
    for (const input of request.inputs) {
      const value = values.get(input.name);
      if (value !== undefined && input.classification !== 'none') {
        known.set(value, input.classification);
      }
    }
    return this.#redactor.withKnownValues(known);
  }

  async #open(request: DiscoveryRequest, values: ReadonlyMap<string, string>): Promise<Run> {
    const startedAt = this.#now().toISOString();
    const redactor = this.#redactorFor(request, values);
    const writer = await FileEvidenceWriter.open(
      {
        runId: newRunId('discovery', this.#now()),
        kind: 'discovery',
        startedAt,
        endedAt: null,
        capabilityId: request.proposedId,
        goal: request.goal,
        target: request.entryUrl,
        // Named, not inferred. A discovery artifact whose provenance is a guess
        // is not evidence of anything.
        model: this.#options.model.id,
        schemaVersion: SCHEMA_VERSION,
        gitSha: null,
      },
      { root: this.#options.evidenceRoot ?? 'evidence', redactor },
    );

    this.#options.sink.bind(writer);
    return new Run(this.#options, redactor, this.#now, request, writer, startedAt);
  }
}

// -----------------------------------------------------------------------------
// One run's mutable state, kept off the reusable loop object
// -----------------------------------------------------------------------------

class Run {
  readonly #o: DiscoveryLoopOptions;
  readonly #redactor: DefaultRedactor;
  readonly #now: () => Date;
  readonly #request: DiscoveryRequest;
  readonly #writer: FileEvidenceWriter;
  readonly #recording: RecordingWriter;
  readonly #startedAt: string;
  readonly #startedMs: number;

  readonly #history: HistoryEntry[] = [];
  #turns = 0;
  #actions = 0;
  #modelCalls = 0;
  #tokensIn = 0;
  #tokensOut = 0;
  #denials = 0;
  #invalidStreak = 0;
  #unchangedStreak = 0;
  #lastError: string | null = null;
  #lastTokens = { in: 0, out: 0 };

  constructor(
    options: DiscoveryLoopOptions,
    redactor: DefaultRedactor,
    now: () => Date,
    request: DiscoveryRequest,
    writer: FileEvidenceWriter,
    startedAt: string,
  ) {
    this.#o = options;
    this.#redactor = redactor;
    this.#now = now;
    this.#request = request;
    this.#writer = writer;
    this.#recording = new RecordingWriter(writer.dir);
    this.#startedAt = startedAt;
    this.#startedMs = now().getTime();
  }

  async execute(values: ReadonlyMap<string, string>): Promise<DiscoveryResult> {
    // Written before the first step, so a run that dies early still tells the
    // compiler — and a reader — what it was trying to do.
    await this.#recording.writeRequest(this.#request);

    const entry = await this.#enterAtStart();
    if (entry !== null) return entry;

    while (true) {
      const budget = this.#budgetExceeded();
      if (budget !== null) return await this.#stop(budget, `budget: ${budget}`);

      const observation = await this.#observe();
      const outcome = await this.#step(observation, values);
      if (outcome !== null) return outcome;
    }
  }

  // ---------------------------------------------------------------------------
  // Entry
  // ---------------------------------------------------------------------------

  /**
   * Navigate to the entry point — through the policy engine like anything else.
   *
   * It would be easy to treat this as setup rather than as an action, and that
   * is precisely the bypass path I4 exists to forbid: an entry URL is caller
   * input, and a run that is allowed to start anywhere has no allowlist.
   */
  async #enterAtStart(): Promise<DiscoveryResult | null> {
    const decision = this.#o.policy.evaluate({
      principal: {
        kind: 'discovery-agent',
        id: this.#o.principalId ?? 'discovery',
        tenant: this.#request.tenant,
      },
      phase: 'discovery',
      capabilityId: this.#request.proposedId,
      stepId: null,
      action: 'navigate',
      risk: 'safe',
      location: this.#request.entryUrl,
      stepIndex: 0,
    });

    await this.#writer.append({
      event: 'policy_evaluated',
      at: this.#iso(),
      action: 'navigate',
      decision,
    });

    if (decision.kind !== 'allow') {
      return await this.#stop(
        'policy_blocked',
        `entry point ${this.#request.entryUrl} is not permitted: ${describeDecision(decision)}`,
      );
    }

    const result = await this.#o.driver.perform({ type: 'navigate', to: this.#request.entryUrl }, null);
    if (!result.ok) {
      return await this.#stop('surface_error', result.detail ?? 'could not open the entry point');
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // One turn
  // ---------------------------------------------------------------------------

  async #step(before: Observation, values: ReadonlyMap<string, string>): Promise<DiscoveryResult | null> {
    this.#turns += 1;

    const reply = await this.#ask(before);
    if (reply === null) {
      return this.#invalidStreak >= MAX_INVALID_TURNS
        ? await this.#stop('model_gave_up', this.#lastError ?? 'the model produced no usable action')
        : null;
    }
    const { action, rationale } = reply;

    await this.#writer.append({
      event: 'model_decided',
      at: this.#iso(),
      stepIndex: this.#actions,
      action: policyActionOf(action) ?? 'navigate',
      rationale,
      tokensIn: this.#lastTokens.in,
      tokensOut: this.#lastTokens.out,
    });

    if (action.tool === 'done') {
      return await this.#complete(action.summary);
    }
    if (action.tool === 'stuck') {
      return await this.#escalate(action.reason, action.explanation);
    }

    return await this.#act(action, rationale, before, values);
  }

  /** Ask the model, redacting the prompt on the way out. Null means "try again". */
  async #ask(observation: Observation): Promise<{ action: AgentAction; rationale: string } | null> {
    const raw = turnPrompt({
      goal: this.#request.goal,
      inputs: this.#request.inputs,
      observation,
      history: this.#history,
      stepIndex: this.#actions,
      maxSteps: this.#request.maxSteps,
      lastError: this.#lastError,
    });

    // I3's third sink. The prompt is the one that gets forgotten, because it
    // does not look like storage — but a member's balance in a context window is
    // a member's balance in someone else's infrastructure.
    const { text, found } = this.#redactor.redactText(raw);
    await this.#writer.noteRedactions(atSink(found, 'prompt'));

    this.#modelCalls += 1;
    const reply = await this.#o.model.decide(systemPrompt(), text);
    this.#tokensIn += reply.tokensIn;
    this.#tokensOut += reply.tokensOut;
    this.#lastTokens = { in: reply.tokensIn, out: reply.tokensOut };

    if (reply.call === null) {
      this.#invalidStreak += 1;
      this.#lastError = reply.error ?? 'no action was produced';
      return null;
    }

    this.#invalidStreak = 0;
    this.#lastError = null;
    return reply.call;
  }

  // ---------------------------------------------------------------------------
  // Acting
  // ---------------------------------------------------------------------------

  async #act(
    action: AgentAction,
    rationale: string,
    before: Observation,
    values: ReadonlyMap<string, string>,
  ): Promise<DiscoveryResult | null> {
    const ref = refOf(action);
    const node = ref === null ? null : findNode(before.root, ref);
    if (ref !== null && node === null) {
      return this.#refuse(`ref '${ref}' is not in the observation you were just shown`);
    }

    // `assert` touches nothing; it declares a checkpoint. Recorded, not performed.
    //
    // It still costs a step. Not because it moves the application — it cannot —
    // but because `maxSteps` is a bound on the run, and an action exempt from
    // the budget is an action a confused model can take forever. Counting it
    // also keeps `stats.stepsTaken` equal to the length of the recording, which
    // is what a reader of the evidence assumes without being told.
    if (action.tool === 'assert') {
      this.#actions += 1;
      await this.#recordStep(action, rationale, before, before, null, null, null, true);
      this.#remember(action, rationale, 'noted');
      return null;
    }

    const translated = this.#translate(action, values);
    if (!translated.ok) return this.#refuse(translated.error);

    const risk = inferRisk(action, node);
    const gate = await this.#gate(action, risk, locationFor(action, before.location));
    if (gate !== null) return this.#refuse(gate);

    // Harvested here, before the action, while the element still exists.
    const target = ref === null ? null : await this.#o.driver.harvest(ref);
    if (ref !== null && target === null) {
      return this.#refuse(`ref '${ref}' no longer refers to a live element; observe again`);
    }

    const startedMs = this.#now().getTime();
    const result = await this.#o.driver.perform(translated.action, ref);
    const durationMs = Math.max(0, this.#now().getTime() - startedMs);

    await this.#writer.append({
      event: 'acted',
      at: this.#iso(),
      stepId: null,
      action: translated.action.type,
      ok: result.ok,
      durationMs,
    });

    this.#actions += 1;
    const after = await this.#observe();

    const extracted =
      result.extracted === null ? null : recordExtracted(result.extracted, this.#redactor);

    await this.#recordStep(
      action,
      rationale,
      before,
      after,
      target,
      translated.value,
      extracted,
      result.ok,
    );

    this.#remember(action, rationale, result.ok ? 'ok' : `failed: ${result.detail ?? 'no detail'}`);
    if (!result.ok) this.#lastError = `that action failed: ${result.detail ?? 'no detail given'}`;

    return await this.#detectDeadEnd(action, before, after);
  }

  /**
   * Turn the model's vocabulary into the driver's, substituting parameters.
   *
   * The substituted value exists only inside the returned `Action` and is handed
   * straight to the driver. What goes on disk is the second half of the pair —
   * a `RecordedValue` built from the value's shape, never its content.
   */
  #translate(
    action: AgentAction,
    values: ReadonlyMap<string, string>,
  ): { ok: true; action: Action; value: RecordedValue | null } | { ok: false; error: string } {
    switch (action.tool) {
      case 'click':
      case 'double_click':
      case 'scroll_into_view':
        return { ok: true, action: { type: action.tool }, value: null };

      case 'type': {
        const resolved = resolve(action.text, this.#request.inputs, values);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        return {
          ok: true,
          action: {
            type: 'type',
            value: { from: 'literal', value: resolved.text },
            clearFirst: true,
          },
          value: record(action.text, resolved.text, this.#request.inputs, this.#redactor),
        };
      }

      case 'select': {
        const resolved = resolve(action.option, this.#request.inputs, values);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        return {
          ok: true,
          action: { type: 'select', value: { from: 'literal', value: resolved.text } },
          value: record(action.option, resolved.text, this.#request.inputs, this.#redactor),
        };
      }

      case 'set_checked':
        return { ok: true, action: { type: 'set_checked', checked: action.checked }, value: null };

      case 'press_key':
        return { ok: true, action: { type: 'press_key', key: action.key }, value: null };

      case 'navigate':
        return { ok: true, action: { type: 'navigate', to: action.url }, value: null };

      case 'dismiss_dialog':
        return { ok: true, action: { type: 'dismiss_dialog', accept: action.accept }, value: null };

      case 'extract': {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(action.name)) {
          return {
            ok: false,
            error: `'${action.name}' is not a usable output name; use a plain identifier like 'savingsBalance'`,
          };
        }
        return {
          ok: true,
          action: { type: 'extract', into: `$.outputs.${action.name}`, as: action.as },
          value: null,
        };
      }

      // Handled before translation; listed so the switch stays total.
      case 'assert':
      case 'done':
      case 'stuck':
        return { ok: false, error: `'${action.tool}' is not a surface action` };
    }
  }

  /**
   * The policy gate. Returns null to proceed, or the text to send back.
   *
   * `require_confirmation` is honoured, not swallowed. `allowMutating` lets an
   * operator pre-approve the `mutating` class for an unattended discovery run —
   * and deliberately does not extend to `irreversible`, whatever the policy
   * document says the disposition for that class is. I8 is not a default that a
   * configuration can talk its way past.
   */
  async #gate(action: AgentAction, risk: RiskClass, location: string): Promise<string | null> {
    const actionType = policyActionOf(action);
    if (actionType === null) return null;

    const decision = this.#o.policy.evaluate({
      principal: {
        kind: 'discovery-agent',
        id: this.#o.principalId ?? 'discovery',
        tenant: this.#request.tenant,
      },
      phase: 'discovery',
      capabilityId: this.#request.proposedId,
      stepId: null,
      action: actionType,
      risk,
      location,
      stepIndex: this.#actions,
    });

    await this.#writer.append({
      event: 'policy_evaluated',
      at: this.#iso(),
      action: actionType,
      decision,
    });

    if (decision.kind === 'allow') return null;

    if (decision.kind === 'require_confirmation') {
      if (risk === 'mutating' && this.#request.allowMutating) return null;
      this.#denials += 1;
      return `that action needs human confirmation (${decision.rule}: ${decision.reason}) and this run is unattended. If it is essential to the goal, call stuck(policy_requires_confirmation).`;
    }

    this.#denials += 1;
    return `policy denied that action (${decision.rule}: ${decision.reason}). Find another way, or call stuck if there is none.`;
  }

  /** Record the refusal for the model's next turn without ending the run. */
  #refuse(reason: string): null {
    this.#lastError = reason;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Recording and stopping
  // ---------------------------------------------------------------------------

  async #recordStep(
    action: AgentAction,
    rationale: string,
    before: Observation,
    after: Observation,
    target: Target | null,
    value: RecordedValue | null,
    extracted: RecordedValue | null,
    ok: boolean,
  ): Promise<void> {
    const recorded = toRecordedAction(action);
    if (recorded === null) return;

    const step: RecordedStep = {
      index: this.#history.length,
      at: this.#iso(),
      // The model writes prose, and prose about a screen quotes the screen.
      rationale: this.#redactor.redactText(rationale).text,
      action: recorded,
      target: target === null ? null : sanitiseTarget(target, this.#redactor),
      value,
      risk: inferRisk(action, refOf(action) === null ? null : findNode(before.root, refOf(action) ?? '')),
      locationBefore: before.location,
      locationAfter: after.location,
      digestBefore: before.digest,
      digestAfter: after.digest,
      ok,
      extracted,
      appeared: landmarks(appearedBetween(before.root, after.root), this.#redactor),
    };
    await this.#recording.append(step);
  }

  #remember(action: AgentAction, rationale: string, result: string): void {
    this.#history.push({ action, rationale, result });
  }

  /**
   * Three *attempts to move* that changed nothing means the model is circling.
   *
   * The digest is what makes this cheap and reliable: it hashes the screen's
   * shape with record content and digits removed, so it is stable across two
   * different members' detail pages and changes the moment the screen does. It
   * is also the only progress signal available here — on a `<frameset>` the
   * top-level URL is the same string from sign-on to sign-off.
   *
   * Only activating actions are counted, and that distinction is what keeps the
   * check from firing on correct behaviour. Filling four fields of a form
   * changes nothing observable and is exactly what the model should be doing;
   * `extract` and `assert` are reads by definition. Counting those would make a
   * long form indistinguishable from an agent stuck in a loop. Neutral actions
   * do not reset the streak either — three fruitless clicks interleaved with
   * typing is still three fruitless clicks.
   */
  async #detectDeadEnd(
    action: AgentAction,
    before: Observation,
    after: Observation,
  ): Promise<DiscoveryResult | null> {
    if (!ATTEMPTS_TO_MOVE.has(action.tool)) return null;

    const changed = before.digest !== after.digest || before.location !== after.location;
    this.#unchangedStreak = changed ? 0 : this.#unchangedStreak + 1;
    if (this.#unchangedStreak < DEAD_END_STREAK) return null;
    return await this.#stop(
      'dead_end',
      `${DEAD_END_STREAK} consecutive actions left the screen unchanged`,
    );
  }

  #budgetExceeded(): StopReason | null {
    if (this.#turns >= this.#request.maxSteps) return 'max_steps';
    if (this.#now().getTime() - this.#startedMs >= this.#request.deadlineMs) return 'deadline';
    return null;
  }

  async #observe(): Promise<Observation> {
    this.#o.sink.prefix = `step-${String(this.#turns).padStart(2, '0')}`;
    const observation = await this.#o.driver.observe({ withScreenshot: true });
    await this.#writer.append({
      event: 'observed',
      at: this.#iso(),
      location: observation.location,
      digest: observation.digest,
      nodeCount: countNodes(observation.root),
      truncated: observation.truncated,
      screenshotRef: observation.screenshotRef,
    });
    return observation;
  }

  async #complete(summary: string): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      kind: 'completed',
      summary,
      evidence: this.#writer.ref,
      stats: this.#stats(),
    };
    await this.#finish('success', result);
    return result;
  }

  async #escalate(reason: StuckLike, explanation: string): Promise<DiscoveryResult> {
    const interventionId = `iv-${this.#writer.runId}`;
    await this.#writer.append({
      event: 'escalated',
      at: this.#iso(),
      interventionId,
      reason,
    });
    const result: DiscoveryResult = {
      kind: 'escalated',
      interventionId,
      reason,
      evidence: this.#writer.ref,
      stats: this.#stats(),
    };
    await this.#finish('escalated', { ...result, explanation });
    return result;
  }

  async #stop(reason: StopReason, detail: string): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      kind: 'stopped',
      reason,
      detail,
      evidence: this.#writer.ref,
      stats: this.#stats(),
    };
    await this.#finish('failure', result);
    return result;
  }

  async #finish(outcome: 'success' | 'outcome' | 'failure' | 'escalated', result: unknown): Promise<void> {
    await this.#writer.append({
      event: 'run_finished',
      at: this.#iso(),
      outcome,
      durationMs: this.#elapsed(),
    });
    await this.#writer.finalize(result, this.#iso());
  }

  #stats(): DiscoveryStats {
    return {
      startedAt: this.#startedAt,
      durationMs: this.#elapsed(),
      stepsTaken: this.#actions,
      modelCalls: this.#modelCalls,
      tokensIn: this.#tokensIn,
      tokensOut: this.#tokensOut,
      policyDenials: this.#denials,
    };
  }

  #elapsed(): number {
    return Math.max(0, this.#now().getTime() - this.#startedMs);
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

type StuckLike = Extract<AgentAction, { tool: 'stuck' }>['reason'];

// -----------------------------------------------------------------------------
// Tree helpers
//
// Deliberately re-implemented here rather than imported from `surface-web`.
// Discovery must work against any `SurfaceDriver`, and depending on the web
// driver for four lines of tree walking would drag Playwright into a package
// that has no business knowing what a browser is (I6).
// -----------------------------------------------------------------------------

function refOf(action: AgentAction): string | null {
  return 'ref' in action ? action.ref : null;
}

/**
 * Where the policy engine should think this action lands.
 *
 * For everything except `navigate` that is the current screen. For `navigate` it
 * is the destination, and getting this wrong is not a detail: checking a jump
 * against the page you are jumping *from* means `denyPatterns` and
 * `allowedPathPrefixes` constrain nothing at all, because any page you are
 * already allowed to be on authorises a jump to any page you are not.
 */
function locationFor(action: AgentAction, current: string): string {
  return action.tool === 'navigate' ? action.url : current;
}

function findNode(root: A11yNode, ref: string): A11yNode | null {
  if (root.ref === ref) return root;
  for (const child of root.children) {
    const found = findNode(child, ref);
    if (found !== null) return found;
  }
  return null;
}

function countNodes(root: A11yNode): number {
  return 1 + root.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/**
 * `role:name` pairs the screen gained. Raw material for checkpoint inference.
 *
 * What appeared is a far better "did it work" signal than what vanished: a
 * successful search adds a results table, while a failed one also removes the
 * form. Names are compared verbatim, so this is intentionally noisy — the
 * compiler picks from these, it does not trust them.
 */
function appearedBetween(before: A11yNode, after: A11yNode): string[] {
  const seen = new Set<string>();
  collect(before, seen);
  const gained = new Set<string>();
  const now = new Set<string>();
  collect(after, now);
  for (const key of now) if (!seen.has(key)) gained.add(key);
  return [...gained];
}

function collect(node: A11yNode, into: Set<string>): void {
  if (node.name !== null && node.name.trim().length > 0) {
    into.add(`${node.role}:${node.name.trim()}`);
  }
  for (const child of node.children) collect(child, into);
}

function describeDecision(decision: PolicyDecision): string {
  return decision.kind === 'allow' ? 'allowed' : `${decision.rule}: ${decision.reason}`;
}
