import {
  SCHEMA_VERSION,
  capability,
  type Action,
  type Capability,
  type CapabilityCompiler,
  type Checkpoint,
  type CompileResult,
  type CompileWarning,
  type DiscoveryInput,
  type DiscoveryRequest,
  type RecordedStep,
  type RecoveryRule,
  type RunManifest,
  type RunRef,
  type Step,
  type ValueSource,
} from '@cua/contracts';
import { readManifest, readRecording, readRequest } from '@cua/evidence';
import { DefaultRedactor } from '@cua/redact';

import { inferCheckpoint } from './checkpoints.js';
import { buildContracts } from './contract.js';

/**
 * =============================================================================
 * THE COMPILER
 * =============================================================================
 * `recording.jsonl` → `capability.json`. One expensive model-driven run in, one
 * reviewable, replayable, zero-LLM artifact out.
 *
 * This is a separate program rather than the last few lines of the discovery
 * loop, and that is the point of I5. Two consequences follow, and both are worth
 * having:
 *
 *   THE ARTIFACT IS DECOUPLED FROM THE TRANSCRIPT. Nothing the model said
 *   reaches the capability except through a field this file chose to write.
 *   `provenance.traceRef` points at the run directory; it never inlines it.
 *
 *   COMPILATION IS CHEAP AND REPEATABLE. Improving the checkpoint heuristic does
 *   not cost another discovery run. Every recording ever captured can be
 *   recompiled against the new compiler and diffed, which is the only way to
 *   tell whether the heuristic actually got better.
 *
 * What it does NOT do is decide anything it cannot justify. Every inference —
 * a promoted parameter, a guessed checkpoint, a risk class nobody observed —
 * comes out as a `CompileWarning` pointing at the step that caused it. The
 * output is a `draft`; a human moves it to `approved`, and the schema refuses to
 * record an approval without recording who gave it.
 */

export const COMPILER_VERSION = '0.1.0';

/** Steps whose whole purpose is to move the application to a new screen. */
const MOVES_SCREEN = new Set(['click', 'double_click', 'press_key', 'navigate', 'dismiss_dialog']);

/** Fewer candidates than this and the step has no real fallback. */
const WEAK_BUNDLE = 2;

const STEP_TIMEOUT_MS = 15_000;
const CHECKPOINT_TIMEOUT_MS = 10_000;

interface Warning {
  readonly code: CompileWarning;
  readonly stepId: string | null;
  readonly detail: string;
}

export interface CompilerOptions {
  readonly redactor?: DefaultRedactor;
  /** Version stamped on the emitted capability. */
  readonly version?: string;
}

export class RecordingCompiler implements CapabilityCompiler {
  readonly #redactor: DefaultRedactor;
  readonly #version: string;

  constructor(options: CompilerOptions = {}) {
    this.#redactor = options.redactor ?? new DefaultRedactor();
    this.#version = options.version ?? '1.0.0';
  }

  async compile(evidence: RunRef): Promise<CompileResult> {
    const [manifest, request, recorded] = await Promise.all([
      readManifest(evidence.path),
      readRequest(evidence.path),
      readRecording(evidence.path),
    ]);

    if (request === null) {
      return rejected([
        `${evidence.path} has no request.json; it was produced before the ` +
          `compiler's input contract existed and cannot be compiled`,
      ]);
    }
    if (manifest.kind !== 'discovery') {
      return rejected([`${evidence.path} is a '${manifest.kind}' run, not a discovery run`]);
    }

    return this.#build(evidence, manifest, request, recorded);
  }

  #build(
    evidence: RunRef,
    manifest: RunManifest,
    request: DiscoveryRequest,
    recorded: readonly RecordedStep[],
  ): CompileResult {
    const warnings: Warning[] = [];

    const { kept, dropped } = filterNoise(recorded);
    if (kept.length === 0) {
      return rejected(['the recording contains no successful actions to compile']);
    }
    if (dropped > 0) {
      warnings.push({
        code: 'noise_filtered',
        stepId: null,
        detail: `${dropped} failed or non-acting step(s) were dropped from the flow`,
      });
    }

    const contracts = buildContracts(kept, request.inputs);
    for (const name of contracts.unusedInputs) {
      warnings.push({
        code: 'declared_input_unused',
        stepId: null,
        detail: `parameter '${name}' was declared for the run but no step used it`,
      });
    }

    const steps = this.#steps(kept, request.inputs, contracts.promoted, warnings);
    if (steps.length === 0) {
      return rejected(['no recorded action could be expressed as a capability step']);
    }

    const outputs = Object.keys(contracts.outputs.properties ?? {});
    const checkpoints = steps.flatMap((s) => (s.checkpoint ? [s.checkpoint.id] : []));

    if (checkpoints.length === 0) {
      warnings.push({
        code: 'no_checkpoint_inferred',
        stepId: null,
        detail: 'no step gained a stable landmark; this capability replays unverified',
      });
    }
    // The run saw only the happy path, so it has nothing to say about what a
    // missing member or a denied record looks like. Declaring outcomes from an
    // imagination rather than an observation is exactly the mistake I2 warns
    // about — so the compiler declares none and says so.
    warnings.push({
      code: 'no_business_outcomes_declared',
      stepId: null,
      detail:
        'the run encountered no error states, so no business outcomes were observed; ' +
        'a reviewer should add them, or discovery should be rerun against the ' +
        'not-found and permission-denied cases',
    });

    const draft: Capability = {
      schemaVersion: SCHEMA_VERSION,
      id: request.proposedId ?? derivedId(request.goal),
      version: this.#version,
      displayName: displayNameFor(request.goal),
      description: describeFor(request.goal, Object.keys(contracts.inputs.properties ?? {})),
      inputs: contracts.inputs,
      outputs: contracts.outputs,
      sensitivity: contracts.sensitivity,
      businessOutcomes: [],
      surface: {
        kind: request.surface,
        app: request.app,
        appVersion: null,
        // A path, never the origin the run happened to use: the origin belongs to
        // tenant configuration, and baking `localhost:8080` into the artifact
        // would make it a fixture rather than a capability.
        entryPoint: entryPathOf(request.entryUrl),
      },
      steps,
      successCondition: { checkpoints, requiredOutputs: outputs },
      provenance: {
        discoveredBy: manifest.model ?? 'unknown',
        discoveredAt: manifest.startedAt,
        traceRef: `${evidence.path}/trace.jsonl`,
        compilerVersion: COMPILER_VERSION,
        humanEdits: [],
      },
      approval: { state: 'draft', by: null, at: null, observedStability: null },
      tenantOverrides: {},
    };

    return this.#finish(draft, warnings);
  }

  /**
   * Parse and re-scan before returning.
   *
   * The parse is the real gate: `capability` carries every cross-field rule the
   * artifact has (declared outputs must be produced, irreversible steps must be
   * checkpointed, sensitive literals are refused), and running it here means the
   * compiler cannot emit something replay would choke on.
   *
   * The redaction scan is belt and braces on top of that, and it is not
   * redundant. Everything in the recording was classified at capture time, so in
   * principle nothing sensitive can reach this point — but "in principle" is the
   * phrase that precedes every leak, and this artifact is the file that gets
   * committed to a repository. A hit here is a compiler bug, so it fails the
   * compile rather than quietly masking the value.
   */
  #finish(draft: Capability, warnings: readonly Warning[]): CompileResult {
    const parsed = capability.safeParse(draft);
    if (!parsed.success) {
      return rejected(
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
    }

    const { found } = this.#redactor.redactText(JSON.stringify(parsed.data));
    if (found.length > 0) {
      const entities = [...new Set(found.map((f) => f.entity))].join(', ');
      return rejected([
        `the compiled artifact still contains sensitive data (${entities}); ` +
          `this is a compiler bug, not a recording problem`,
      ]);
    }

    return { kind: 'compiled', capability: parsed.data, warnings: [...warnings] };
  }

  #steps(
    kept: readonly RecordedStep[],
    declared: readonly DiscoveryInput[],
    promoted: ReadonlyMap<number, string>,
    warnings: Warning[],
  ): Step[] {
    const acting = kept.filter((s) => s.action.tool !== 'assert');
    const usedCheckpointIds = new Set<string>();
    const steps: Step[] = [];

    acting.forEach((recordedStep, at) => {
      const id = `s${at + 1}`;
      const action = actionOf(recordedStep, declared, promoted);
      if (action === null) return;

      const next = acting[at + 1];
      const checkpoint = wantsCheckpoint(recordedStep, kept)
        ? this.#checkpointFor(recordedStep, next, usedCheckpointIds)
        : null;

      if (checkpoint === null && wantsCheckpoint(recordedStep, kept)) {
        warnings.push({
          code: 'no_checkpoint_inferred',
          stepId: id,
          detail: 'nothing stable appeared after this action; the step replays unverified',
        });
      }
      if (recordedStep.target !== null && recordedStep.target.candidates.length < WEAK_BUNDLE) {
        warnings.push({
          code: 'weak_locator_bundle',
          stepId: id,
          detail: `only ${recordedStep.target.candidates.length} locator candidate(s); ` +
            `there is no fallback if it breaks`,
        });
      }
      if (recordedStep.risk !== 'safe') {
        warnings.push({
          code: 'risk_inferred',
          stepId: id,
          detail: `risk '${recordedStep.risk}' was inferred from the control's label, not observed`,
        });
      }
      const promotedName = promoted.get(recordedStep.index);
      if (promotedName !== undefined) {
        warnings.push({
          code: 'sensitive_literal_promoted',
          stepId: id,
          detail:
            `a sensitive literal typed here became parameter '${promotedName}'; ` +
            `rename and describe it before approving`,
        });
      }

      steps.push({
        id,
        intent: intentOf(recordedStep),
        action,
        target: recordedStep.target,
        risk: recordedStep.risk,
        checkpoint,
        recover: recoveryFor(recordedStep),
        timeoutMs: STEP_TIMEOUT_MS,
        optional: false,
      });
    });

    return steps;
  }

  #checkpointFor(
    step: RecordedStep,
    next: RecordedStep | undefined,
    used: Set<string>,
  ): Checkpoint | null {
    const inferred = inferCheckpoint(step, next, 'chk.placeholder', CHECKPOINT_TIMEOUT_MS);
    if (inferred === null) return null;

    const id = uniqueCheckpointId(inferred.from, used);
    used.add(id);
    return { ...inferred.checkpoint, id };
  }
}

// -----------------------------------------------------------------------------
// Noise
// -----------------------------------------------------------------------------

/**
 * Drop what the flow does not need to be reproduced.
 *
 * Only failed actions, for now — a step the model tried and that did not work is
 * by definition not part of the procedure. Backtracking (open a screen, decide
 * it is wrong, go back) is *not* filtered, because detecting it needs a notion
 * of "returned to a screen we were already on" and a wrong guess deletes a real
 * step from a working flow. That asymmetry is deliberate: a compiled capability
 * with a redundant step is slow, one with a missing step is broken.
 */
function filterNoise(recorded: readonly RecordedStep[]): {
  kept: readonly RecordedStep[];
  dropped: number;
} {
  const kept = recorded.filter((s) => s.ok);
  return { kept, dropped: recorded.length - kept.length };
}

// -----------------------------------------------------------------------------
// Per-step mapping
// -----------------------------------------------------------------------------

/**
 * `RecordedAction` → `Action`. Returns null for anything that is not a step.
 *
 * The interesting case is `type`, where the recording's value union becomes the
 * artifact's: a `ref` compiles to `{from:'input'}`, a literal classified `none`
 * to `{from:'literal'}`, and a sensitive literal to a promoted parameter. There
 * is deliberately no fourth branch that writes the value down — the recording
 * does not have it to write.
 */
function actionOf(
  step: RecordedStep,
  declared: readonly DiscoveryInput[],
  promoted: ReadonlyMap<number, string>,
): Action | null {
  const a = step.action;
  switch (a.tool) {
    case 'click':
    case 'double_click':
    case 'scroll_into_view':
      return { type: a.tool };
    case 'set_checked':
      return { type: 'set_checked', checked: a.checked };
    case 'press_key':
      return { type: 'press_key', key: a.key };
    case 'navigate':
      return { type: 'navigate', to: a.url };
    case 'dismiss_dialog':
      return { type: 'dismiss_dialog', accept: a.accept };
    case 'extract':
      return { type: 'extract', into: `$.outputs.${a.name}`, as: a.as };
    case 'type':
      return { type: 'type', value: valueOf(step, declared, promoted), clearFirst: a.clearFirst };
    case 'select':
      return { type: 'select', value: valueOf(step, declared, promoted) };
    case 'assert':
      return null;
  }
}

function valueOf(
  step: RecordedStep,
  _declared: readonly DiscoveryInput[],
  promoted: ReadonlyMap<number, string>,
): ValueSource {
  const value = step.value;
  if (value?.kind === 'literal') return { from: 'literal', value: value.value };

  const ref = value?.kind === 'redacted' ? value.ref : null;
  if (ref !== null) return { from: 'input', ref };

  const name = promoted.get(step.index);
  // Unreachable while `buildContracts` and this function walk the same steps;
  // named rather than silently defaulted so that if they ever diverge, the
  // failure is a parse error here and not a capability typing an empty string.
  return { from: 'input', ref: `$.inputs.${name ?? 'unnamed'}` };
}

/**
 * Whether this step deserves an arrival assertion.
 *
 * Two ways to earn one: the model explicitly asserted after it, or the action's
 * job was to move the screen. Typing gets none by default — a checkpoint after
 * filling a field asserts that the field is still there, which is not a fact
 * worth spending a timeout on.
 *
 * Both routes also require that something appeared, and that condition is doing
 * real work rather than guarding a null. A model that asserts after reading a
 * value is confirming the whole task, not an arrival, and the step it follows
 * gained nothing by definition. Without this the compiler would emit a
 * `no_checkpoint_inferred` warning for it every time — a warning naming a
 * problem the reviewer cannot act on, which is how a warning list stops being
 * read.
 */
function wantsCheckpoint(step: RecordedStep, all: readonly RecordedStep[]): boolean {
  if (step.appeared.length === 0) return false;
  const next = all[all.indexOf(step) + 1];
  return next?.action.tool === 'assert' || MOVES_SCREEN.has(step.action.tool);
}

/**
 * The model's own words, trimmed to one sentence.
 *
 * Using the rationale rather than a synthesised phrase is a deliberate trade.
 * Synthesis would give "Click 'Member Search'", which a reviewer can already
 * read off the target; the rationale gives "open the member lookup form", which
 * is the part nobody else can reconstruct. It is safe to carry because it was
 * redacted at capture time, before it reached the recording.
 */
function intentOf(step: RecordedStep): string {
  const first = step.rationale.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  const text = (first.length >= 3 ? first : step.rationale.trim()).replace(/\s+/g, ' ');
  if (text.length >= 3) return text.slice(0, 200);
  return `Perform ${step.action.tool}`;
}

/**
 * Default recovery rules, applied by action class.
 *
 * These are priors, not observations — this run hit none of these conditions,
 * and a compiler that only wrote down rules for failures it happened to see
 * would produce a capability with no resilience at all on its first outing. They
 * are conservative on purpose: every rule here either waits or dismisses, and
 * none of them retries a mutating action, because retrying a submit is how one
 * transfer becomes two.
 */
function recoveryFor(step: RecordedStep): RecoveryRule[] {
  if (!MOVES_SCREEN.has(step.action.tool)) return [];
  if (step.risk !== 'safe') return [{ on: 'unexpected_dialog', do: 'dismiss_dialog', maxAttempts: 1 }];
  return [
    { on: 'transient_load', do: 'wait_retry', maxAttempts: 2 },
    { on: 'unexpected_dialog', do: 'dismiss_dialog', maxAttempts: 1 },
  ];
}

// -----------------------------------------------------------------------------
// Naming
// -----------------------------------------------------------------------------

/** `text:Account Summary` → `chk.account_summary`, made unique within the flow. */
function uniqueCheckpointId(from: string, used: ReadonlySet<string>): string {
  const name = from.slice(from.indexOf(':') + 1);
  const base = `chk.${snake(name) || 'arrived'}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

function derivedId(goal: string): string {
  return `discovered.${snake(goal).slice(0, 40) || 'capability'}`;
}

function displayNameFor(goal: string): string {
  const text = goal.trim().replace(/\s+/g, ' ').replace(/[.]$/, '');
  return text.length >= 3 ? text.slice(0, 120) : 'Discovered capability';
}

function describeFor(goal: string, inputs: readonly string[]): string {
  const takes =
    inputs.length === 0
      ? 'It takes no parameters.'
      : `Call it with ${inputs.map((n) => `\`${n}\``).join(', ')}.`;
  return `${goal.trim().replace(/[.]$/, '')}. ${takes}`;
}

function snake(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function entryPathOf(entryUrl: string): string {
  try {
    const url = new URL(entryUrl);
    return url.pathname + url.search;
  } catch {
    // Not a URL at all — a desktop surface's entry point is an application path.
    return entryUrl;
  }
}

function rejected(reasons: readonly string[]): CompileResult {
  return { kind: 'rejected', reasons: [...reasons] };
}
