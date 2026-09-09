/**
 * =============================================================================
 * THE DISCOVERY LOOP — INTEGRATION TESTS
 * =============================================================================
 * A real Chromium, the real fixture application, and a scripted model standing
 * in for the LLM.
 *
 * Scripting the model rather than mocking the browser is the deliberate half of
 * this. Every claim the loop makes is a claim about the *surface*: that a
 * locator bundle can be harvested before a click destroys the DOM that produced
 * it, that a member id typed into a real form never reaches disk, that three
 * actions which change nothing are detectable. A fake driver would let all of
 * those pass while the loop was broken. The model, by contrast, is the one part
 * whose behaviour we do not want in a test suite at all — it costs money and
 * gives a different answer each time. So: real everything, scripted model, and
 * one genuine LLM run kept separately as evidence.
 *
 *   npm test --workspace @cua/discovery
 */
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AllowlistPolicyEngine } from '@cua/policy';
import { policyDocument } from '@cua/contracts';
import { readRecording, readTrace, readManifest } from '@cua/evidence';
import { openSession } from '@cua/surface-web';

import { DiscoveryLoop, EvidenceSink, ScriptedDecisionModel } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8202;
const BASE = `http://127.0.0.1:${PORT}`;

/** The value under test for I3: it must not appear anywhere but in the browser. */
const MEMBER_ID = '12345';
const SAVINGS_BALANCE = '$4,231.08';

let child;
let session;
let sink;
let evidenceRoot;

before(async () => {
  child = spawn(process.execPath, [join(here, '..', '..', '..', 'apps', 'legacy-app', 'src', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
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

  evidenceRoot = await mkdtemp(join(tmpdir(), 'cua-discovery-'));
  sink = new EvidenceSink();
  session = await openSession({
    baseUrl: BASE,
    entryPoint: '/admin/index.htm',
    username: 'teller01',
    password: 'letmein',
    onScreenshot: sink.screenshot,
    onSnapshot: sink.snapshot,
  });
});

after(async () => {
  await session?.close();
  child?.kill();
  if (evidenceRoot) await rm(evidenceRoot, { recursive: true, force: true });
});

/** Each test starts from the frameset, so one test's navigation cannot leak. */
beforeEach(async () => {
  await session.page.goto(`${BASE}/admin/index.htm`);
});

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const POLICY = policyDocument.parse({
  version: '1.0.0',
  allowedOrigins: [BASE],
  allowedPathPrefixes: ['/admin/'],
  allowedActions: [
    'click',
    'type',
    'select',
    'set_checked',
    'press_key',
    'navigate',
    'scroll_into_view',
    'extract',
    'dismiss_dialog',
  ],
  maxStepsPerRun: 30,
  denyPatterns: ['/admin/signoff\\.do'],
});

const REQUEST = {
  goal: 'Read the current balance of a member\'s savings account.',
  entryUrl: `${BASE}/admin/index.htm`,
  surface: 'legacy-web',
  app: 'northgate-core-admin',
  tenant: 'tenant-a',
  proposedId: 'member.read_savings_balance',
  inputs: [
    { name: 'memberId', description: 'the five digit member number', classification: 'identifier' },
  ],
  maxSteps: 12,
  deadlineMs: 120_000,
  model: 'scripted',
  allowMutating: false,
};

const VALUES = new Map([['memberId', MEMBER_ID]]);

/** Run the scripted model against the live session. */
async function discover(steps, overrides = {}) {
  const model = new ScriptedDecisionModel(steps);
  const loop = new DiscoveryLoop({
    driver: session.driver,
    model,
    policy: new AllowlistPolicyEngine(overrides.policy ?? POLICY),
    sink,
    evidenceRoot,
  });
  const result = await loop.run({ ...REQUEST, ...(overrides.request ?? {}) }, VALUES);
  return { result, model, dir: result.evidence.path };
}

const call = (action, rationale = 'because the script says so') => ({ action, rationale });

/**
 * Pull a ref out of the rendered tree by matching the line that describes it.
 *
 * The script cannot hardcode refs — they are assigned per observation — so it
 * reads them back the same way the model does, which also means these tests
 * fail if the rendering ever stops being legible.
 */
function refFor(prompt, pattern) {
  const line = prompt.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in:\n${prompt}`);
  const ref = /\[(f\d+e[\w-]+)\]/.exec(line);
  assert.ok(ref, `line has no ref: ${line}`);
  return ref[1];
}

/** The balance cell has no accessible name, and its text is redacted. */
function balanceRef(prompt) {
  const lines = prompt.split('\n');
  const savings = lines.findIndex((l) => /cell "Savings"/.test(l));
  assert.ok(savings >= 0, `no Savings row in:\n${prompt}`);
  const balance = lines.slice(savings).find((l) => /cell "\[REDACTED:MONEY\]"/.test(l));
  assert.ok(balance, `no money cell after the Savings row in:\n${prompt}`);
  return /\[(f\d+e[\w-]+)\]/.exec(balance)[1];
}

/** The steps that actually reach the goal, reused by several tests. */
const HAPPY_PATH = [
  (p) => call({ tool: 'click', ref: refFor(p, /link "Member Search"/) }, 'open member search'),
  (p) =>
    call(
      { tool: 'type', ref: refFor(p, /textbox "Member ID"/), text: '$.inputs.memberId' },
      'the member number goes in the search field',
    ),
  (p) => call({ tool: 'click', ref: refFor(p, /button "Search"/) }, 'run the search'),
  () => call({ tool: 'assert', description: 'the member detail screen is open' }, 'confirm arrival'),
  (p) =>
    call(
      { tool: 'extract', ref: balanceRef(p), name: 'savingsBalance', as: 'money' },
      'the balance column of the savings row',
    ),
  () => call({ tool: 'done', summary: 'read the savings balance' }, 'goal reached'),
];

/** Every file in the run directory, as text, for leak hunting. */
async function allText(dir) {
  const out = [];
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (!entry.name.endsWith('.png')) out.push(await readFile(path, 'utf8'));
    }
  };
  await walk(dir);
  return out.join('\n');
}

// -----------------------------------------------------------------------------

describe('reaching a goal', () => {
  test('the run completes and the evidence names the model that produced it', async () => {
    const { result, dir } = await discover(HAPPY_PATH);

    assert.equal(result.kind, 'completed', JSON.stringify(result));
    // Five recorded steps, five counted. `assert` performs nothing but still
    // costs a step, so `stepsTaken` and the recording cannot disagree.
    assert.equal(result.stats.stepsTaken, 5);
    assert.equal(result.stats.policyDenials, 0);

    const manifest = await readManifest(dir);
    assert.equal(manifest.kind, 'discovery');
    assert.ok(manifest.endedAt, 'a finished run stamps its manifest');
    assert.equal(manifest.model, 'scripted');
    assert.equal(manifest.goal, REQUEST.goal);
  });

  /**
   * The recording is the compiler's only input, and the locator bundle in it is
   * the one thing that cannot be reconstructed later at any price. Two or more
   * independent candidates per step is what makes replay's agreement vote
   * possible at all — a single-candidate bundle degenerates to first-match-wins.
   */
  test('every element step carries a locator bundle harvested before the action', async () => {
    const { dir } = await discover(HAPPY_PATH);
    const steps = await readRecording(dir);

    const withTargets = steps.filter((s) => s.target !== null);
    assert.ok(withTargets.length >= 3, `only ${withTargets.length} steps had a target`);

    for (const step of withTargets) {
      assert.ok(
        step.target.candidates.length >= 2,
        `${step.action.tool} step ${step.index} has only ${step.target.candidates.length} candidate(s)`,
      );
      const confidences = step.target.candidates.map((c) => c.confidence);
      assert.deepEqual(confidences, [...confidences].sort((a, b) => b - a), 'not ordered by confidence');
    }
  });

  test('an assert is recorded as a checkpoint and performs nothing', async () => {
    const { dir } = await discover(HAPPY_PATH);
    const asserted = (await readRecording(dir)).find((s) => s.action.tool === 'assert');

    assert.ok(asserted, 'the assert was not recorded');
    assert.equal(asserted.digestBefore, asserted.digestAfter, 'the assert changed the screen');
    assert.equal(asserted.target, null);
  });

  /**
   * Note what this test cannot use: `locationAfter`. On a `<frameset>` the
   * top-level URL is `index.htm` from sign-on to sign-off, so every step in this
   * recording has the same location before and after. That is precisely why the
   * digest and `appeared` exist, and why a design that treated the URL as the
   * statement of where you are would be blind on this whole class of app.
   */
  test('what the screen gained is recorded, as raw material for checkpoints', async () => {
    const { dir } = await discover(HAPPY_PATH);
    const steps = await readRecording(dir);

    assert.ok(
      steps.every((s) => s.locationBefore === s.locationAfter),
      'the frameset URL changed, which would make this test prove nothing',
    );

    const arrived = steps.find((s) => s.appeared.some((k) => /Account Summary/.test(k)));
    assert.ok(arrived, `no step saw the account summary appear`);
    assert.notEqual(arrived.digestBefore, arrived.digestAfter, 'the digest missed the transition');
  });

  /**
   * `appeared` feeds checkpoint inference, so what it excludes matters as much
   * as what it keeps. A checkpoint on "the cell reading Renner, Alice M
   * appeared" would pass for exactly one member and fail for every other caller
   * of the capability — it is both a leak and a bug, which is why the filter is
   * on the role rather than on the text.
   */
  test('landmarks are recorded as arrival signals; record contents are not', async () => {
    const { dir } = await discover(HAPPY_PATH);
    const all = (await readRecording(dir)).flatMap((s) => s.appeared);

    assert.ok(all.some((k) => k === 'text:Account Summary'), all.join(', '));
    assert.equal(all.some((k) => k.startsWith('cell:')), false, 'a record cell was kept');
    assert.equal(all.some((k) => /Renner/.test(k)), false, 'a member name was kept');
  });

  test('an extracted value is classified, not copied', async () => {
    const { dir } = await discover(HAPPY_PATH);
    const extracted = (await readRecording(dir)).find((s) => s.action.tool === 'extract');

    assert.ok(extracted, 'the extract was not recorded');
    assert.equal(extracted.extracted.kind, 'redacted');
    assert.equal(extracted.extracted.classification, 'financial');
  });
});

// -----------------------------------------------------------------------------

describe('the value never leaves the browser', () => {
  /**
   * The load-bearing test of this package. The member id is real: it is typed
   * into a real form and the real application answers with that member's page.
   * It must nonetheless be absent from the prompt, from the audit trail, and
   * from the recording — three sinks, one assertion each, and none of them
   * relies on anyone having remembered to scrub anything.
   */
  test('the member id reaches the form but not the model, the trace, or the recording', async () => {
    const { result, model, dir } = await discover(HAPPY_PATH);
    assert.equal(result.kind, 'completed');

    for (const [i, prompt] of model.prompts.entries()) {
      assert.equal(prompt.includes(MEMBER_ID), false, `prompt ${i} contains the member id`);
    }

    const written = await allText(dir);
    assert.equal(written.includes(MEMBER_ID), false, 'the member id is somewhere in the run directory');
    assert.equal(written.includes(SAVINGS_BALANCE), false, 'the balance is in the run directory');

    // And it did get typed: the application only produces this member's detail
    // page when it receives the real digits, so the content frame having landed
    // on `detail.htm?mid=…` is proof the substitution reached the form.
    assert.ok(
      session.page.frames().some((f) => /detail\.htm/.test(f.url())),
      session.page.frames().map((f) => f.url()).join(', '),
    );
  });

  test('the typed value is recorded as a shape, which is enough to declare a parameter', async () => {
    const { dir } = await discover(HAPPY_PATH);
    const typed = (await readRecording(dir)).find((s) => s.action.tool === 'type');

    assert.ok(typed, 'the type step was not recorded');
    // A shape and a name. The name is what lets the compiler write
    // `valueFrom: $.inputs.memberId` instead of guessing which parameter a
    // five-character identifier belonged to.
    assert.deepEqual(typed.value, {
      kind: 'redacted',
      classification: 'identifier',
      inferredPattern: '^[0-9]{5}$',
      length: 5,
      ref: '$.inputs.memberId',
    });
  });

  test('redactions are reported as counts, so the safety claim is auditable', async () => {
    const { dir } = await discover(HAPPY_PATH);
    const records = JSON.parse(await readFile(join(dir, 'redactions.json'), 'utf8'));

    assert.ok(records.length > 0, 'nothing was reported as redacted');
    for (const record of records) {
      assert.ok(record.count >= 1);
      assert.equal('value' in record, false, 'a redaction record carried the value it described');
    }
    assert.ok(records.some((r) => r.sink === 'prompt'), 'no redaction was attributed to the prompt');
  });
});

// -----------------------------------------------------------------------------

describe('when the model asks for something it may not have', () => {
  /**
   * A denial is a turn, not an exception. Crashing here would throw away every
   * step that was fine, and on a paid run those are the expensive ones.
   */
  test('a policy denial is fed back and the run carries on', async () => {
    const { result, model } = await discover([
      () => call({ tool: 'navigate', url: `${BASE}/admin/signoff.do` }, 'sign off first'),
      (p) => {
        assert.match(p, /REFUSED/);
        assert.match(p, /deny-pattern/);
        return call({ tool: 'click', ref: refFor(p, /link "Member Search"/) }, 'try the menu instead');
      },
      () => call({ tool: 'done', summary: 'recovered from the denial' }, 'good enough'),
    ]);

    assert.equal(result.kind, 'completed', JSON.stringify(result));
    assert.equal(result.stats.policyDenials, 1);
    assert.equal(model.consumed, 3);
  });

  test('the denial and its rule are in the audit trail', async () => {
    const { dir } = await discover([
      () => call({ tool: 'navigate', url: `${BASE}/admin/signoff.do` }, 'sign off first'),
      (p) => call({ tool: 'click', ref: refFor(p, /link "Member Search"/) }, 'try the menu'),
      () => call({ tool: 'done', summary: 'done' }, 'finished'),
    ]);

    const denied = (await readTrace(dir)).filter(
      (e) => e.event === 'policy_evaluated' && e.decision.kind === 'deny',
    );
    assert.equal(denied.length, 1);
    assert.equal(denied[0].decision.rule, 'deny-pattern');
  });

  /**
   * An unattended run must not be able to talk its way into a state change. The
   * policy says `mutating: confirm` and nobody is there to confirm.
   */
  test('a mutating action needs confirmation, and an unattended run does not get it', async () => {
    const { result } = await discover([
      ...HAPPY_PATH.slice(0, 4),
      (p) => call({ tool: 'click', ref: refFor(p, /link "Open Sub-Account"/) }, 'open a sub-account'),
      (p) => {
        assert.match(p, /needs human confirmation/);
        return call({ tool: 'stuck', reason: 'policy_requires_confirmation', explanation: 'blocked' }, 'give up');
      },
    ]);

    assert.equal(result.kind, 'escalated');
    assert.equal(result.reason, 'policy_requires_confirmation');
  });

  test('an operator can pre-approve the mutating class for a run', async () => {
    const { result, dir } = await discover(
      [
        ...HAPPY_PATH.slice(0, 4),
        (p) => call({ tool: 'click', ref: refFor(p, /link "Open Sub-Account"/) }, 'open a sub-account'),
        () => call({ tool: 'done', summary: 'reached the sub-account form' }, 'goal reached'),
      ],
      { request: { allowMutating: true } },
    );

    assert.equal(result.kind, 'completed', JSON.stringify(result));
    assert.equal(result.stats.policyDenials, 0);

    // Recorded as mutating even though it was allowed: the class is a fact about
    // the step, and a reviewer approving this capability has to see it.
    const steps = await readRecording(dir);
    assert.ok(steps.some((s) => s.risk === 'mutating'), 'no step was recorded as mutating');

    // Again, not the top-level URL — the frameset's content frame is what moved.
    assert.ok(
      session.page.frames().some((f) => /subacct\.htm/.test(f.url())),
      session.page.frames().map((f) => f.url()).join(', '),
    );
  });

  test('a ref that is not in the observation is refused before it reaches the surface', async () => {
    const { result, model } = await discover([
      () => call({ tool: 'click', ref: 'f9e999' }, 'a ref I remembered from earlier'),
      (p) => {
        assert.match(p, /f9e999/);
        assert.match(p, /not in the observation/);
        return call({ tool: 'click', ref: refFor(p, /link "Member Search"/) }, 'use a live ref');
      },
      () => call({ tool: 'done', summary: 'recovered' }, 'finished'),
    ]);

    assert.equal(result.kind, 'completed');
    assert.equal(model.consumed, 3);
  });

  test('an entry point outside the allowlist stops the run before anything happens', async () => {
    const { result } = await discover(HAPPY_PATH, {
      request: { entryUrl: 'http://example.invalid/admin/index.htm' },
    });

    assert.equal(result.kind, 'stopped');
    assert.equal(result.reason, 'policy_blocked');
    assert.match(result.detail, /allowlist/);
  });
});

// -----------------------------------------------------------------------------

describe('knowing when to stop', () => {
  test('the model calling stuck escalates, with an id a human can claim', async () => {
    const { result, dir } = await discover([
      () => call({ tool: 'stuck', reason: 'unknown_state', explanation: 'I do not recognise this screen' }, 'no idea'),
    ]);

    assert.equal(result.kind, 'escalated');
    assert.equal(result.reason, 'unknown_state');
    assert.ok(result.interventionId.length > 0);

    const escalated = (await readTrace(dir)).find((e) => e.event === 'escalated');
    assert.equal(escalated.interventionId, result.interventionId);
  });

  /**
   * The digest is what makes this cheap: it hashes the screen's shape with
   * record content removed, so it is stable across two members' detail pages and
   * changes the instant the screen does.
   */
  test('clicking the same link forever is a dead end, not an infinite loop', async () => {
    const again = (p) => call({ tool: 'click', ref: refFor(p, /link "Member Search"/) }, 'try again');
    const { result } = await discover([
      again,
      again,
      again,
      again,
      () => call({ tool: 'done', summary: 'never reached' }, 'unreachable'),
    ]);

    assert.equal(result.kind, 'stopped');
    assert.equal(result.reason, 'dead_end');
  });

  /**
   * The counterpart, and the reason the check is not simply "the screen did not
   * change": filling in a form changes nothing observable and is exactly what a
   * working agent does on a search screen.
   */
  test('filling in a form is not mistaken for going in circles', async () => {
    const { result } = await discover([
      (p) => call({ tool: 'click', ref: refFor(p, /link "Member Search"/) }, 'open search'),
      (p) => call({ tool: 'type', ref: refFor(p, /textbox "Member ID"/), text: '$.inputs.memberId' }, 'id'),
      (p) => call({ tool: 'select', ref: refFor(p, /combobox/), option: 'Northgate' }, 'branch'),
      (p) => call({ tool: 'type', ref: refFor(p, /textbox "Member ID"/), text: '$.inputs.memberId' }, 'again'),
      () => call({ tool: 'done', summary: 'form filled' }, 'good enough'),
    ]);

    assert.equal(result.kind, 'completed', JSON.stringify(result));
  });

  test('the step budget ends the run rather than the wallet', async () => {
    const { result } = await discover(
      [
        (p) => call({ tool: 'click', ref: refFor(p, /link "Member Search"/) }, 'one'),
        (p) => call({ tool: 'click', ref: refFor(p, /link "Teller Batch"/) }, 'two'),
        (p) => call({ tool: 'click', ref: refFor(p, /link "Reports"/) }, 'three'),
      ],
      { request: { maxSteps: 2 } },
    );

    assert.equal(result.kind, 'stopped');
    assert.equal(result.reason, 'max_steps');
  });

  test('a model that cannot produce an action is stopped, not asked forever', async () => {
    const { result, model } = await discover([
      () => ({ call: null, error: 'I would rather write an essay', tokensIn: 1, tokensOut: 1 }),
      () => ({ call: null, error: 'another essay', tokensIn: 1, tokensOut: 1 }),
      () => ({ call: null, error: 'a third essay', tokensIn: 1, tokensOut: 1 }),
      () => call({ tool: 'done', summary: 'never reached' }, 'unreachable'),
    ]);

    assert.equal(result.kind, 'stopped');
    assert.equal(result.reason, 'model_gave_up');
    assert.equal(model.consumed, 3);
  });

  test('the run is finalised whichever way it ends', async () => {
    const { dir } = await discover([
      () => call({ tool: 'stuck', reason: 'unknown_state', explanation: 'lost' }, 'giving up'),
    ]);

    const finished = (await readTrace(dir)).find((e) => e.event === 'run_finished');
    assert.equal(finished.outcome, 'escalated');
    await readFile(join(dir, 'result.json'), 'utf8');
  });
});
