/**
 * Seed data and the fault-injection table.
 *
 * Faults are keyed by *member id* rather than by a query parameter, and that is
 * the load-bearing decision in this file. The brief grades runtime error
 * handling; demonstrating it requires replaying the SAME artifact — with its
 * steps and locators frozen — and getting a different runtime condition out.
 * If the fault switch lived in the URL we would have to edit the capability to
 * provoke each case, which proves nothing about replay.
 *
 * So: `replay member.read_savings_balance --params '{"memberId":"00000"}'`
 * exercises the not-found path, `99999` the permission path, and so on, with
 * one unmodified artifact throughout.
 *
 * `?inject=` is still honoured as a manual override, for poking at the app by
 * hand without memorising ids.
 */

/** How the app misbehaves for a given member id. */
export const FAULTS = /** @type {const} */ ({
  NONE: 'none',
  /** Search returns an empty result set. A business outcome, not an error. */
  MEMBER_NOT_FOUND: 'member_not_found',
  /** Detail screen refuses on entitlement grounds. Also a business outcome. */
  PERMISSION_DENIED: 'permission_denied',
  /** Detail screen stalls. Recoverable by waiting. */
  SLOW_LOAD: 'slow_load',
  /** A native confirm() blocks the detail screen. Recoverable by dismissing. */
  SURPRISE_DIALOG: 'surprise_dialog',
  /** The session is invalidated mid-flow and the frame bounces to login. */
  SESSION_EXPIRED: 'session_expired',
  /** The sub-account form rejects every submission with a field error. */
  VALIDATION_ERROR: 'validation_error',
});

/**
 * @typedef {object} Account
 * @property {string} kind      Row label in the account summary table.
 * @property {string} number
 * @property {string} balance   Formatted as it appears on screen.
 * @property {string} fees      Only rendered by tenant-b, which inserted a column.
 * @property {'active'|'dormant'|'frozen'} status
 */

/**
 * @typedef {object} Member
 * @property {string} id
 * @property {string} name
 * @property {string} branch
 * @property {string} joined
 * @property {Account[]} accounts
 * @property {string} fault
 */

/** @type {Member[]} */
const MEMBERS = [
  member('12345', 'Renner, Alice M', 'Northgate', '1998-04-12', [
    account('Savings', 'SV-0012345', '$4,231.08', '$0.00', 'active'),
    account('Checking', 'CK-0012345', '$812.44', '$3.00', 'active'),
  ]),
  member('67890', 'Toledo, Marcus J', 'Riverside', '2006-11-02', [
    account('Savings', 'SV-0067890', '$18,904.55', '$0.00', 'active'),
    account('Checking', 'CK-0067890', '$2,140.19', '$3.00', 'active'),
    account('Certificate', 'CD-0067890', '$25,000.00', '$0.00', 'active'),
  ]),
  member('24680', 'Kwon, Dana', 'Northgate', '2019-07-30', [
    account('Savings', 'SV-0024680', '$312.40', '$5.00', 'dormant'),
  ]),

  // ---- members that exist but make the app misbehave -----------------------
  member(
    '55555',
    'Raman, Priya',
    'Eastside',
    '2011-02-18',
    [account('Savings', 'SV-0055555', '$1,000.00', '$0.00', 'active')],
    FAULTS.VALIDATION_ERROR,
  ),
  member(
    '66666',
    'Alvarez, Sam',
    'Riverside',
    '2003-09-09',
    [account('Savings', 'SV-0066666', '$77.10', '$0.00', 'active')],
    FAULTS.SESSION_EXPIRED,
  ),
  member(
    '77777',
    "O'Hara, Dave",
    'Eastside',
    '2015-01-05',
    [account('Savings', 'SV-0077777', '$5,600.00', '$0.00', 'active')],
    FAULTS.SURPRISE_DIALOG,
  ),
  member(
    '88888',
    'Lo, Susan',
    'Northgate',
    '2009-06-21',
    [account('Savings', 'SV-0088888', '$2,048.00', '$0.00', 'active')],
    FAULTS.SLOW_LOAD,
  ),
  member(
    '99999',
    'Cruz, Vera',
    'Executive',
    '1994-03-15',
    [account('Savings', 'SV-0099999', '$412,000.00', '$0.00', 'frozen')],
    FAULTS.PERMISSION_DENIED,
  ),
];

const BY_ID = new Map(MEMBERS.map((m) => [m.id, m]));

/** Ids that are syntactically valid but deliberately absent. */
export const KNOWN_ABSENT = ['00000', '11111'];

/**
 * @param {string} id
 * @param {string} name
 * @param {string} branch
 * @param {string} joined
 * @param {Account[]} accounts
 * @param {string} [fault]
 * @returns {Member}
 */
function member(id, name, branch, joined, accounts, fault = FAULTS.NONE) {
  return { id, name, branch, joined, accounts, fault };
}

/**
 * @param {string} kind
 * @param {string} number
 * @param {string} balance
 * @param {string} fees
 * @param {'active'|'dormant'|'frozen'} status
 * @returns {Account}
 */
function account(kind, number, balance, fees, status) {
  return { kind, number, balance, fees, status };
}

/** @param {string} id @returns {Member | null} */
export function findMember(id) {
  return BY_ID.get(String(id ?? '').trim()) ?? null;
}

/**
 * Which fault applies to this request.
 *
 * An explicit `?inject=` beats the member's own fault so a human can force any
 * case by hand; otherwise the member id decides.
 *
 * @param {string} id
 * @param {string | undefined} injectParam
 * @returns {string}
 */
export function faultFor(id, injectParam) {
  if (injectParam && Object.values(FAULTS).includes(injectParam)) return injectParam;
  const found = findMember(id);
  if (!found) return FAULTS.MEMBER_NOT_FOUND;
  return found.fault;
}

export { MEMBERS };
