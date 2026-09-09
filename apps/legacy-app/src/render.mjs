/**
 * HTML for a credit union admin console that was last redesigned in 2003.
 *
 * The ugliness is the specification, not an accident of taste. The brief asks
 * for an intentionally hostile surface, and each hostile trait here exists to
 * defeat a specific automation shortcut:
 *
 *   no doctype           → quirks mode, the way these apps actually shipped
 *   <frameset>           → the element is never in the top document; every
 *                          locator needs a frame path (`Target.frame`)
 *   table layout, 4 deep → structural paths are long and fragile
 *   class="tbl1 r2 c3"   → class names carry no meaning, so CSS is a dead end
 *   no data-test-id      → nothing was put here for our benefit
 *   <input type=button>  → the accessible name comes from `value`, and the
 *                          submit happens in an onclick handler
 *   unlabelled inputs    → on the sub-account form the only clue is the text in
 *                          the adjacent <td>, which forces the resolver to do
 *                          table adjacency rather than read a11y `LabeledBy`
 *
 * Two things are deliberately NOT hostile, and the reason is worth recording.
 * The member-id field carries a real <label for>, and the search button's value
 * gives it an accessible name. A surface where *nothing* is nameable would make
 * every locator a coordinate, and the interesting question in this project is
 * how a bundle of locators degrades — not what happens when all of them are
 * equally blind. So the app is hostile in graded steps: named controls on the
 * search screen, adjacency-only on the sub-account form, and pure
 * row/column semantics in the summary table.
 */

/** @typedef {import('./tenants.mjs').Tenant} Tenant */
/** @typedef {import('./data.mjs').Member} Member */

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Chrome wrapper for a content-frame page.
 *
 * @param {Tenant} t
 * @param {string} title
 * @param {string} body
 */
function page(t, title, body) {
  return `<html>
<head><title>${esc(title)}</title>
<style type="text/css">
body { background: #ffffff; font-family: Verdana, Arial, sans-serif; font-size: 11px; margin: 0px; }
.tbl0 { width: 100%; border: 0px; }
.tbl1 { border: 1px solid #808080; border-collapse: collapse; }
.tbl1 td { border: 1px solid #c0c0c0; padding: 3px 6px; font-size: 11px; }
.hdr { background: ${t.headerBg}; color: #ffffff; padding: 4px 8px; font-weight: bold; font-size: 12px; }
.sec { background: ${t.accent}; font-weight: bold; padding: 2px 6px; font-size: 11px; }
.err { color: #cc0000; font-weight: bold; }
.r1 { background: ${t.accent}; font-weight: bold; }
.r2 { background: #ffffff; }
.r3 { background: #f0f0f0; }
a { color: #000080; }
</style>
</head>
<body>
<table class="tbl0" cellspacing="0" cellpadding="0"><tr><td class="hdr">${esc(t.institution)} &nbsp;&#8212;&nbsp; Core Admin 9.4</td></tr></table>
<table class="tbl0" cellspacing="0" cellpadding="8"><tr><td>
${body}
</td></tr></table>
</body></html>`;
}

/**
 * The sign-in screen. Served outside the frameset, because a login page inside
 * a frame is how you end up authenticating into a 180px-wide box.
 *
 * @param {Tenant} t
 * @param {string | null} error
 */
export function login(t, error) {
  return `<html>
<head><title>Sign On</title>
<style type="text/css">
body { background: #e8e8e8; font-family: Verdana, Arial, sans-serif; font-size: 11px; }
.box { background: #ffffff; border: 2px solid #808080; }
.hdr { background: ${t.headerBg}; color: #ffffff; padding: 4px 8px; font-weight: bold; }
.err { color: #cc0000; font-weight: bold; }
</style>
</head>
<body>
<table cellspacing="0" cellpadding="0" align="center"><tr><td>
<table class="box" cellspacing="0" cellpadding="0" width="380"><tr><td>
<table width="100%" cellspacing="0" cellpadding="0"><tr><td class="hdr">${esc(t.institution)} &#8212; Sign On</td></tr></table>
<form name="logon" method="post" action="${t.basePath}/admin/logon.do">
<table cellspacing="0" cellpadding="6"><tr><td>
${error ? `<div class="err">${esc(error)}</div><br>` : ''}
<table cellspacing="0" cellpadding="3">
<tr><td><label for="txtUser">Operator ID</label></td><td><input type="text" id="txtUser" name="u" size="18"></td></tr>
<tr><td><label for="txtPass">Password</label></td><td><input type="password" id="txtPass" name="p" size="18"></td></tr>
<tr><td colspan="2" align="right"><input type="submit" value="Sign On"></td></tr>
</table>
</td></tr></table>
</form>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

/** @param {Tenant} t */
export function frameset(t) {
  return `<html>
<head><title>${esc(t.institution)} Core Admin</title></head>
<frameset cols="180,*" border="1" frameborder="1">
  <frame name="nav" src="${t.basePath}/admin/nav.htm" scrolling="auto">
  <frame name="content" src="${t.basePath}/admin/welcome.htm" scrolling="auto">
</frameset>
<noframes><body>This application requires a frames-capable browser.</body></noframes>
</html>`;
}

/** @param {Tenant} t */
export function nav(t) {
  const item = (/** @type {string} */ href, /** @type {string} */ label) =>
    `<tr class="r2"><td class="c1"><a href="${t.basePath}${href}" target="content">${esc(label)}</a></td></tr>`;

  return `<html>
<head><title>Menu</title>
<style type="text/css">
body { background: ${t.accent}; font-family: Verdana, Arial, sans-serif; font-size: 11px; margin: 0px; }
.hdr { background: ${t.headerBg}; color: #ffffff; padding: 4px 6px; font-weight: bold; font-size: 11px; }
td { font-size: 11px; padding: 3px 6px; }
a { color: #000080; }
</style>
</head>
<body>
<table width="100%" cellspacing="0" cellpadding="0"><tr><td class="hdr">Main Menu</td></tr></table>
<table width="100%" cellspacing="0" cellpadding="0">
${item('/admin/search.htm', t.navLabel)}
${item('/admin/welcome.htm', 'Teller Batch')}
${item('/admin/welcome.htm', 'Reports')}
${item('/admin/welcome.htm', 'Card Services')}
<tr class="r2"><td class="c1"><a href="${t.basePath}/admin/signoff.do" target="_top">Sign Off</a></td></tr>
</table>
</body></html>`;
}

/** @param {Tenant} t */
export function welcome(t) {
  return page(
    t,
    'Welcome',
    `<div class="sec">Notices</div>
<table class="tbl1" cellspacing="0" cellpadding="0" width="480">
<tr class="r2"><td>Nightly posting completed 03:12. No exceptions.</td></tr>
<tr class="r3"><td>Reminder: dormancy fees assess on the last business day.</td></tr>
</table>
<br>
<font size="1">Select a function from the menu at left.</font>`,
  );
}

/**
 * Member search. The submit is an `<input type="button">` driven by an onclick
 * handler, which is how these screens were built and which means a locator that
 * only understands `<button>` elements finds nothing.
 *
 * @param {Tenant} t
 * @param {string | null} error
 */
export function search(t, error) {
  return page(
    t,
    'Member Search',
    `<div class="sec">Search Criteria</div>
<form name="srch" method="get" action="${t.basePath}/admin/detail.htm">
<table class="tbl1" cellspacing="0" cellpadding="0" width="420">
<tr class="r2">
  <td class="c1" width="120"><label for="txtMemberId">Member ID</label></td>
  <td class="c2"><input type="text" id="txtMemberId" name="mid" size="14" maxlength="5"></td>
</tr>
<tr class="r3">
  <td class="c1">Branch</td>
  <td class="c2"><select name="br"><option value="">(all)</option><option>Northgate</option><option>Riverside</option><option>Eastside</option></select></td>
</tr>
<tr class="r2">
  <td class="c1">&nbsp;</td>
  <td class="c2"><input type="button" value="Search" onclick="document.srch.submit()">&nbsp;<input type="reset" value="Clear"></td>
</tr>
</table>
</form>
${error ? `<br><div class="err">${esc(error)}</div>` : ''}
<br><font size="1">Enter a five digit member number.</font>`,
  );
}

/**
 * The account summary.
 *
 * Nothing in the table has an accessible name — the cells are bare text in a
 * grid. Finding the savings balance therefore means addressing it as "the
 * Balance column of the Savings row", which is the one strategy that survives
 * tenant-b inserting a Fees column ahead of it.
 *
 * @param {Tenant} t
 * @param {Member} m
 * @param {{ dialog?: boolean }} [opts]
 */
export function detail(t, m, opts = {}) {
  const cols = ['Account', 'Number', ...(t.showFees ? ['Fees YTD'] : []), 'Balance', 'Status'];

  const head = `<tr class="r1">${cols.map((c, i) => `<td class="c${i + 1}">${esc(c)}</td>`).join('')}</tr>`;

  const rows = m.accounts
    .map((a, i) => {
      const cells = [
        a.kind,
        a.number,
        ...(t.showFees ? [a.fees] : []),
        a.balance,
        a.status,
      ];
      return `<tr class="${i % 2 === 0 ? 'r2' : 'r3'}">${cells
        .map((v, j) => `<td class="c${j + 1}">${esc(v)}</td>`)
        .join('')}</tr>`;
    })
    .join('\n');

  // A native confirm() rather than a DOM overlay: an unhandled JavaScript
  // dialog genuinely blocks an automation driver, whereas an overlay is just
  // another element to click. We want the recovery path to be exercised for
  // real, so the interstitial has to be the kind that stops the world.
  const interstitial = opts.dialog
    ? `<script type="text/javascript">confirm("SYSTEM NOTICE: Scheduled maintenance window begins at 23:00. Continue?");</script>`
    : '';

  return page(
    t,
    'Member Detail',
    `${interstitial}
<div class="sec">Member Information</div>
<table class="tbl1" cellspacing="0" cellpadding="0" width="520">
<tr class="r2"><td class="c1" width="110">Member ID</td><td class="c2">${esc(m.id)}</td><td class="c3" width="90">Branch</td><td class="c4">${esc(m.branch)}</td></tr>
<tr class="r3"><td class="c1">Name</td><td class="c2">${esc(m.name)}</td><td class="c3">Joined</td><td class="c4">${esc(m.joined)}</td></tr>
</table>
<br>
<div class="sec">Account Summary</div>
<table class="tbl1" cellspacing="0" cellpadding="0" width="520">
${head}
${rows}
</table>
<br>
<a href="${t.basePath}/admin/subacct.htm?mid=${encodeURIComponent(m.id)}">Open Sub-Account</a>
&nbsp;|&nbsp;
<a href="${t.basePath}/admin/search.htm">New Search</a>`,
  );
}

/**
 * Empty result set. This is the MEMBER_NOT_FOUND business outcome's detection
 * surface, so the wording is part of the capability contract and changing it
 * breaks a declared outcome.
 *
 * @param {Tenant} t
 * @param {string} id
 */
export function noResults(t, id) {
  return page(
    t,
    'Member Search',
    `<div class="sec">Search Results</div>
<table class="tbl1" cellspacing="0" cellpadding="0" width="420">
<tr class="r2"><td class="c1">No records matched your search</td></tr>
</table>
<br>
<font size="1">Member number ${esc(id)} was not located on file.</font>
<br><br>
<a href="${t.basePath}/admin/search.htm">New Search</a>`,
  );
}

/** @param {Tenant} t */
export function denied(t) {
  return page(
    t,
    'Not Authorized',
    `<div class="sec">Security</div>
<table class="tbl1" cellspacing="0" cellpadding="0" width="420">
<tr class="r2"><td class="c1"><span class="err">You are not authorized to view this record</span></td></tr>
</table>
<br>
<font size="1">Contact your branch security officer to request entitlement CIF-VIEW-EXEC.</font>
<br><br>
<a href="${t.basePath}/admin/search.htm">New Search</a>`,
  );
}

/**
 * The one mutating flow in the app. Fields carry no <label for>; the only clue
 * is the text in the neighbouring <td>.
 *
 * @param {Tenant} t
 * @param {Member} m
 * @param {string | null} error
 */
export function subAccountForm(t, m, error) {
  return page(
    t,
    'Open Sub-Account',
    `<div class="sec">Open Sub-Account &#8212; ${esc(m.name)}</div>
${error ? `<br><div class="err">${esc(error)}</div>` : ''}
<form name="sub" method="post" action="${t.basePath}/admin/subacct.do">
<input type="hidden" name="mid" value="${esc(m.id)}">
<table class="tbl1" cellspacing="0" cellpadding="0" width="460">
<tr class="r2"><td class="c1" width="150">Account Type</td><td class="c2">
  <select name="atype"><option value="">(select)</option><option value="SV2">Secondary Savings</option><option value="HOL">Holiday Club</option><option value="VAC">Vacation Club</option></select>
</td></tr>
<tr class="r3"><td class="c1">Initial Deposit</td><td class="c2"><input type="text" name="amt" size="12"></td></tr>
<tr class="r2"><td class="c1">Statement Delivery</td><td class="c2"><input type="checkbox" name="paperless" value="Y"> Paperless</td></tr>
<tr class="r3"><td class="c1">&nbsp;</td><td class="c2"><input type="button" value="Submit Request" onclick="document.sub.submit()"></td></tr>
</table>
</form>
<br><a href="${t.basePath}/admin/detail.htm?mid=${encodeURIComponent(m.id)}">Back to Member</a>`,
  );
}

/**
 * @param {Tenant} t
 * @param {Member} m
 * @param {string} newNumber
 */
export function subAccountConfirm(t, m, newNumber) {
  return page(
    t,
    'Request Accepted',
    `<div class="sec">Confirmation</div>
<table class="tbl1" cellspacing="0" cellpadding="0" width="460">
<tr class="r2"><td class="c1" width="150">Status</td><td class="c2">Sub-account request accepted</td></tr>
<tr class="r3"><td class="c1">New Account Number</td><td class="c2">${esc(newNumber)}</td></tr>
<tr class="r2"><td class="c1">Member</td><td class="c2">${esc(m.name)}</td></tr>
</table>
<br><a href="${t.basePath}/admin/detail.htm?mid=${encodeURIComponent(m.id)}">Back to Member</a>`,
  );
}

/**
 * Shown when a content-frame request finds the session gone. It breaks out of
 * the frameset with a script, which is exactly the behaviour that makes session
 * expiry annoying to detect from inside a frame — a driver watching only the
 * content frame sees a login form appear where a member record should be.
 *
 * @param {Tenant} t
 */
export function sessionExpired(t) {
  return `<html>
<head><title>Session Ended</title>
<script type="text/javascript">if (window.top !== window.self) { window.top.location.href = "${t.basePath}/admin/index.htm"; }</script>
</head>
<body style="font-family: Verdana, Arial, sans-serif; font-size: 11px;">
<b class="err" style="color:#cc0000">Your session has ended due to inactivity.</b>
<br><br><a href="${t.basePath}/admin/index.htm" target="_top">Sign on again</a>
</body></html>`;
}
