#!/usr/bin/env node
/**
 * =============================================================================
 * REPLAY — invoke a compiled capability, deterministically, with no model
 * =============================================================================
 *
 *   node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"12345"}'
 *   node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"00000"}'
 *   node scripts/replay.mjs member.read_savings_balance --tenant tenant-b --params ...
 *   node scripts/replay.mjs member.read_savings_balance --params ... --repeat 5
 *
 * NOTHING HERE READS A MODEL KEY, and that is not an omission. `@cua/replay` has
 * no model SDK in its dependency list, so a replay that consulted one would fail
 * to resolve rather than merely be against the rules. Run it on a machine with
 * no credentials at all; that is the point of the system.
 *
 * THE EXIT CODE FOLLOWS I2. A declared business outcome exits 0, because it is a
 * successful invocation that returned a different answer — "no such member" is
 * what the caller asked about. Only a genuine failure exits non-zero. A pipeline
 * that treated MEMBER_NOT_FOUND as a broken automation would page somebody at
 * 3am because a member id was mistyped.
 *
 * THE CLI DEFAULTS TO RUNNING DRAFTS. `ReplayRequest.requireApproved` defaults to
 * true because its expected caller is an unattended agent; this file's expected
 * caller is a person testing a capability before approving it, which is exactly
 * the case the flag was written for. `--as-agent` restores the agent's rules and
 * shows the refusal.
 */
import { join, resolve as resolvePath } from 'node:path';

import { LocalHandoffCoordinator, startOperatorConsole } from '@cua/handoff';
import { loadPolicyEngine } from '@cua/policy';
import { DeterministicReplayEngine, FileCapabilityStore, determinismDigest } from '@cua/replay';
import { EvidenceSink } from '@cua/evidence';
import { openSession } from '@cua/surface-web';

const USAGE = `usage: node scripts/replay.mjs <capability-id> [options]

  --params <json>       caller parameters                 (default: {})
  --tenant <id>         tenant whose overrides apply
  --version <semver>    exact capability version          (default: whatever is checked in)
  --origin <url>        where the application lives       (default: http://localhost:8080)
  --policy <path>       policy document                   (default: policy.json)
  --capabilities <dir>  artifact directory                (default: capabilities)
  --evidence <dir>      evidence root                     (default: evidence)
  --repeat <n>          run n times; report each run's determinism digest
  --as-agent            require an approved capability, as an unattended agent does
  --no-handoff          do not raise an intervention; report the failure it degrades to
  --no-wait             raise the intervention, but do not block for an operator
  --headed              show the browser

environment
  CUA_APP_USERNAME      application operator id           (default: teller01)
  CUA_APP_PASSWORD      application password              (default: letmein)

  No model credentials are read, because none are needed.

exit codes
  0  success, or a declared business outcome (I2: both are successful invocations)
  1  failure
  3  escalated to a human; the session is still alive
`;

/**
 * Detects that the application has bounced us back to sign-on.
 *
 * Deployment configuration, not engine logic. It names a control rather than an
 * error message on purpose: "Your session has ended" is prose that a localised
 * build changes, whereas an operator-id field on screen means we are signed out
 * in any language.
 */
const SESSION_PROBE = {
  id: 'chk.signed_out',
  assert: 'role-name-present',
  target: null,
  value: 'textbox:Operator ID',
  timeoutMs: 1000,
};

const main = async () => {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help || argv.id === null) {
    process.stdout.write(USAGE);
    process.exit(argv.id === null && !argv.help ? 2 : 0);
  }

  const params = parseParams(argv.params);
  const policy = await loadPolicyEngine(resolvePath(argv.policy));
  const store = new FileCapabilityStore(argv.capabilities);
  const sink = new EvidenceSink();

  const entry = new URL(argv.origin);

  // The entry point comes from the *resolved* artifact, not from this file. A
  // tenant that mounts the same product under a different path says so in its
  // override, and a CLI that hardcoded `/admin/index.htm` would sign on to the
  // baseline deployment and then run the tenant's steps against it — which
  // fails in the confusing direction, by appearing to work.
  //
  // Resolving here and again inside the engine is not a problem worth removing:
  // `applyTenantOverride` is pure, and reading the same file twice is cheaper
  // than a seam that lets the CLI and the engine disagree about which
  // application they are talking to. A null means the engine is about to report
  // the capability as missing, and it says so better than this file could.
  const resolved = await store.resolve({
    id: argv.id,
    version: argv.version,
    tenant: argv.tenant,
    requireApproved: argv.asAgent,
  });

  // Sign-on has to happen on the same deployment the run will use, or the
  // session cookie belongs to the wrong tenant and the engine's opening
  // navigation bounces straight back to a sign-on page.
  const entryPoint = resolved?.effective.surface.entryPoint ?? '/admin/index.htm';

  const session = await openSession({
    baseUrl: entry.origin,
    entryPoint,
    username: process.env.CUA_APP_USERNAME || 'teller01',
    password: process.env.CUA_APP_PASSWORD || 'letmein',
    headless: !argv.headed,
    onScreenshot: sink.screenshot,
    onSnapshot: sink.snapshot,
  });

  process.stderr.write(
    `replaying ${argv.id}\n` +
      `  origin  ${entry.origin}${entryPoint}\n` +
      `  tenant  ${argv.tenant ?? '(baseline)'}\n` +
      `  params  ${Object.keys(params).join(', ') || '(none)'}\n` +
      `  policy  ${argv.policy}\n` +
      `  model   none — this path has no model SDK to call\n\n`,
  );

  const handoff = argv.handoff
    ? await startHandoff({ session, evidenceRoot: argv.evidence })
    : null;

  const engine = new DeterministicReplayEngine({
    driver: session.driver,
    policy,
    store,
    origin: entry.origin,
    sink,
    evidenceRoot: argv.evidence,
    onEvent: progress,
    onWaiting: waiting,
    sessionProbe: SESSION_PROBE,
    // Re-enters credentials on the SAME live session (I7's little sibling):
    // `signIn` drives the existing page rather than opening a new context.
    reauthenticate: () => session.signIn(),
    ...(handoff === null ? {} : { handoff: handoff.coordinator }),
  });

  const request = {
    capabilityId: argv.id,
    version: argv.version,
    tenant: argv.tenant,
    params,
    requireApproved: argv.asAgent,
  };

  const digests = [];
  let last = null;

  try {
    for (let run = 1; run <= argv.repeat; run++) {
      let result = await engine.run(request);
      report(result, argv.repeat > 1 ? run : null);

      // The escalation is not the end of the run; it is the middle of it. The
      // session is still open, a person is looking at it, and when they hand
      // control back the flow continues from wherever they left the screen.
      while (result.kind === 'escalated' && handoff !== null && !argv.noWait) {
        const decision = await waitForHandBack(
          handoff.coordinator,
          handoff.coordinator.sessionIdOf(result.interventionId),
        );
        if (decision === 'stop') {
          process.stderr.write('  the operator finished or abandoned this run by hand\n\n');
          break;
        }
        process.stderr.write('  control returned to automation; resuming\n\n');
        result = await engine.run(request, { resumeInPlace: true });
        report(result, argv.repeat > 1 ? run : null);
      }

      last = result;
      digests.push(determinismDigest(result));
    }
  } finally {
    await handoff?.console.close();
    await session.close();
  }

  if (argv.repeat > 1) reportDeterminism(digests);
  process.exit(last === null ? 1 : EXIT[last.kind]);
};

const EXIT = { success: 0, outcome: 0, failure: 1, escalated: 3 };

// -----------------------------------------------------------------------------
// Handoff
// -----------------------------------------------------------------------------

/**
 * Start the operator console and hand the engine a coordinator that talks to it.
 *
 * The engine only ever calls `cede` and `raise`; everything else in the takeover
 * — claim, input, hand-back — happens between a person's browser and the console
 * server, on the session this process is still holding open. That asymmetry is
 * the design: the automation's part of a handoff is to stop and say why.
 */
async function startHandoff({ session, evidenceRoot }) {
  // The console binds an ephemeral port, so its origin is not known until it is
  // listening — and the coordinator has to exist first, because the server takes
  // one. The getter breaks the cycle; no URL is minted before the port is bound.
  let origin = null;

  const coordinator = new LocalHandoffCoordinator({
    evidenceRoot,
    consoleOrigin: () => origin ?? '(the console is not listening yet)',
    // A digest of the screen before and after, so the audit record can say what
    // the human changed rather than only that they were there.
    observe: async () => (await session.driver.observe()).digest,
    announce: (intervention) => {
      process.stderr.write(
        `\n  ┌─ a person is needed ─────────────────────────────────────────\n` +
          `  │ ${intervention.reason}\n` +
          `  │ ${intervention.explanation}\n` +
          `  │\n` +
          `  │ open:  ${intervention.consoleUrl}\n` +
          `  │ This link is a credential. It is signed and it expires.\n` +
          `  └──────────────────────────────────────────────────────────────\n\n`,
      );
    },
  });

  const console_ = await startOperatorConsole({
    coordinator,
    liveView: session.liveView,
    assetsDir: resolvePath('apps/operator'),
  });

  origin = console_.origin;
  return { coordinator, console: console_ };
}

/**
 * Block until the operator hands control back, then continue on the screen they
 * left — not from the entry point.
 *
 * Polling a local in-memory lease is not elegant and is the right amount of
 * machinery: the alternative is an event emitter whose only subscriber is this
 * function. What matters is what happens on the far side of the wait, which is
 * `resumeInPlace` — the human may have advanced the flow several screens, and
 * re-navigating would undo their work and re-perform steps they did by hand.
 */
async function waitForHandBack(coordinator, sessionId) {
  process.stderr.write('  waiting for an operator… (ctrl-c to abandon the run)\n');
  for (;;) {
    const lease = await coordinator.lease(sessionId);
    if (lease.holder === 'automation') return 'resume';
    if (lease.holder === 'none' && lease.reason?.includes('run is over')) return 'stop';
    await new Promise((r) => setTimeout(r, 500));
  }
}

// -----------------------------------------------------------------------------
// Progress
// -----------------------------------------------------------------------------

/**
 * One line per interesting event, while the run is still happening.
 *
 * The run that made this necessary takes twenty-one seconds and prints nothing
 * for twenty of them: member 66666 is bounced back to sign-on, the engine
 * re-authenticates once, and then waits out the checkpoint's budget before it is
 * willing to say the session is unrecoverable. That wait is the correct
 * behaviour — the conclusion is reached by looking rather than by guessing — but
 * a silent terminal makes correct-and-slow look identical to hung, and the first
 * person to run it hit ctrl-c, which is the right response to what they could
 * see.
 *
 * What arrives here has already been redacted and schema-checked by the writer,
 * so this function has no filtering to do beyond deciding what is worth a line.
 * Most events are not: `observed` fires constantly and says nothing a human
 * wants at this level. The ones kept are the ones that explain a pause.
 */
function progress(event) {
  const line = describe(event);
  if (line !== null) process.stderr.write(`  ${line}\n`);
}

/** Said while a wait is happening, which is the whole point of it. */
function waiting({ stepId, checkpointId, waitedMs, budgetMs }) {
  process.stderr.write(
    `  ${stepId}: still waiting on ${checkpointId} — ` +
      `${(waitedMs / 1000).toFixed(0)}s of ${(budgetMs / 1000).toFixed(0)}s\n`,
  );
}

function describe(event) {
  switch (event.event) {
    case 'resolved':
      return event.status === 'unique'
        ? null // The expected case. Only say something when it is not.
        : `${event.stepId ?? '—'}: locator ${event.status}` +
            ` (agreement ${event.agreement.toFixed(2)})`;

    case 'checkpoint_evaluated':
      // Only the ones that cost time. A checkpoint that passed instantly is the
      // system working, and narrating it buries the ones that did not.
      return event.passed && event.waitedMs < 1000
        ? null
        : `checkpoint ${event.checkpointId}: ${event.passed ? 'passed' : 'not met'}` +
            ` after ${(event.waitedMs / 1000).toFixed(1)}s — expected ${event.expected}`;

    case 'recovery_attempted':
      return (
        `recovering ${event.stepId ?? '—'}: ${event.condition} → ${event.took}` +
        ` (attempt ${event.attempt}, ${event.succeeded ? 'worked' : 'did not help'})`
      );

    case 'business_outcome':
      return `outcome ${event.code} declared by the artifact`;

    case 'escalated':
      return `escalating: ${event.reason}`;

    case 'control_transferred':
      return `control ${event.from} → ${event.to}: ${event.reason}`;

    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------

function report(result, run) {
  const label = run === null ? '' : `run ${run}: `;
  const lines = [];

  switch (result.kind) {
    case 'success':
      lines.push(`${label}success  ${JSON.stringify(result.outputs)}`);
      break;
    case 'outcome':
      lines.push(
        `${label}outcome  ${result.code}${result.retryable ? ' (retryable)' : ''}`,
        `         ${result.message}`,
        `         this is a successful invocation, not an error (I2)`,
      );
      break;
    case 'failure':
      lines.push(
        `${label}failure  ${result.failure.class}` +
          (result.failure.stepId === null ? '' : ` at ${result.failure.stepId}`),
        `         expected  ${result.failure.expected}`,
        `         observed  ${result.failure.observed}`,
        ...(result.failure.detail === null ? [] : [`         detail    ${result.failure.detail}`]),
      );
      break;
    case 'escalated':
      lines.push(
        `${label}escalated  ${result.reason}`,
        `         intervention ${result.interventionId}`,
        `         resume from  ${result.resumeFrom ?? '(the beginning)'}`,
        `         the session is still open; nothing was torn down`,
      );
      break;
  }

  const { stats } = result;
  lines.push(
    `         evidence ${result.evidence.path}`,
    `         ${stats.stepsExecuted}/${stats.stepsTotal} steps · ` +
      `${stats.recoveriesPerformed} recoveries · ${stats.llmCalls} llm calls · ` +
      `${Math.round(stats.durationMs / 100) / 10}s`,
    `         digest ${determinismDigest(result)}`,
  );

  process.stderr.write(lines.join('\n') + '\n\n');
}

/**
 * The determinism claim, reported as a count rather than as a diff.
 *
 * One distinct digest across N runs is the whole assertion. Printing the digests
 * when they disagree is more useful than printing them when they agree.
 */
function reportDeterminism(digests) {
  const distinct = [...new Set(digests)];
  if (distinct.length === 1) {
    process.stderr.write(
      `deterministic: ${digests.length} runs produced 1 distinct result digest (${distinct[0]})\n`,
    );
    return;
  }
  process.stderr.write(
    `NOT deterministic: ${digests.length} runs produced ${distinct.length} distinct digests\n` +
      digests.map((d, i) => `  run ${i + 1}  ${d}\n`).join(''),
  );
  process.exitCode = 1;
}

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

function parseArgs(args) {
  const out = {
    id: null,
    params: '{}',
    tenant: null,
    version: null,
    origin: 'http://localhost:8080',
    policy: 'policy.json',
    capabilities: 'capabilities',
    evidence: 'evidence',
    repeat: 1,
    asAgent: false,
    handoff: true,
    noWait: false,
    headed: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--params':
        out.params = need(args, ++i, '--params');
        break;
      case '--tenant':
        out.tenant = need(args, ++i, '--tenant');
        break;
      case '--version':
        out.version = need(args, ++i, '--version');
        break;
      case '--origin':
        out.origin = need(args, ++i, '--origin');
        break;
      case '--policy':
        out.policy = need(args, ++i, '--policy');
        break;
      case '--capabilities':
        out.capabilities = need(args, ++i, '--capabilities');
        break;
      case '--evidence':
        out.evidence = need(args, ++i, '--evidence');
        break;
      case '--repeat':
        out.repeat = Number(need(args, ++i, '--repeat'));
        if (!Number.isInteger(out.repeat) || out.repeat < 1) fail('--repeat needs a positive integer');
        break;
      case '--as-agent':
        out.asAgent = true;
        break;
      case '--no-handoff':
        out.handoff = false;
        break;
      case '--no-wait':
        out.noWait = true;
        break;
      case '--headed':
        out.headed = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`);
        if (out.id !== null) fail('only one capability id may be given');
        out.id = arg;
    }
  }
  return out;
}

function parseParams(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`--params is not valid JSON: ${raw}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('--params must be a JSON object');
  }
  return parsed;
}

function need(args, at, flag) {
  const value = args[at];
  if (value === undefined) fail(`${flag} needs a value`);
  return value;
}

function fail(message) {
  process.stderr.write(`replay: ${message}\n`);
  process.exit(2);
}

await main();
