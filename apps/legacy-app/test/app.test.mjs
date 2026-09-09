/**
 * The fixture's own tests.
 *
 * Narrow on purpose: these assert the *contract the capability depends on* —
 * the exact strings business outcomes detect, the frame names locators route
 * through, and that each fault id produces its fault. Everything else about
 * this app may change without anybody noticing.
 *
 *   node --test test/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

/** @type {import('node:child_process').ChildProcess} */
let child;
/** Cookie jar; one signed-on operator for the whole file. */
let cookie = '';

before(async () => {
  child = spawn(process.execPath, [join(here, '..', 'src', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), CUA_SLOW_LOAD_MS: '300' },
    stdio: 'ignore',
  });

  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const res = await fetch(`${BASE}/admin/logon.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'u=teller01&p=letmein',
    redirect: 'manual',
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie.startsWith('CUASESS='), 'sign-on must issue a session cookie');
});

after(() => child?.kill());

/** @param {string} path */
const get = (path, jar = cookie) =>
  fetch(`${BASE}${path}`, { headers: jar ? { cookie: jar } : {} });

// ---------------------------------------------------------------------------
// The frame contract: locators address elements through `Target.frame`
// ---------------------------------------------------------------------------

test('the entry point is a frameset with frames named nav and content', async () => {
  const body = await (await get('/admin/index.htm')).text();
  assert.match(body, /<frameset/i);
  assert.match(body, /name="nav"/);
  assert.match(body, /name="content"/);
});

test('an unauthenticated entry point serves the sign-on screen instead', async () => {
  const body = await (await get('/admin/index.htm', '')).text();
  assert.match(body, /Sign On/);
  assert.doesNotMatch(body, /<frameset/i);
});

// ---------------------------------------------------------------------------
// Strings that business outcomes detect on. Changing these breaks a contract.
// ---------------------------------------------------------------------------

test('an absent member yields the MEMBER_NOT_FOUND detection string', async () => {
  const body = await (await get('/admin/detail.htm?mid=00000')).text();
  assert.match(body, /No records matched your search/);
});

test('a restricted member yields the PERMISSION_DENIED detection string', async () => {
  const res = await get('/admin/detail.htm?mid=99999');
  assert.equal(res.status, 403);
  assert.match(await res.text(), /You are not authorized to view this record/);
});

test('a found member yields the Account Summary success checkpoint', async () => {
  const body = await (await get('/admin/detail.htm?mid=12345')).text();
  assert.match(body, /Account Summary/);
  assert.match(body, /\$4,231\.08/);
});

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

test('the surprise-dialog member ships a blocking confirm()', async () => {
  const body = await (await get('/admin/detail.htm?mid=77777')).text();
  assert.match(body, /confirm\(/);
});

test('the slow-load member takes measurably longer', async () => {
  const started = Date.now();
  await (await get('/admin/detail.htm?mid=88888')).text();
  assert.ok(Date.now() - started >= 250, 'expected the injected stall');
});

test('the session-expiry member kills the session for every subsequent request', async () => {
  const doomed = await fetch(`${BASE}/admin/logon.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'u=teller01&p=letmein',
    redirect: 'manual',
  });
  const jar = (doomed.headers.get('set-cookie') ?? '').split(';')[0];

  const first = await (await get('/admin/detail.htm?mid=66666', jar)).text();
  assert.match(first, /session has ended/i);

  const second = await (await get('/admin/search.htm', jar)).text();
  assert.match(second, /session has ended/i, 'the session must stay dead');
});

test('inject overrides the member id, so faults are reachable by hand', async () => {
  const body = await (await get('/admin/detail.htm?mid=12345&inject=permission_denied')).text();
  assert.match(body, /You are not authorized to view this record/);
});

test('the validation-error member is rejected by the sub-account form', async () => {
  const res = await fetch(`${BASE}/admin/subacct.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: 'mid=55555&atype=SV2&amt=500.00',
  });
  assert.match(await res.text(), /below the \$25\.00 minimum/);
});

test('a valid sub-account request is accepted', async () => {
  const res = await fetch(`${BASE}/admin/subacct.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: 'mid=12345&atype=HOL&amt=100.00',
  });
  const body = await res.text();
  assert.match(body, /Sub-account request accepted/);
});

// ---------------------------------------------------------------------------
// The two tenants differ in exactly the ways the override set claims
// ---------------------------------------------------------------------------

test('tenant-b renames the nav link, which is why s1 needs an override', async () => {
  const a = await (await get('/admin/nav.htm')).text();
  const b = await (await get('/tenant-b/admin/nav.htm')).text();
  assert.match(a, />Member Search</);
  assert.match(b, />Find Member</);
});

test('tenant-b inserts a Fees column, which is why s4 needs an override', async () => {
  const a = await (await get('/admin/detail.htm?mid=12345')).text();
  const b = await (await get('/tenant-b/admin/detail.htm?mid=12345')).text();
  assert.doesNotMatch(a, /Fees YTD/);
  assert.match(b, /Fees YTD/);
  // The row label and the header text are identical, so a semantic
  // row/column locator survives the shift and a positional one does not.
  assert.match(b, /Account Summary/);
  assert.match(b, />Savings</);
});

test('the search screen is identical across tenants, so s2 and s3 need no override', async () => {
  const a = await (await get('/admin/search.htm')).text();
  const b = await (await get('/tenant-b/admin/search.htm')).text();
  for (const body of [a, b]) {
    assert.match(body, /<label for="txtMemberId">Member ID<\/label>/);
    assert.match(body, /<input type="button" value="Search"/);
  }
});

/**
 * `npm run app` is the README's first command, so its first failure is the
 * reviewer's first impression. It used to be a raw Node stack trace.
 */
test('a port collision explains itself instead of printing a stack trace', async () => {
  // The `before` hook already holds PORT; a second process must lose the race.
  const second = spawn(process.execPath, [join(here, '..', 'src', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  second.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => second.on('exit', resolve));

  assert.equal(code, 1, 'it should exit non-zero rather than crash or linger');
  assert.match(stderr, new RegExp(`port ${PORT} is already in use`));
  assert.match(stderr, /PORT=8090 npm run app/);
  // Moving the port alone is not enough, and saying so here is the point:
  // policy is default-deny on origin, so replay would refuse the new one.
  assert.match(stderr, /default-deny on origin/);
  assert.doesNotMatch(stderr, /Emitted 'error' event|at Server\./);
});
