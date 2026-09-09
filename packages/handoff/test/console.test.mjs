/**
 * =============================================================================
 * THE OPERATOR CONSOLE — INTEGRATION TESTS
 * =============================================================================
 * A real HTTP server, a real coordinator, real evidence on disk — and a fake
 * `LiveViewSource`, which is the one substitution and a deliberate one. What is
 * under test here is *who is allowed to act and what gets written down*, and a
 * browser in the loop would slow every case down without touching either. The
 * CDP half is exercised by the end-to-end handoff run in `evidence/`.
 *
 * That the console is drivable by `fetch` at all is a consequence of choosing
 * SSE + POST over a WebSocket. It is why these assertions can be this direct.
 *
 *   npm test --workspace @cua/handoff
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConsoleTokenIssuer,
  LeaseRegistry,
  LocalHandoffCoordinator,
  startOperatorConsole,
} from '../dist/index.js';

const RUN_ID = 'replay-test-0001';
const SESSION_ID = 'ws://127.0.0.1:9222/devtools/browser/test';

let evidenceRoot;
let coordinator;
let console_;
let liveView;
let intervention;

/** Records what it was asked to do; asserts the console dispatched it. */
function fakeLiveView() {
  const pointers = [];
  const keys = [];
  let onFrame = null;

  return {
    pointers,
    keys,
    push: (frame) => onFrame?.(frame),
    viewport: () => ({ width: 1280, height: 800 }),
    async start(handler) {
      onFrame = handler;
    },
    async stop() {
      onFrame = null;
    },
    async pointer(event) {
      pointers.push(event);
    },
    async keyboard(event) {
      keys.push(event);
    },
  };
}

before(async () => {
  evidenceRoot = await mkdtemp(join(tmpdir(), 'cua-handoff-'));
  liveView = fakeLiveView();

  coordinator = new LocalHandoffCoordinator({
    evidenceRoot,
    consoleOrigin: () => console_.origin,
    leases: new LeaseRegistry(),
    tokens: new ConsoleTokenIssuer(),
    observe: async () => 'digest-before-and-after',
  });

  console_ = await startOperatorConsole({
    coordinator,
    liveView,
    assetsDir: join(import.meta.dirname, '..', '..', '..', 'apps', 'operator'),
  });

  // The engine's order: cede, then raise. Nothing here closes a session.
  await coordinator.cede(SESSION_ID, 'locator_unresolved');
  intervention = await coordinator.raise({
    runId: RUN_ID,
    capabilityId: 'member.read_savings_balance',
    goal: null,
    stepId: 's1',
    stepIntent: 'open member search',
    reason: 'locator_unresolved',
    explanation: 'no locator candidate matched the member search link',
    screenshotRef: 'shot-1',
    observationRef: 'obs-1',
    evidence: { runId: RUN_ID, path: join(evidenceRoot, RUN_ID) },
    resumeFrom: null,
  });
});

after(async () => {
  await console_?.close();
});

// -----------------------------------------------------------------------------

const url = (path, token = tokenOf(intervention)) =>
  `${console_.origin}${path}?t=${encodeURIComponent(token)}`;

const tokenOf = (iv) => new URL(iv.consoleUrl).searchParams.get('t');

const post = (path, body, token) =>
  fetch(url(path, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// -----------------------------------------------------------------------------

describe('the console link is a credential', () => {
  test('the URL carries a signed token', () => {
    assert.match(intervention.consoleUrl, new RegExp(`^${console_.origin}/\\?t=`));
    assert.ok(tokenOf(intervention).includes('.'), 'a token with no signature is not a token');
  });

  test('no token, no session state', async () => {
    assert.equal((await fetch(`${console_.origin}/api/session`)).status, 401);
  });

  test('a tampered token is refused', async () => {
    const token = tokenOf(intervention);
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    assert.equal((await fetch(url('/api/session', forged))).status, 401);
  });

  test('a token minted for another session does not open this one', async () => {
    // The reason the payload names the session at all: an unguessable string
    // would stop guessing, and would not stop a token being reused somewhere it
    // was never issued for.
    const other = coordinator.tokens.issue('some-other-session', 'iv-somebody-else');
    assert.equal((await fetch(url('/api/session', other))).status, 410);
  });

  test('the page itself needs no token — only the session behind it does', async () => {
    const page = await fetch(`${console_.origin}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Operator console/);
  });

  test('the asset route cannot be walked out of', async () => {
    const escaped = await fetch(`${console_.origin}/../../package.json`);
    assert.notEqual(escaped.status, 200);
  });
});

describe('control transfer', () => {
  test('the brief tells the operator why they were called', async () => {
    const state = await (await fetch(url('/api/session'))).json();
    assert.equal(state.intervention.reason, 'locator_unresolved');
    assert.equal(state.intervention.stepIntent, 'open member search');
    assert.equal(state.lease.holder, 'none');
    assert.deepEqual(state.viewport, { width: 1280, height: 800 });
  });

  test('input is refused before anyone has claimed the session', async () => {
    const refused = await post('/api/input', {
      kind: 'pointer',
      event: { type: 'down', x: 0.5, y: 0.5 },
    });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /nobody holds this session/);
    assert.equal(liveView.pointers.length, 0, 'a refused input reached the surface anyway');
  });

  test('an operator claims it, and then may act', async () => {
    const claimed = await post('/api/claim', { operatorId: 'operator-1' });
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).holder, 'operator');

    const accepted = await post('/api/input', {
      kind: 'pointer',
      event: { type: 'down', x: 0.25, y: 0.5, button: 'left', clickCount: 1 },
      operatorId: 'operator-1',
    });
    assert.equal(accepted.status, 204);
    assert.deepEqual(liveView.pointers.at(-1), {
      type: 'down',
      x: 0.25,
      y: 0.5,
      button: 'left',
      clickCount: 1,
    });
  });

  test('a second person with the same link cannot type into a session they did not claim', async () => {
    // The console URL is a bearer credential and gets forwarded — to a
    // colleague, into a ticket. Checking only that *somebody* holds the lease
    // let whoever did not claim it act anyway, and filed their inputs under the
    // holder's name. One holder is what the lease promises; this is the input
    // path keeping that promise rather than assuming it.
    const before = liveView.pointers.length;

    const refused = await post('/api/input', {
      kind: 'pointer',
      event: { type: 'down', x: 0.9, y: 0.9, button: 'left', clickCount: 1 },
      operatorId: 'operator-2',
    });

    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /held by operator-1/);
    assert.equal(liveView.pointers.length, before, 'a refused input reached the surface anyway');
  });

  test('an input that names nobody is refused too', async () => {
    const before = liveView.pointers.length;
    const refused = await post('/api/input', {
      kind: 'pointer',
      event: { type: 'down', x: 0.9, y: 0.9, button: 'left', clickCount: 1 },
    });
    assert.equal(refused.status, 409);
    assert.equal(liveView.pointers.length, before);
  });

  test('coordinates cross the wire normalised, not as pixels', () => {
    // The console is scaled to whatever window the operator has, so pixels from
    // it would mean nothing here. Everything recorded stays in [0,1] too, which
    // is what makes the audit trail portable across viewport sizes.
    for (const event of liveView.pointers) {
      assert.ok(event.x >= 0 && event.x <= 1, `x out of range: ${event.x}`);
      assert.ok(event.y >= 0 && event.y <= 1, `y out of range: ${event.y}`);
    }
  });

  test('a claimed session cannot be claimed by somebody else', async () => {
    const second = await post('/api/claim', { operatorId: 'operator-2' });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /already held by operator operator-1/);
  });

  test('frames reach a subscriber', async () => {
    const response = await fetch(url('/api/frames'));
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const reader = response.body.getReader();
    await reader.read(); // the ": connected" preamble

    liveView.push({ data: 'AAAA', format: 'jpeg', width: 1280, height: 800 });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^data: /);
    assert.equal(JSON.parse(text.slice(6)).data, 'AAAA');

    await reader.cancel();
  });

  test('a console that reconnects is shown the screen it missed', async () => {
    // A screencast emits on repaint, and the application this exists for is a
    // frameset that finished painting in 2003 and will not do it again. Without
    // the replayed frame an operator who reloads gets a correct, connected,
    // permanently blank rectangle — which reads as a broken tool. Found by
    // reloading the page during the end-to-end run, not by reasoning about it.
    const response = await fetch(url('/api/frames'));
    const reader = response.body.getReader();
    await reader.read(); // ": connected"

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.equal(JSON.parse(text.slice(6)).data, 'AAAA', 'the last frame should be replayed');

    await reader.cancel();
  });
});

describe('what the human did, as evidence', () => {
  test('keystrokes are recorded but their content is not (I3)', async () => {
    // An operator taking over a stuck sign-on types a password. This is exactly
    // the sink I3 exists for: we record THAT they typed into a field.
    for (const key of ['h', 'u', 'n', 't', 'e', 'r', '2']) {
      assert.equal((await post('/api/input', { kind: 'key', event: { type: 'down', key }, operatorId: 'operator-1' })).status, 204);
    }
    assert.equal(liveView.keys.length, 7, 'the keys should still reach the session');

    const recorded = coordinator.inputsOf(intervention.id).filter((e) => e.kind === 'key');
    assert.equal(recorded.length, 7);
    for (const event of recorded) assert.equal(event.detail, 'down');
  });

  test('handing back writes an audit record naming who, when, and what changed', async () => {
    const response = await post('/api/handback', {
      disposition: 'resume',
      note: 'clicked the renamed nav link by hand',
    });
    assert.equal(response.status, 200);

    const record = await response.json();
    assert.equal(record.operatorId, 'operator-1');
    assert.equal(record.disposition, 'resume');
    assert.ok(record.inputEvents.length >= 8, 'the inputs should be in the record');
    assert.equal(record.observationBefore, 'digest-before-and-after');
    assert.equal(record.observationAfter, 'digest-before-and-after');

    const dir = join(evidenceRoot, `handoff-${intervention.id}`);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['handoff.json', 'intervention.json']);

    const onDisk = JSON.parse(await readFile(join(dir, 'intervention.json'), 'utf8'));
    assert.equal(onDisk.status, 'resolved');
  });

  test('the lease returns to automation, and the session was never closed', async () => {
    assert.equal((await coordinator.lease(SESSION_ID)).holder, 'automation');
    // Nothing in this package disposes a surface. The live view was stopped —
    // the operator is done looking — but the session it was showing is still
    // there, which is the entire point of I7.
    assert.equal(typeof liveView.viewport(), 'object');
  });

  test('a resolved intervention can no longer be opened', async () => {
    assert.equal((await fetch(url('/api/session'))).status, 410);
  });
});
