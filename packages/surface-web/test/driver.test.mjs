/**
 * =============================================================================
 * SURFACE DRIVER — INTEGRATION TESTS
 * =============================================================================
 * These run a real Chromium against the real fixture application. That is a
 * deliberate choice over mocking the page: every interesting claim this driver
 * makes is a claim about a browser's behaviour — that a `<frameset>` produces a
 * usable frame path, that a native `confirm()` blocks the world, that a table
 * cell is addressable by row and column after a tenant inserts a column ahead of
 * it. A mocked DOM would let all four of those pass while the driver was broken.
 *
 *   npm test --workspace @cua/surface-web
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { target as targetSchema } from '@cua/contracts';
import { openSession } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8201;
const BASE = `http://127.0.0.1:${PORT}`;

/** @type {import('node:child_process').ChildProcess} */
let child;
/** @type {import('../dist/index.js').Session} */
let session;
/** Screenshots the driver wrote, so redaction can be asserted on real output. */
const shots = [];

before(async () => {
  child = spawn(process.execPath, [join(here, '..', '..', '..', 'apps', 'legacy-app', 'src', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), CUA_SLOW_LOAD_MS: '400' },
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

  session = await openSession({
    baseUrl: BASE,
    entryPoint: '/admin/index.htm',
    username: 'teller01',
    password: 'letmein',
    onScreenshot: async (png, label, found) => {
      shots.push({ png, label, found });
      return `shot-${shots.length}`;
    },
  });
});

after(async () => {
  await session?.close();
  child?.kill();
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Fills in the schema's defaults so tests can state only what they mean. */
const T = (partial) => targetSchema.parse(partial);

const c = (strategy, value, confidence = 0.8) => ({ strategy, value, confidence, note: null });

/** Resolve against a fresh observation, then act. Mirrors what replay does. */
async function act(action, target) {
  await session.driver.observe();
  const resolution = target === null ? { status: 'unique', ref: null } : await session.driver.resolve(target);
  assert.equal(resolution.status, 'unique', `expected a unique match, got ${resolution.status}`);
  const result = await session.driver.perform(action, resolution.ref);
  assert.ok(result.ok, `action failed: ${result.detail}`);
  return result;
}

const textPresent = (value, timeoutMs = 5000) => ({
  id: 'cp_test',
  assert: 'text-present',
  target: null,
  value,
  timeoutMs,
  onFail: 'fail',
});

/** Walks a member search through to the detail screen. */
async function search(memberId) {
  await act({ type: 'click' }, NAV_SEARCH);
  const arrived = await session.driver.check(textPresent('Search Criteria'));
  assert.ok(arrived.passed, `never reached search: ${arrived.observed}`);

  await act({ type: 'type', value: { from: 'literal', value: memberId }, clearFirst: true }, MEMBER_ID);
  await act({ type: 'click' }, SEARCH_BUTTON);
}

// The targets below are hand-written in the same shape the compiler will emit,
// so a change that breaks the compiler's output breaks these too.

const NAV_SEARCH = T({
  frame: ['nav'],
  expectedRole: 'link',
  expectedName: 'Member Search',
  candidates: [c('role-name', 'link:Member Search', 0.9), c('text', 'Member Search', 0.7)],
});

const MEMBER_ID = T({
  frame: ['content'],
  expectedRole: 'textbox',
  candidates: [
    c('automation-id', 'txtMemberId', 0.95),
    c('label-text', 'Member ID', 0.85),
    c('css', 'form[name=srch] input[name=mid]', 0.5),
  ],
});

const SEARCH_BUTTON = T({
  frame: ['content'],
  expectedRole: 'button',
  expectedName: 'Search',
  candidates: [c('role-name', 'button:Search', 0.9), c('css', 'input[value=Search]', 0.5)],
});

/**
 * The locator this whole design exists to justify: addressed by row and column,
 * not by position. tenant-b inserts a "Fees YTD" column ahead of Balance, which
 * shifts every positional selector by one and leaves this one untouched.
 */
const SAVINGS_BALANCE = T({
  frame: ['content'],
  containerHint: 'Account Summary',
  positionHint: 'Balance column of the Savings row',
  expectedRole: 'cell',
  candidates: [
    c('container-scoped-text', 'Account Summary >> row:Savings >> col:Balance', 0.9),
  ],
});

// -----------------------------------------------------------------------------

describe('observation', () => {
  test('the frameset becomes a navigable frame path', async () => {
    const observation = await session.driver.observe();

    assert.equal(observation.surface, 'legacy-web');
    assert.match(observation.location, /index\.htm$/);

    const frames = observation.root.children.filter((n) => n.role === 'frame');
    assert.deepEqual(
      frames.map((f) => f.name),
      ['nav', 'content'],
      'both frames must appear as named children of the top document',
    );
  });

  test('layout tables keep their table/row/cell roles', async () => {
    await search('12345');
    assert.ok((await session.driver.check(textPresent('Account Summary'))).passed);

    const observation = await session.driver.observe();
    const roles = new Set();
    const walk = (n) => {
      roles.add(n.role);
      n.children.forEach(walk);
    };
    walk(observation.root);

    // The point of computing roles ourselves: Chrome's own a11y tree reports
    // every one of these cells as `generic`.
    for (const role of ['table', 'row', 'cell']) {
      assert.ok(roles.has(role), `expected a ${role} role in the tree`);
    }
  });

  test('the digest tracks the screen, not the record on it', async () => {
    // Two different people, two different balances, one screen. The digest is
    // the only progress signal a frameset app offers — the top URL never moves —
    // so it has to be blind to the record and sharp about the screen.
    await search('24680');
    await session.driver.check(textPresent('Account Summary'));
    const dana = (await session.driver.observe()).digest;

    await search('55555');
    await session.driver.check(textPresent('Account Summary'));
    const priya = (await session.driver.observe()).digest;

    assert.equal(dana, priya, 'same screen shape, different record: must hash alike');

    await search('00000');
    await session.driver.check(textPresent('No records matched your search'));
    const empty = (await session.driver.observe()).digest;
    assert.notEqual(dana, empty, 'a different screen must hash differently');

    await search('99999');
    await session.driver.check(textPresent('You are not authorized to view this record'));
    const refused = (await session.driver.observe()).digest;
    assert.notEqual(dana, refused);
    assert.notEqual(empty, refused);
  });
});

describe('resolution', () => {
  test('a bundle whose candidates agree resolves uniquely', async () => {
    await session.driver.observe();
    const resolution = await session.driver.resolve(NAV_SEARCH);

    assert.equal(resolution.status, 'unique');
    assert.equal(resolution.agreement, 1);
    assert.equal(resolution.tried.length, 2);
    assert.ok(resolution.tried.every((t) => t.matched === 1));
  });

  test('candidates that point at different elements are a disagreement, not a guess', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));
    await session.driver.observe();

    const conflicted = T({
      frame: ['content'],
      candidates: [
        c('text', 'New Search', 0.5),
        c('text', 'Open Sub-Account', 0.5),
      ],
    });

    const resolution = await session.driver.resolve(conflicted);
    assert.equal(resolution.status, 'disagreement');
    assert.ok(resolution.agreement < 0.6);
    assert.equal(resolution.ref, null, 'a disagreement must never hand back an element');
  });

  test('an expectation mismatch demotes a candidate that still matches', async () => {
    await session.driver.observe();

    const drifted = T({
      frame: ['nav'],
      expectedRole: 'button', // it is a link; the DOM has not changed, our belief has
      candidates: [c('role-name', 'link:Member Search', 0.9)],
    });

    const resolution = await session.driver.resolve(drifted);
    assert.equal(resolution.status, 'not_found');
  });

  test('a missing frame is not_found rather than an exception', async () => {
    await session.driver.observe();
    const resolution = await session.driver.resolve(
      T({ frame: ['sidebar'], candidates: [c('text', 'anything', 0.5)] }),
    );
    assert.equal(resolution.status, 'not_found');
  });

  test('a control labelled only by an adjacent cell is found by adjacency', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));
    await act({ type: 'click' }, T({
      frame: ['content'],
      candidates: [c('role-name', 'link:Open Sub-Account', 0.9)],
    }));
    assert.ok((await session.driver.check(textPresent('Open Sub-Account'))).passed);

    await session.driver.observe();
    // No <label for> anywhere on this form; the only clue is the neighbouring td.
    const deposit = await session.driver.resolve(
      T({
        frame: ['content'],
        expectedRole: 'textbox',
        candidates: [c('label-text', 'Initial Deposit', 0.85)],
      }),
    );
    assert.equal(deposit.status, 'unique');
    assert.equal(deposit.matchedBy, 'label-text');
  });
});

describe('action and extraction', () => {
  test('a savings balance is read through row/column semantics', async () => {
    await search('12345');
    assert.ok((await session.driver.check(textPresent('Account Summary'))).passed);

    const result = await act({ type: 'extract', into: '$.outputs.balance', as: 'money' }, SAVINGS_BALANCE);
    assert.equal(result.extracted, '$4,231.08');
  });

  test('an unresolved parameter reference is refused at the seam', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));
    await session.driver.observe();

    const resolution = await session.driver.resolve(SAVINGS_BALANCE);
    const result = await session.driver.perform(
      { type: 'type', value: { from: 'input', ref: '$.inputs.memberId' }, clearFirst: true },
      resolution.ref,
    );

    assert.equal(result.ok, false);
    assert.match(result.detail, /unresolved parameter reference/);
  });

  test('extraction failure is a result, not a throw', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));
    await session.driver.observe();

    const resolution = await session.driver.resolve(SAVINGS_BALANCE);
    const result = await session.driver.perform(
      { type: 'extract', into: '$.outputs.when', as: 'date' },
      resolution.ref,
    );

    assert.equal(result.ok, false);
    assert.match(result.detail, /could not read 'date'/);
  });
});

describe('checkpoints', () => {
  test('a failing checkpoint reports what it saw, redacted', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));

    const result = await session.driver.check(textPresent('Loan Origination', 700));

    assert.equal(result.passed, false);
    assert.ok(result.waitedMs >= 700, 'it must actually have waited out its budget');
    assert.ok(
      !result.observed.includes('4,231.08'),
      'the balance must not survive into a checkpoint failure message',
    );
    assert.match(result.observed, /\[MONEY\]|text absent/);
  });

  test('text-absent is the business-outcome detector', async () => {
    await search('00000');
    const found = await session.driver.check(textPresent('No records matched your search'));
    assert.ok(found.passed, 'the not-found wording is part of the capability contract');
  });
});

describe('blocking conditions', () => {
  test('a native confirm() blocks the world and is cleared by an action', async () => {
    await search('77777');

    // The dialog is raised by a script during the content frame's load, so it
    // arrives after the click returns. Poll the observation rather than sleep.
    let observation = null;
    for (let i = 0; i < 40; i++) {
      observation = await session.driver.observe();
      if (observation.root.states.includes('modal-blocked')) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(observation.root.states.includes('modal-blocked'), 'the dialog must be visible');
    const dialog = observation.root.children[0];
    assert.equal(dialog.role, 'alertdialog');
    assert.match(dialog.name, /Scheduled maintenance/);

    // A checkpoint under a dialog says so, rather than failing opaquely.
    const blocked = await session.driver.check(textPresent('Account Summary', 300));
    assert.match(blocked.observed, /blocked by dialog/);

    const cleared = await session.driver.perform({ type: 'dismiss_dialog', accept: true }, null);
    assert.ok(cleared.ok);

    assert.ok((await session.driver.check(textPresent('Account Summary'))).passed);
  });

  test('dismissing when nothing is open fails cleanly', async () => {
    const result = await session.driver.perform({ type: 'dismiss_dialog', accept: true }, null);
    assert.equal(result.ok, false);
    assert.match(result.detail, /no dialog/);
  });

  test('an authorization refusal is detectable as text, not as an error', async () => {
    await search('99999');
    const denied = await session.driver.check(textPresent('You are not authorized to view this record'));
    assert.ok(denied.passed);
  });
});

describe('evidence', () => {
  test('screenshots are written with financial fields blacked out', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));

    const before = shots.length;
    const evidence = await session.driver.captureEvidence();

    assert.equal(shots.length, before + 1);
    assert.equal(evidence.screenshotRef, `shot-${shots.length}`);
    assert.equal(shots.at(-1).label, 'failure');

    // Proving something was actually painted, rather than that a file was
    // written: the same frame captured without the redaction pass must differ.
    const raw = await session.page.screenshot({ type: 'png' });
    const redacted = shots.at(-1).png;
    assert.ok(redacted.length > 0);
    assert.notEqual(
      Buffer.from(redacted).toString('base64'),
      Buffer.from(raw).toString('base64'),
      'the balance cells should have been blacked out before the PNG was handed over',
    );
  });

  test('what was painted over is reported, and the values are not (I3)', async () => {
    // A picture with rectangles on it carries no record of why they are there.
    // Without this the screenshot is the only sink that redacts silently, and a
    // run whose evidence is covered in black boxes summarises as `[]` — an audit
    // trail that under-reports its most visible sink.
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));
    await session.driver.captureEvidence();

    const { found } = shots.at(-1);
    assert.ok(found.length > 0, 'blacking out five fields should report something');

    for (const record of found) {
      assert.equal(record.sink, 'screenshot');
      assert.ok(record.count >= 1);
      assert.notEqual(record.classification, 'none');
      // The record has entity, classification, confidence and a count, and
      // nowhere to put a balance — which is the property, not an accident.
      assert.deepEqual(
        Object.keys(record).sort(),
        ['classification', 'confidence', 'count', 'entity', 'sink'],
      );
    }
  });

  test('pause does not disturb the session', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));

    await session.driver.pause();
    assert.equal(session.driver.paused, true);

    // The whole handoff design rests on this: the page a human takes over is the
    // same page, with the same cookies and the same screen on it.
    const observation = await session.driver.observe();
    assert.match(observation.location, /index\.htm$/);
    assert.ok((await session.driver.check(textPresent('Account Summary'))).passed);

    await session.driver.resume();
    assert.equal(session.driver.paused, false);
  });
});

describe('harvesting locator bundles', () => {
  test('a control yields several independent candidates, best first', async () => {
    await act({ type: 'click' }, NAV_SEARCH);
    await session.driver.check(textPresent('Search Criteria'));
    await session.driver.observe();

    const resolution = await session.driver.resolve(MEMBER_ID);
    const bundle = await session.driver.harvest(resolution.ref);

    assert.deepEqual(bundle.frame, ['content']);
    assert.equal(bundle.expectedRole, 'textbox');
    assert.equal(bundle.expectedName, 'Member ID');

    const strategies = bundle.candidates.map((c) => c.strategy);
    assert.ok(strategies.includes('automation-id'));
    assert.ok(strategies.includes('label-text'));
    assert.ok(strategies.length >= 4, `too few candidates: ${strategies.join(', ')}`);

    // Ordered by the compiler's prior belief that the candidate outlives the
    // application's next release — which is also the order a reviewer reads.
    const confidences = bundle.candidates.map((c) => c.confidence);
    assert.deepEqual(confidences, [...confidences].sort((a, b) => b - a));
    assert.equal(bundle.candidates[0].strategy, 'automation-id');

    // Every candidate must independently find the element it was harvested
    // from. Each is tested inside the bundle's own expectations and nowhere
    // else, because that is the only way a candidate is ever used: a bare
    // `Search Criteria >> Member ID` matches the <label> as well as the input,
    // and `expectedRole` is precisely what settles that.
    for (const candidate of bundle.candidates) {
      const single = await session.driver.resolve(
        T({ ...bundle, candidates: [candidate] }),
      );
      assert.equal(
        single.ref,
        resolution.ref,
        `${candidate.strategy} (${candidate.value}) did not round-trip`,
      );
    }
  });

  test('a data cell is harvested by row and column, not by position', async () => {
    await search('12345');
    await session.driver.check(textPresent('Account Summary'));
    await session.driver.observe();

    const cell = await session.driver.resolve(SAVINGS_BALANCE);
    const bundle = await session.driver.harvest(cell.ref);

    const scoped = bundle.candidates.find((c) => c.strategy === 'container-scoped-text');
    assert.ok(scoped, 'a table cell must get a row/column locator');
    assert.equal(scoped.value, 'Account Summary >> row:Savings >> col:Balance');
    assert.equal(bundle.containerHint, 'Account Summary');
    assert.equal(bundle.positionHint, 'Balance column of the Savings row');

    // And it must outrank the positional candidates in the same bundle, since
    // that ordering is the entire argument for storing a bundle at all.
    const positional = bundle.candidates.filter((c) =>
      ['structural-path', 'robula-xpath', 'css', 'viewport-coords'].includes(c.strategy),
    );
    assert.ok(positional.length > 0, 'the positional candidates should still be recorded');
    for (const weak of positional) {
      assert.ok(scoped.confidence > weak.confidence, `${weak.strategy} outranked row/column`);
    }
  });

  test('harvesting a dead ref returns null rather than throwing', async () => {
    await session.driver.observe();
    assert.equal(await session.driver.harvest('f9e999'), null);
    assert.equal(await session.driver.harvest('not-a-ref'), null);
  });
});

describe('heterogeneity', () => {
  test('the same target reads the balance on a tenant that inserted a column', async () => {
    const other = await openSession({
      baseUrl: BASE,
      entryPoint: '/tenant-b/admin/index.htm',
      username: 'teller01',
      password: 'letmein',
    });

    try {
      await other.driver.observe();
      const navLink = await other.driver.resolve(
        T({
          frame: ['nav'],
          expectedRole: 'link',
          // tenant-b calls the same function something else — the one difference
          // that a capability override has to carry.
          candidates: [c('role-name', 'link:Find Member', 0.9)],
        }),
      );
      assert.equal(navLink.status, 'unique');
      assert.ok((await other.driver.perform({ type: 'click' }, navLink.ref)).ok);
      assert.ok((await other.driver.check(textPresent('Search Criteria'))).passed);

      await other.driver.observe();
      const field = await other.driver.resolve(MEMBER_ID);
      await other.driver.perform(
        { type: 'type', value: { from: 'literal', value: '12345' }, clearFirst: true },
        field.ref,
      );
      await other.driver.observe();
      const button = await other.driver.resolve(SEARCH_BUTTON);
      await other.driver.perform({ type: 'click' }, button.ref);
      assert.ok((await other.driver.check(textPresent('Account Summary'))).passed);

      await other.driver.observe();
      const cell = await other.driver.resolve(SAVINGS_BALANCE);
      assert.equal(cell.status, 'unique', 'the row/column locator must survive the extra column');

      const extracted = await other.driver.perform(
        { type: 'extract', into: '$.outputs.balance', as: 'money' },
        cell.ref,
      );
      assert.equal(
        extracted.extracted,
        '$4,231.08',
        'a positional locator would have returned the Fees column here',
      );
    } finally {
      await other.close();
    }
  });
});
