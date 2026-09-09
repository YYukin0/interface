/**
 * =============================================================================
 * OPERATOR CONSOLE — CLIENT
 * =============================================================================
 * Frames in over `EventSource`, input out over `fetch`. No dependencies and no
 * build step, because the interesting part of this file is three decisions and
 * they should be readable without one.
 *
 *   1. **Coordinates leave here normalised to [0,1].** The canvas is scaled to
 *      fit whatever window the operator has; sending raw pixels would put every
 *      click in the wrong place on any display but the developer's. The server
 *      multiplies by the session's real viewport, which it knows and this page
 *      does not need to.
 *   2. **Mouse moves are coalesced to one per animation frame.** A `POST` per
 *      input is fine for clicks and keystrokes and absurd for `mousemove`, which
 *      fires hundreds of times a second. Only the latest position matters.
 *   3. **The lease decides whether input is even attempted.** The server refuses
 *      anything sent without it, so this is a courtesy rather than a control —
 *      but a console that fires hundreds of 409s at a session it does not hold
 *      is a console that has buried the one refusal that mattered.
 */

const token = new URLSearchParams(location.search).get('t') ?? '';
const api = (path) => `${path}?t=${encodeURIComponent(token)}`;

const el = (id) => document.getElementById(id);
const canvas = el('screen');
const ctx = canvas.getContext('2d');

let lease = null;
// Remembered across a reload so an operator who refreshes mid-takeover is still
// themselves. Without it the page comes back not knowing who it is, sees a lease
// held by "somebody", and offers a Take control button that answers 409 — the
// holder locked out of their own session by pressing F5.
let operatorId = sessionStorage.getItem('cua.operatorId');
let viewport = { width: 1280, height: 800 };

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

async function refresh() {
  const res = await fetch(api('/api/session'));
  if (!res.ok) return fail((await res.json()).error ?? `HTTP ${res.status}`);

  const state = await res.json();
  lease = state.lease;
  viewport = state.viewport;

  // Only when it actually changed. Assigning `canvas.width` at all resets the
  // drawing surface, so doing it unconditionally on a five-second poll blanks
  // the screen every five seconds — invisible on a page that repaints often and
  // total on the 2003 frameset this console exists for, which repaints never.
  if (canvas.width !== viewport.width || canvas.height !== viewport.height) {
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    if (image.complete && image.naturalWidth > 0) redraw();
  }

  const iv = state.intervention;
  el('reason').textContent = iv.reason;
  el('capability').textContent = iv.capabilityId ?? iv.goal ?? '—';
  el('step').textContent = iv.stepIntent ? `${iv.stepId} — ${iv.stepIntent}` : (iv.stepId ?? '—');
  el('explanation').textContent = iv.explanation;
  el('resume-from').textContent = iv.resumeFrom ?? 'the first step whose checkpoint is not yet true';
  el('evidence').textContent = iv.evidence.path;
  el('inputs').textContent =
    state.inputs === 0 ? 'No inputs recorded yet.' : `${state.inputs} input(s) recorded.`;

  paintLease();
}

function paintLease() {
  const held = lease?.holder ?? 'unknown';
  const mine = held === 'operator' && lease.holderId === operatorId;

  el('lease').textContent =
    held === 'operator'
      ? `held by ${lease.holderId}${mine ? ' (you)' : ''} until ${new Date(lease.expiresAt).toLocaleTimeString()}`
      : held === 'automation'
        ? 'held by automation — it has not asked for help'
        : 'nobody holds this session';

  el('lease').className = `lease ${held}`;
  canvas.classList.toggle('live', mine);
  el('claim').disabled = mine || held === 'automation';
  el('handback-controls').hidden = !mine;
  el('status').textContent = mine
    ? 'you have control — clicks and keys go to the live session'
    : 'view only — nobody has taken control';
}

function fail(message) {
  el('status').textContent = message;
  el('status').classList.add('error');
}

// -----------------------------------------------------------------------------
// Frames
// -----------------------------------------------------------------------------

const image = new Image();
const redraw = () => ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
image.onload = redraw;

const stream = new EventSource(api('/api/frames'));
stream.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  image.src = `data:image/${frame.format};base64,${frame.data}`;
};
stream.onerror = () => el('status').classList.add('stale');

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

const holdsIt = () => lease?.holder === 'operator' && lease.holderId === operatorId;

async function post(path, body) {
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (payload.lease) {
      lease = payload.lease;
      paintLease();
    }
    fail(payload.error ?? `HTTP ${res.status}`);
    return null;
  }
  return payload;
}

const send = (kind, event) => (holdsIt() ? post('/api/input', { kind, event }) : null);

/** Canvas pixels → [0,1], via the canvas's own on-screen size. */
function normalise(ev) {
  const box = canvas.getBoundingClientRect();
  return { x: (ev.clientX - box.left) / box.width, y: (ev.clientY - box.top) / box.height };
}

let pendingMove = null;
canvas.addEventListener('mousemove', (ev) => {
  if (!holdsIt()) return;
  const wasQueued = pendingMove !== null;
  pendingMove = normalise(ev);
  if (wasQueued) return;
  requestAnimationFrame(() => {
    const at = pendingMove;
    pendingMove = null;
    if (at !== null) void send('pointer', { type: 'move', ...at });
  });
});

canvas.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  canvas.focus();
  void send('pointer', { type: 'down', ...normalise(ev), button: BUTTON[ev.button] ?? 'left', clickCount: ev.detail || 1 });
});

canvas.addEventListener('mouseup', (ev) => {
  ev.preventDefault();
  void send('pointer', { type: 'up', ...normalise(ev), button: BUTTON[ev.button] ?? 'left', clickCount: ev.detail || 1 });
});

canvas.addEventListener(
  'wheel',
  (ev) => {
    if (!holdsIt()) return;
    ev.preventDefault();
    void send('pointer', { type: 'wheel', ...normalise(ev), deltaX: ev.deltaX, deltaY: ev.deltaY });
  },
  { passive: false },
);

canvas.addEventListener('keydown', (ev) => {
  if (!holdsIt()) return;
  // Otherwise Tab leaves the canvas and Backspace navigates back — both of
  // which are keys the operator is trying to send *to the application*.
  ev.preventDefault();
  void send('key', { type: 'down', key: ev.key, modifiers: modifiers(ev) });
});

canvas.addEventListener('keyup', (ev) => {
  if (!holdsIt()) return;
  ev.preventDefault();
  void send('key', { type: 'up', key: ev.key, modifiers: modifiers(ev) });
});

const BUTTON = { 0: 'left', 1: 'middle', 2: 'right' };

const modifiers = (ev) =>
  [ev.altKey && 'alt', ev.ctrlKey && 'ctrl', ev.metaKey && 'meta', ev.shiftKey && 'shift'].filter(
    Boolean,
  );

// -----------------------------------------------------------------------------
// Control transfer
// -----------------------------------------------------------------------------

el('claim').addEventListener('click', async () => {
  operatorId = el('operator').value.trim() || 'operator-1';
  sessionStorage.setItem('cua.operatorId', operatorId);
  const claimed = await post('/api/claim', { operatorId });
  if (claimed !== null) {
    lease = claimed;
    paintLease();
    canvas.focus();
  }
});

for (const [id, disposition] of [
  ['resume', 'resume'],
  ['done', 'completed_manually'],
  ['abort', 'abort'],
]) {
  el(id).addEventListener('click', async () => {
    const record = await post('/api/handback', { disposition, note: el('note').value.trim() });
    if (record === null) return;
    stream.close();

    // The page is now a receipt, not a control surface, and has to stop behaving
    // like one. Two things go wrong if it does not. The badge keeps saying
    // "held by you until 10:08 PM" over a session this operator has already let
    // go of — the one line on screen they would trust to tell them whether they
    // still have control, saying the opposite of the truth. And the poll below
    // outlives the intervention it was polling: `/api/session` answers 410 once
    // the intervention closes, so five seconds later `fail()` overwrites the
    // confirmation of what was just recorded with a stale HTTP error.
    clearInterval(poll);
    lease = null;
    el('lease').className = `lease ${disposition === 'resume' ? 'automation' : 'none'}`;
    el('lease').textContent =
      disposition === 'resume'
        ? 'handed back — automation has the session again'
        : 'handed back — this session is finished';

    el('handback-controls').hidden = true;
    canvas.classList.remove('live');
    el('status').textContent =
      `control handed back (${disposition}) — ${record.inputEvents.length} input(s) recorded ` +
      `in the audit trail. You can close this tab.`;
  });
}

if (operatorId !== null) el('operator').value = operatorId;

await refresh();
// Cheap and sufficient: a lease can expire while the operator is reading, and
// the page should say so rather than let them click into a session they no
// longer hold. Stopped on hand-back, where there is no longer a lease to watch.
const poll = setInterval(() => void refresh().catch(() => undefined), 5000);
