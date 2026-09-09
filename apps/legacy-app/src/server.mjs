/**
 * The automation target: a frameset-era credit union admin console.
 *
 * Not a product. A fixture, and the most important one in the project — the
 * brief grades runtime error handling third-highest, and no public demo site
 * can be asked to expire a session or deny entitlement on cue. See
 * `data.mjs` for why the faults are keyed by member id.
 *
 * Everything is in-memory and single-process. There is no database because
 * there is nothing to persist: the sub-account flow writes to a Map that dies
 * with the process, which is the correct amount of realism for a fixture whose
 * job is to be navigated, not to be a bank.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';

import { FAULTS, faultFor, findMember } from './data.mjs';
import { DEFAULT_TENANT, TENANTS, tenantOf } from './tenants.mjs';
import * as view from './render.mjs';

const PORT = Number(process.env.PORT ?? 8080);

/** How long the slow-load fault stalls for. Tunable so tests need not wait. */
const SLOW_LOAD_MS = Number(process.env.CUA_SLOW_LOAD_MS ?? 6000);

/**
 * The only credentials this app accepts. They come from the environment so the
 * automation reads them from the same place (I3: never from an artifact), and
 * they have defaults so `docker compose up` works with no setup.
 */
const OPERATOR_ID = process.env.CUA_APP_USERNAME || 'teller01';
const OPERATOR_PW = process.env.CUA_APP_PASSWORD || 'letmein';

/** @type {Map<string, { operator: string; createdAt: number }>} */
const sessions = new Map();

/** Sub-account requests accepted this process lifetime. Never read back. */
const subAccounts = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));

// -----------------------------------------------------------------------------
// Session plumbing
// -----------------------------------------------------------------------------

/** @param {import('express').Request} req */
function sessionIdOf(req) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'CUASESS') return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** @param {import('express').Request} req */
function isSignedOn(req) {
  const sid = sessionIdOf(req);
  return sid !== null && sessions.has(sid);
}

/** @param {import('express').Request} req */
function endSession(req) {
  const sid = sessionIdOf(req);
  if (sid) sessions.delete(sid);
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import('express').Response} res
 * @param {string} body
 * @param {number} [status]
 */
function html(res, body, status = 200) {
  res.status(status).type('html').send(body);
}

// -----------------------------------------------------------------------------
// Routes, mounted once per tenant
// -----------------------------------------------------------------------------

/**
 * Every route is registered twice, at `/admin/...` and `/tenant-b/admin/...`.
 *
 * The tenant lives in the URL rather than in a header or a subdomain for one
 * reason: `Capability.surface.entryPoint` is a path, and `CapabilityOverride`
 * can override exactly that field. So tenant-b's entire "where do I start"
 * difference is expressible as a one-line sparse patch, which is the property
 * the cross-tenant design is claiming.
 *
 * @param {import('./tenants.mjs').Tenant} t
 */
function mount(t) {
  const r = express.Router();

  /**
   * Content-frame pages all funnel through here so expiry looks the same
   * wherever it happens.
   *
   * @param {import('express').RequestHandler} handler
   * @returns {import('express').RequestHandler}
   */
  const guarded = (handler) => (req, res, next) => {
    if (!isSignedOn(req)) return html(res, view.sessionExpired(t));
    return handler(req, res, next);
  };

  // ---- sign on ------------------------------------------------------------

  r.get('/admin/index.htm', (req, res) => {
    if (!isSignedOn(req)) return html(res, view.login(t, null));
    return html(res, view.frameset(t));
  });

  r.get('/admin/login.htm', (_req, res) => html(res, view.login(t, null)));

  r.post('/admin/logon.do', (req, res) => {
    const { u, p } = req.body ?? {};
    if (u !== OPERATOR_ID || p !== OPERATOR_PW) {
      return html(res, view.login(t, 'Invalid operator ID or password.'), 200);
    }
    const sid = randomUUID();
    sessions.set(sid, { operator: String(u), createdAt: Date.now() });
    res.setHeader('Set-Cookie', `CUASESS=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    return res.redirect(302, `${t.basePath}/admin/index.htm`);
  });

  r.get('/admin/signoff.do', (req, res) => {
    endSession(req);
    return res.redirect(302, `${t.basePath}/admin/index.htm`);
  });

  // ---- frames -------------------------------------------------------------

  r.get('/admin/nav.htm', guarded((_req, res) => html(res, view.nav(t))));
  r.get('/admin/welcome.htm', guarded((_req, res) => html(res, view.welcome(t))));
  r.get('/admin/search.htm', guarded((_req, res) => html(res, view.search(t, null))));

  // ---- the flow under automation -----------------------------------------

  r.get(
    '/admin/detail.htm',
    guarded(async (req, res) => {
      const id = String(req.query.mid ?? '').trim();
      const inject = typeof req.query.inject === 'string' ? req.query.inject : undefined;

      if (id === '') return html(res, view.search(t, 'Member ID is required.'));
      if (!/^\d{1,5}$/.test(id)) {
        return html(res, view.search(t, 'Member ID must be numeric.'));
      }

      const fault = faultFor(id, inject);

      // Ordered deliberately: the two business outcomes are decided before any
      // of the recoverable conditions, because "this member does not exist" is
      // an answer and should never be reached by way of a retry loop.
      if (fault === FAULTS.MEMBER_NOT_FOUND) return html(res, view.noResults(t, id));
      if (fault === FAULTS.PERMISSION_DENIED) return html(res, view.denied(t), 403);

      if (fault === FAULTS.SESSION_EXPIRED) {
        endSession(req);
        return html(res, view.sessionExpired(t));
      }

      if (fault === FAULTS.SLOW_LOAD) await sleep(SLOW_LOAD_MS);

      const m = findMember(id);
      if (!m) return html(res, view.noResults(t, id));

      return html(res, view.detail(t, m, { dialog: fault === FAULTS.SURPRISE_DIALOG }));
    }),
  );

  r.get(
    '/admin/subacct.htm',
    guarded((req, res) => {
      const m = findMember(String(req.query.mid ?? ''));
      if (!m) return html(res, view.noResults(t, String(req.query.mid ?? '')));
      return html(res, view.subAccountForm(t, m, null));
    }),
  );

  r.post(
    '/admin/subacct.do',
    guarded((req, res) => {
      const { mid, atype, amt } = req.body ?? {};
      const m = findMember(String(mid ?? ''));
      if (!m) return html(res, view.noResults(t, String(mid ?? '')));

      const fault = faultFor(m.id, undefined);
      if (fault === FAULTS.VALIDATION_ERROR) {
        return html(
          res,
          view.subAccountForm(t, m, 'Initial deposit is below the $25.00 minimum for this product.'),
        );
      }
      if (!atype) {
        return html(res, view.subAccountForm(t, m, 'Account Type is required.'));
      }
      if (!/^\$?[\d,]+(\.\d{2})?$/.test(String(amt ?? ''))) {
        return html(res, view.subAccountForm(t, m, 'Initial Deposit must be an amount.'));
      }

      const number = `${String(atype).slice(0, 2).toUpperCase()}-${m.id}${
        String(subAccounts.size + 1).padStart(2, '0')
      }`;
      subAccounts.set(number, { member: m.id, type: atype, amount: amt });
      return html(res, view.subAccountConfirm(t, m, number));
    }),
  );

  app.use(t.basePath, r);
}

for (const t of Object.values(TENANTS)) mount(t);

// A bare `/` is the most likely thing a human types; send them somewhere useful.
app.get('/', (_req, res) => res.redirect(302, `${tenantOf(DEFAULT_TENANT).basePath}/admin/index.htm`));

/** Liveness for `docker compose`, and for the test harness to poll on. */
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

app.use((req, res) =>
  html(
    res,
    `<html><head><title>Not Found</title></head><body style="font-family:Verdana;font-size:11px">` +
      `<b>HTTP 404</b> &#8212; no such screen: ${String(req.path).replace(/[<>&]/g, '')}` +
      `</body></html>`,
    404,
  ),
);

const server = app.listen(PORT, () => {
  process.stdout.write(
    `legacy-app listening on http://localhost:${PORT}\n` +
      `  tenant-a  http://localhost:${PORT}/admin/index.htm\n` +
      `  tenant-b  http://localhost:${PORT}/tenant-b/admin/index.htm\n` +
      `  operator  ${OPERATOR_ID} / ${OPERATOR_PW === 'letmein' ? 'letmein (default)' : '(from env)'}\n`,
  );
});

/**
 * `npm run app` is the first command in the README, so its first failure is the
 * first impression. Unhandled, EADDRINUSE arrives as a twenty-line Node stack
 * ending in `Emitted 'error' event on Server instance`, which says nothing about
 * the one thing that went wrong or the one thing to do about it.
 *
 * The policy line is not padding. Moving the port is the obvious fix and it does
 * not work on its own: the policy engine is default-deny on origin, so replay
 * against a port that is not in `policy.json` refuses with POLICY_DENIED — which
 * is the engine behaving correctly and reads like a second, unrelated breakage.
 */
server.on('error', (cause) => {
  if (cause?.code !== 'EADDRINUSE') throw cause;
  process.stderr.write(
    `legacy-app: port ${PORT} is already in use.\n` +
      `  Often an earlier run that outlived its terminal. Find it with:\n` +
      `    lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n` +
      `  Or start somewhere else:\n` +
      `    PORT=8090 npm run app\n` +
      `  If you move it, add the new origin to policy.json's allowedOrigins and pass\n` +
      `  --origin http://localhost:8090 to replay; policy is default-deny on origin.\n`,
  );
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export { app, server };
