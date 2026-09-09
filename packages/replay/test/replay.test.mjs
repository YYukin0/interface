/**
 * =============================================================================
 * DETERMINISTIC REPLAY — INTEGRATION TESTS
 * =============================================================================
 * A real Chromium, a real fixture application, and the real compiled artifact
 * out of `capabilities/`. Nothing here is stubbed except the handoff
 * coordinator, and that one is stubbed so a test can assert what the engine
 * asked it to do rather than open an operator console.
 *
 * The mocking question is the same one the driver's tests answered: every claim
 * this engine makes is a claim about a browser and a server that misbehave in
 * specific ways — a `confirm()` that blocks the page, a response that arrives
 * after the checkpoint's budget, a request that lands back on sign-on. A fake
 * driver would let all three pass while replay was broken.
 *
 * Two things are deliberately kept out of the repository's own state: the store
 * runs against a *copy* of `capabilities/`, so a test run cannot leave a
 * `.stability.json` behind, and evidence goes to a temp directory.
 *
 *   npm test --workspace @cua/replay
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPolicyEngine } from '@cua/policy';
import { openSession } from '@cua/surface-web';

import { DeterministicReplayEngine, FileCapabilityStore, determinismDigest } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const PORT = 8202;
const BASE = `http://127.0.0.1:${PORT}`;
const CAPABILITY = 'member.read_savings_balance';

/**
 * The fixture's slow response, shortened. The engine's behaviour under a load
 * that outlasts a checkpoint is what matters, not how many seconds it takes to
 * demonstrate it — so the checkpoint budget shrinks with it in `slowArtifact`.
 */
const SLOW_LOAD_MS = 400;

/** Detects that the application has bounced us back to sign-on. */
const SESSION_PROBE = {
  id: 'chk.signed_out',
  assert: 'role-name-present',
  target: null,
  value: 'textbox:Operator ID',
  timeoutMs: 1000,
};

let child;
let policy;
let store;
let capabilitiesDir;
let evidenceRoot;
let session;

before(async () => {
  child = spawn(process.execPath, [join(root, 'apps', 'legacy-app', 'src', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), CUA_SLOW_LOAD_MS: String(SLOW_LOAD_MS) },
    stdio: 'ignore',
  });

  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const work = await mkdtemp(join(tmpdir(), 'cua-replay-'));
  capabilitiesDir = join(work, 'capabilities');
  evidenceRoot = join(work, 'evidence');
  await cp(join(root, 'capabilities'), capabilitiesDir, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });

  policy = await policyFor(BASE);
  store = new FileCapabilityStore(capabilitiesDir);
  session = await signOn('/admin/index.htm');
});

after(async () => {
  await session?.close();
  child?.kill();
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * The shipped policy with one field changed: its allowlist names the origin the
 * demo runs on, and these tests deliberately run somewhere else so a test run
 * cannot collide with a browser someone left open.
 *
 * Rewriting the origin rather than relaxing the document keeps everything under
 * test — the risk table, the deny patterns, the action allowlist — exactly as
 * shipped. The first version of this file loaded `policy.json` unchanged and
 * every single run came back POLICY_DENIED, which was the allowlist working.
 */
async function policyFor(origin) {
  const shipped = JSON.parse(await readFile(join(root, 'policy.json'), 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'cua-policy-'));
  const path = join(dir, 'policy.json');
  await writeFile(path, JSON.stringify({ ...shipped, allowedOrigins: [origin] }, null, 2), 'utf8');
  return loadPolicyEngine(path);
}

const signOn = (entryPoint) =>
  openSession({
    baseUrl: BASE,
    entryPoint,
    username: 'teller01',
    password: 'letmein',
  });

/**
 * An engine wired the way the CLI wires one, with the seams a test wants to
 * hold: which store, and whether there is anywhere to escalate to.
 */
function engineFor({ on = session, capabilities = store, handoff, reauthenticate } = {}) {
  const raised = [];
  const ceded = [];

  const coordinator =
    handoff === null
      ? undefined
      : {
          async cede(sessionId, reason) {
            ceded.push({ sessionId, reason });
            return {
              sessionId,
              holder: 'none',
              holderId: null,
              since: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              reason,
            };
          },
          async raise(request) {
            raised.push(request);
            return {
              ...request,
              id: `iv-${request.runId}`,
              createdAt: new Date().toISOString(),
              consoleUrl: 'test://console',
              status: 'open',
            };
          },
        };

  const engine = new DeterministicReplayEngine({
    driver: on.driver,
    policy,
    store: capabilities,
    origin: BASE,
    evidenceRoot,
    sessionProbe: SESSION_PROBE,
    ...(reauthenticate === undefined ? {} : { reauthenticate }),
    ...(coordinator === undefined ? {} : { handoff: coordinator }),
  });

  return { engine, raised, ceded };
}

const run = (params, extra = {}) =>
  engineFor(extra.wiring).engine.run({
    capabilityId: CAPABILITY,
    version: null,
    tenant: null,
    params,
    requireApproved: false,
    ...extra.request,
  });

/** Reads the checked-in artifact so a test can mutate one field of it. */
const artifact = async () =>
  JSON.parse(await readFile(join(capabilitiesDir, `${CAPABILITY}.capability.json`), 'utf8'));

/** Writes a mutated artifact into a store of its own, leaving the real one alone. */
async function storeWith(mutate) {
  const dir = await mkdtemp(join(tmpdir(), 'cua-artifact-'));
  const capability = await artifact();
  mutate(capability);
  await writeFile(
    join(dir, `${capability.id}.capability.json`),
    JSON.stringify(capability, null, 2) + '\n',
    'utf8',
  );
  return new FileCapabilityStore(dir);
}

// -----------------------------------------------------------------------------
// The happy path, and the claim the whole design rests on
// -----------------------------------------------------------------------------

describe('replaying a compiled capability', () => {
  test('produces the output the capability declares', async () => {
    const result = await run({ memberId: '12345' });
    assert.equal(result.kind, 'success');
    assert.equal(result.outputs.savingsBalance, '$4,231.08');
    assert.equal(result.stats.stepsExecuted, result.stats.stepsTotal);
  });

  test('calls no model, which is the point (I1)', async () => {
    const result = await run({ memberId: '12345' });
    assert.equal(result.stats.llmCalls, 0);

    // The stat could be a lie the engine tells itself, so check the property it
    // is claiming: this package cannot reach a model SDK, because none is in its
    // dependency list. A future edit that added one would fail here rather than
    // in review.
    const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    for (const name of declared) {
      assert.doesNotMatch(name, /anthropic|openai|langchain|@ai-sdk/i, `${name} is a model SDK`);
    }
  });

  test('five runs of one artifact produce one result', async () => {
    // PLAN 3.3's delivery criterion, and the reason `determinismDigest` lives in
    // the package rather than in this file: the definition of "the same result"
    // is part of the guarantee, not part of the test.
    const digests = [];
    for (let i = 0; i < 5; i++) digests.push(determinismDigest(await run({ memberId: '12345' })));
    assert.equal(new Set(digests).size, 1, `digests diverged: ${digests.join(', ')}`);
  });

  test('a different parameter reaches a different record, off the same artifact', async () => {
    const a = await run({ memberId: '12345' });
    const b = await run({ memberId: '67890' });
    assert.equal(a.kind, 'success');
    assert.equal(b.kind, 'success');
    assert.notEqual(a.outputs.savingsBalance, b.outputs.savingsBalance);
    // Same route, different answer: the steps are identical and only the typed
    // value differed, which is what "parameterised" has to mean.
    assert.deepEqual(
      a.steps.map((s) => [s.stepId, s.status]),
      b.steps.map((s) => [s.stepId, s.status]),
    );
  });

  test('records how each control was found, so drift is visible before it breaks', async () => {
    const result = await run({ memberId: '12345' });
    for (const step of result.steps.filter((s) => s.resolution !== null)) {
      assert.equal(step.resolution, 'unique');
      assert.ok(step.agreement > 0, `${step.stepId} resolved with no agreement`);
      assert.ok(step.matchedBy, `${step.stepId} did not report a strategy`);
    }
  });
});

// -----------------------------------------------------------------------------
// I2: a business outcome is not an error
// -----------------------------------------------------------------------------

describe('declared business outcomes', () => {
  test('an unknown member is an outcome, not a failure', async () => {
    const result = await run({ memberId: '00000' });
    assert.equal(result.kind, 'outcome');
    assert.equal(result.code, 'MEMBER_NOT_FOUND');
    assert.equal(result.retryable, true);
  });

  test('a refused record is an outcome too, and is not retryable', async () => {
    const result = await run({ memberId: '99999' });
    assert.equal(result.kind, 'outcome');
    assert.equal(result.code, 'PERMISSION_DENIED');
    assert.equal(result.retryable, false);
  });

  test('an outcome is detected before the checkpoint gets to call it a failure', async () => {
    // The ordering claim from the engine's state table. If the checkpoint were
    // evaluated first, "no such member" would arrive as CHECKPOINT_FAILED —
    // true, useless, and pageable at 3am.
    const result = await run({ memberId: '00000' });
    assert.equal(result.kind, 'outcome');
    assert.equal(result.failure ?? null, null);
  });
});

// -----------------------------------------------------------------------------
// Refusals that happen before anything is touched
// -----------------------------------------------------------------------------

describe('refusing before the browser moves', () => {
  test('a parameter that fails the schema stops the run', async () => {
    const result = await run({ memberId: 'abc' });
    assert.equal(result.kind, 'failure');
    assert.equal(result.failure.class, 'INPUT_INVALID');
    assert.equal(result.stats.stepsExecuted, 0);
  });

  test('an invalid parameter is never echoed into the result (I3)', async () => {
    const result = await run({ memberId: '4111111111111111' });
    assert.equal(result.failure.class, 'INPUT_INVALID');
    assert.equal(JSON.stringify(result).includes('4111111111111111'), false);
  });

  test('an unattended agent may not invoke a capability that is not approved', async () => {
    const result = await run({ memberId: '12345' }, { request: { requireApproved: true } });
    assert.equal(result.kind, 'failure');
    assert.equal(result.failure.class, 'POLICY_DENIED');
    // The distinction the store's `requireApproved: false` exists to preserve:
    // a draft is reported as a draft, not as a capability that does not exist.
    assert.match(result.failure.observed, /review|draft/);
  });

  test('a capability that does not exist is reported as such', async () => {
    const result = await engineFor().engine.run({
      capabilityId: 'member.no_such_capability',
      version: null,
      tenant: null,
      params: {},
      requireApproved: false,
    });
    assert.equal(result.kind, 'failure');
    // There is no CAPABILITY_NOT_FOUND class, and deliberately so: naming a
    // capability that does not exist is the caller getting their input wrong,
    // in the same way that a malformed parameter is. What distinguishes them is
    // `observed`, which has to say which of the two happened.
    assert.equal(result.failure.class, 'INPUT_INVALID');
    assert.match(result.failure.observed, /no such capability/);
    assert.equal(result.stats.stepsExecuted, 0);
  });
});

// -----------------------------------------------------------------------------
// Recovery: the run survives things the compiler predicted
// -----------------------------------------------------------------------------

describe('recovering without a model', () => {
  test('a surprise dialog is dismissed and the step retried', async () => {
    const result = await run({ memberId: '77777' });
    assert.equal(result.kind, 'success');
    assert.ok(result.stats.recoveriesPerformed >= 1, 'expected at least one recovery');

    const recovered = result.steps.flatMap((s) => s.recoveries);
    assert.ok(
      recovered.some((r) => r.condition === 'unexpected_dialog' && r.took === 'dismiss_dialog'),
      `expected a dismissed dialog, got ${JSON.stringify(recovered)}`,
    );
    // Dismissed, never accepted: accepting means answering "yes" to a question
    // nobody read.
    assert.equal(
      recovered.some((r) => r.took === 'accept_dialog'),
      false,
    );
  });

  test('a slow response is absorbed, with the action performed once', async () => {
    const result = await run({ memberId: '88888' });
    assert.equal(result.kind, 'success');
    assert.equal(result.outputs.savingsBalance, '$2,048.00');
    // Whether the wait happened in the driver's navigation grace or in the
    // checkpoint's budget is not this test's business; that the search ran once
    // is. One search is one search — the same rule that keeps one transfer from
    // becoming two.
    assert.equal(result.steps.filter((s) => s.stepId === 's3').length, 1);
  });

  test('a load that outlasts the checkpoint is waited out, not re-clicked', async () => {
    // Its own server, because this is the one test that needs a delay longer
    // than any other test should have to sit through. The checkpoint budget is
    // cut below that delay so the wait is a real recovery rather than a budget
    // that happened to be generous: `#settle` gives up, `wait_retry` spends
    // another budget on the same condition, and the page arrives.
    const port = PORT + 1;
    const base = `http://127.0.0.1:${port}`;
    const delayMs = 3000;
    const server = spawn(process.execPath, [join(root, 'apps', 'legacy-app', 'src', 'server.mjs')], {
      env: { ...process.env, PORT: String(port), CUA_SLOW_LOAD_MS: String(delayMs) },
      stdio: 'ignore',
    });

    let slowSession;
    try {
      for (let i = 0; i < 200; i++) {
        try {
          if ((await fetch(`${base}/healthz`)).ok) break;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      const capabilities = await storeWith((c) => {
        for (const step of c.steps) {
          // Two attempts' worth of budget just covers the delay, which is the
          // point: the rule has to actually be exercised, not skipped.
          if (step.checkpoint !== null) step.checkpoint.timeoutMs = Math.ceil(delayMs * 0.6);
        }
      });

      slowSession = await openSession({
        baseUrl: base,
        entryPoint: '/admin/index.htm',
        username: 'teller01',
        password: 'letmein',
      });

      const slowPolicy = await policyFor(base);
      const result = await new DeterministicReplayEngine({
        driver: slowSession.driver,
        policy: slowPolicy,
        store: capabilities,
        origin: base,
        evidenceRoot,
        sessionProbe: SESSION_PROBE,
      }).run({
        capabilityId: CAPABILITY,
        version: null,
        tenant: null,
        params: { memberId: '88888' },
        requireApproved: false,
      });

      assert.equal(result.kind, 'success');
      assert.equal(result.outputs.savingsBalance, '$2,048.00');

      const waited = result.steps
        .flatMap((s) => s.recoveries)
        .filter((r) => r.took === 'wait_retry');
      assert.ok(waited.length >= 1, 'expected the slow load to be waited out');
      // What `wait_retry` must never do is repeat the action that got us here.
      // It only spends another checkpoint budget, so the recovery is a second
      // wait and not a second click.
      assert.ok(
        waited.every((r) => r.succeeded),
        'a wait that did not succeed should not have produced a success',
      );
    } finally {
      await slowSession?.close();
      server.kill();
    }
  });
});

// -----------------------------------------------------------------------------
// Giving up honestly
// -----------------------------------------------------------------------------

describe('when the run cannot continue', () => {
  test('a dead session is a failure and never an escalation', async () => {
    // Its own session: this test signs the automation out on purpose, and the
    // shared one is used by everything after it.
    const doomed = await signOn('/admin/index.htm');
    let reauths = 0;
    try {
      const result = await run(
        { memberId: '66666' },
        {
          wiring: {
            on: doomed,
            reauthenticate: async () => {
              reauths += 1;
              return doomed.signIn();
            },
          },
        },
      );

      assert.equal(result.kind, 'failure');
      assert.equal(result.failure.class, 'SESSION_UNRECOVERABLE');
      // Re-authentication is attempted exactly once. Handing a human a session
      // that has already died gives them nothing to take over, so this does not
      // escalate — and retrying the sign-on forever is how a lockout happens.
      assert.equal(reauths, 1);
      assert.match(result.failure.detail, /re-authentication was attempted/);
    } finally {
      await doomed.close();
    }
  });

  test('an artifact that no longer matches the application escalates', async () => {
    // The real reason handoff exists: the vendor moved a control, the locator
    // bundle has nothing left that agrees, and no amount of retrying will help.
    const drifted = await storeWith((c) => {
      const step = c.steps[0];
      step.target.expectedName = 'Nonexistent Control';
      step.target.candidates = [
        { strategy: 'role-name', value: 'link:Nonexistent Control', confidence: 0.9, note: null },
      ];
    });

    const { engine, raised, ceded } = engineFor({ capabilities: drifted });
    const result = await engine.run({
      capabilityId: CAPABILITY,
      version: null,
      tenant: null,
      params: { memberId: '12345' },
      requireApproved: false,
    });

    assert.equal(result.kind, 'escalated');
    assert.equal(result.reason, 'locator_unresolved');
    assert.equal(raised.length, 1);

    // I7, in the order it has to happen: control is ceded before a human is
    // asked to take it, and nothing is torn down. The session is still usable
    // afterwards — which the next assertion proves by using it.
    assert.equal(ceded.length, 1);
    assert.ok(raised[0].evidence.path, 'an intervention with no evidence is not actionable');

    const after = await run({ memberId: '12345' });
    assert.equal(after.kind, 'success', 'the escalated session should still be alive');
  });

  test('with nowhere to escalate to, the same run degrades to a failure', async () => {
    // A deployment with no handoff configured must still get a usable answer.
    // The failure class is the escalation reason, mapped — not a generic error.
    const drifted = await storeWith((c) => {
      const step = c.steps[0];
      step.target.expectedName = 'Nonexistent Control';
      step.target.candidates = [
        { strategy: 'role-name', value: 'link:Nonexistent Control', confidence: 0.9, note: null },
      ];
    });

    const result = await run(
      { memberId: '12345' },
      { wiring: { capabilities: drifted, handoff: null } },
    );

    assert.equal(result.kind, 'failure');
    assert.equal(result.failure.class, 'LOCATOR_UNRESOLVED');
    assert.match(result.failure.detail, /no handoff coordinator/);
  });
});

// -----------------------------------------------------------------------------
// One artifact, two institutions
// -----------------------------------------------------------------------------

describe('multi-tenant', () => {
  test("tenant-b's overrides carry the same capability to a different deployment", async () => {
    const resolved = await store.resolve({
      id: CAPABILITY,
      version: null,
      tenant: 'tenant-b',
      requireApproved: false,
    });
    assert.equal(resolved.effective.surface.entryPoint, '/tenant-b/admin/index.htm');

    const other = await signOn(resolved.effective.surface.entryPoint);
    try {
      const result = await engineFor({ on: other }).engine.run({
        capabilityId: CAPABILITY,
        version: null,
        tenant: 'tenant-b',
        params: { memberId: '67890' },
        requireApproved: false,
      });

      assert.equal(result.kind, 'success');
      assert.equal(result.tenant, 'tenant-b');
      // The balance a caller gets is the same on both deployments. That is the
      // reuse claim: the tenant difference is absorbed by the artifact, not by
      // the caller.
      assert.equal(result.outputs.savingsBalance, '$18,904.55');
    } finally {
      await other.close();
    }
  });

  test('the override is a patch, and drift stays below the rebaseline threshold', async () => {
    const resolved = await store.resolve({
      id: CAPABILITY,
      version: null,
      tenant: 'tenant-b',
      requireApproved: false,
    });
    // Only the renamed nav link needs restating. The Fees column tenant-b
    // inserts moves nothing, because the balance cell is addressed by row and
    // column rather than by position — so a tenant patch that had to restate
    // every step would be a sign the locators were wrong, not a sign the tenant
    // was unusual.
    assert.deepEqual(
      resolved.applied.map((a) => a.stepId),
      ['s1'],
    );
    assert.equal(resolved.needsRebaseline, false);
  });
});

// -----------------------------------------------------------------------------
// Evidence
// -----------------------------------------------------------------------------

describe('evidence', () => {
  test('a run leaves a directory a reviewer can read, and it names no model', async () => {
    const result = await run({ memberId: '12345' });
    const files = await readdir(result.evidence.path);
    for (const expected of ['manifest.json', 'trace.jsonl', 'result.json']) {
      assert.ok(files.includes(expected), `evidence is missing ${expected}`);
    }

    const manifest = JSON.parse(await readFile(join(result.evidence.path, 'manifest.json'), 'utf8'));
    assert.equal(manifest.model, null, 'a replay manifest that names a model is a replay that lied');
  });

  test('the trace records a policy decision for every action (I4)', async () => {
    const result = await run({ memberId: '12345' });
    const trace = (await readFile(join(result.evidence.path, 'trace.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const acted = trace.filter((e) => e.event === 'acted');
    const evaluated = trace.filter((e) => e.event === 'policy_evaluated');
    assert.ok(acted.length > 0, 'the run performed no actions');
    // Every action is preceded by a decision, and there is no path that skips
    // one — the opening navigation is evaluated too, which is why this is `>=`.
    assert.ok(
      evaluated.length >= acted.length,
      `${acted.length} actions but only ${evaluated.length} policy decisions`,
    );
    assert.equal(
      evaluated.every((e) => e.decision.kind === 'allow'),
      true,
    );
  });

  test('replay counts land in a sidecar, not in the artifact humans review', async () => {
    await run({ memberId: '12345' });
    const files = await readdir(capabilitiesDir);
    assert.ok(files.includes('.stability.json'), 'no stability sidecar was written');

    const before = await readFile(join(root, 'capabilities', `${CAPABILITY}.capability.json`), 'utf8');
    const after = await readFile(join(capabilitiesDir, `${CAPABILITY}.capability.json`), 'utf8');
    assert.equal(after, before, 'a replay modified the capability it replayed');
  });
});
