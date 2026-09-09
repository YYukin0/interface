import type { Checkpoint, RecordedStep } from '@cua/contracts';

/**
 * =============================================================================
 * CHECKPOINT INFERENCE
 * =============================================================================
 * A step without a checkpoint is a step that cannot tell "we clicked" from "it
 * worked". This module turns what the screen *gained* after an action into an
 * assertion replay can evaluate deterministically.
 *
 * Why `appeared` and not a DOM diff: what a screen loses is dominated by noise —
 * the old form vanishes, the spinner vanishes, focus moves — while what it gains
 * is almost always the thing the action was for. The recorder computes this at
 * capture time as `role:name` pairs (see `RecordedStep.appeared`), already
 * filtered to landmarks so a member's name can never become a checkpoint that
 * passes for exactly one person.
 *
 * The ordering rule below is the one design decision worth defending, and it is
 * in `pick`.
 */

/**
 * Roles whose accessible name is stable page furniture. `cell` and `row` are
 * absent: their names are record data, which is both a privacy problem and a
 * correctness one — a checkpoint asserting a particular member's row passes for
 * one caller and fails for everybody else.
 */
const USABLE_ROLES = new Set([
  'textbox',
  'button',
  'link',
  'combobox',
  'checkbox',
  'radio',
  'heading',
  'text',
  'form',
  'table',
]);

/** Names longer than this are sentences, not landmarks, and they get reworded. */
const MAX_NAME = 40;

export interface InferredCheckpoint {
  readonly checkpoint: Checkpoint;
  /** The `role:name` it came from, for the compile report. */
  readonly from: string;
}

/**
 * Choose an arrival assertion for `step`, given the step that follows it.
 *
 * Preference order, strongest first:
 *
 *   1. Something the NEXT step actually interacts with. This is the strongest
 *      possible arrival check and the reason checkpoints exist at all: asserting
 *      `textbox:Member ID` before typing into it means the failure is reported
 *      here, as "the search screen never opened", instead of two steps later as
 *      an unresolvable locator. It also rules out the classic false pass, where
 *      a heading renders while the form behind it is not yet interactive.
 *   2. A `text` landmark — the screen's own title, e.g. "Account Summary".
 *      Weaker, because painted text does not prove readiness, but it is what a
 *      human would name the screen and it reviews well.
 *   3. Any other usable landmark, in document order.
 *
 * Returns null when nothing survived, which the compiler reports as
 * `no_checkpoint_inferred` rather than papering over with a weaker assertion.
 */
export function inferCheckpoint(
  step: RecordedStep,
  next: RecordedStep | undefined,
  id: string,
  timeoutMs: number,
): InferredCheckpoint | null {
  const candidates = step.appeared.filter(usable);
  if (candidates.length === 0) return null;

  const wanted = next?.target?.expectedName;
  const wantedRole = next?.target?.expectedRole;
  const byNextStep =
    wanted && wantedRole
      ? candidates.find((key) => key === `${norm(wantedRole)}:${wanted}`)
      : undefined;

  const picked = byNextStep ?? candidates.find(isText) ?? candidates[0];
  if (picked === undefined) return null;

  return { checkpoint: assertionFor(picked, id, timeoutMs), from: picked };
}

/**
 * `text:Account Summary` becomes a page-wide text assertion; everything else
 * keeps its role.
 *
 * The asymmetry is not cosmetic. `role-name-present` on a `text` node would tie
 * the assertion to how this particular driver happened to name a bare string
 * node, which is the least portable thing in an accessibility tree — a desktop
 * driver would call it something else entirely. Text is text everywhere.
 */
function assertionFor(key: string, id: string, timeoutMs: number): Checkpoint {
  const [role = '', name = ''] = split(key);
  return role === 'text'
    ? { id, assert: 'text-present', value: name, target: null, timeoutMs }
    : { id, assert: 'role-name-present', value: `${role}:${name}`, target: null, timeoutMs };
}

function usable(key: string): boolean {
  const [role = '', name = ''] = split(key);
  if (!USABLE_ROLES.has(role)) return false;
  if (name.length < 3 || name.length > MAX_NAME) return false;
  // A name carrying digits is usually a record, a total, or a count, and any of
  // those makes the checkpoint caller-specific. `role-name-present` on
  // "3 accounts found" fails the moment somebody has four.
  return !/\d/.test(name);
}

function isText(key: string): boolean {
  return split(key)[0] === 'text';
}

/** `textbox:Member ID` → `['textbox', 'Member ID']`. Names may contain colons. */
function split(key: string): [string, string] {
  const at = key.indexOf(':');
  return at === -1 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
}

function norm(role: string): string {
  return role.trim().toLowerCase();
}
