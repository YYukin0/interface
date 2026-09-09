import type { A11yNode, ActionType, AgentAction, RiskClass } from '@cua/contracts';

/**
 * =============================================================================
 * RISK INFERENCE
 * =============================================================================
 * Risk is a property of the step, not of the capability (PLAN §4): four
 * read-only steps followed by a submit is the normal shape of these flows, and
 * classifying the whole run by its worst step would either block everything or
 * wave everything through.
 *
 * This is a heuristic and is treated as one everywhere downstream — the compiler
 * emits a `risk_inferred` warning for every step whose class came from here, and
 * a human sees it before the capability is approved. What makes an approximate
 * classifier acceptable is the direction of its errors:
 *
 *   - it can only ever be *more* conservative than the truth for an unknown
 *     control, because an unrecognised click on a button defaults to `mutating`,
 *     not to `safe`;
 *   - and the one class where being wrong is unrecoverable, `irreversible`, is
 *     matched on verbs that have no benign reading in a banking back office.
 *
 * The policy engine, not this file, decides what happens to each class. Keeping
 * inference and disposition apart is what lets the policy stay a lookup table.
 */

/** Verbs with no undo in this domain. Deny, per policy.json (I8). */
const IRREVERSIBLE = /\b(transfer|wire|delete|remove|purge|void|close|disburse|payoff|charge|withdraw)\b/i;

/**
 * Verbs that change state but leave a human able to put it back.
 *
 * `new` is deliberately absent. It reads as mutating in "New Account" and as
 * navigation in "New Search", and a word that classifies both ways classifies
 * neither — a bare "New" button falls through to the unknown-control default,
 * which is `mutating` anyway. Keeping it out costs nothing and stops the
 * heuristic from being confidently wrong about a link back to a search form.
 */
const MUTATING = /\b(submit|save|create|add|update|post|apply|confirm|approve|send|process|open|enroll|activate)\b/i;

/** Read-only navigation words that would otherwise trip `MUTATING` on "open". */
const NAVIGATIONAL = /\b(search|find|look ?up|view|show|list|back|cancel|home|logout|print|next|previous)\b/i;

/**
 * Classify an action about to be taken.
 *
 * `node` is the control the action addresses, when it addresses one. It is
 * optional because the caller may be classifying an action whose ref no longer
 * resolves — in which case the unknown-control default applies, which is the
 * conservative one.
 */
export function inferRisk(action: AgentAction, node: A11yNode | null): RiskClass {
  switch (action.tool) {
    // Reading, pointing and filling in a field. Typing is safe on purpose: the
    // value has not been committed anywhere until something submits it, and
    // treating every keystroke as mutating would make the class meaningless.
    case 'type':
    case 'select':
    case 'set_checked':
    case 'scroll_into_view':
    case 'extract':
    case 'assert':
    case 'done':
    case 'stuck':
      return 'safe';

    // A URL is a GET on this class of application, and the policy allowlist has
    // already had its say about where it may point.
    case 'navigate':
      return 'safe';

    // Enter in a form is a submit in everything but name.
    case 'press_key':
      return /^(enter|numpadenter)$/i.test(action.key) ? 'mutating' : 'safe';

    // Accepting a dialog answers a question the application asked before doing
    // something; dismissing one declines it.
    case 'dismiss_dialog':
      return action.accept ? 'mutating' : 'safe';

    case 'click':
    case 'double_click':
      return riskOfActivating(node);
  }
}

function riskOfActivating(node: A11yNode | null): RiskClass {
  const label = [node?.name ?? '', node?.value ?? ''].join(' ').trim();
  if (IRREVERSIBLE.test(label)) return 'irreversible';
  if (NAVIGATIONAL.test(label) && !MUTATING.test(label)) return 'safe';
  if (MUTATING.test(label)) return 'mutating';

  // Links navigate; buttons and unknown controls submit until proven otherwise.
  if (node?.role === 'link') return 'safe';
  return 'mutating';
}

/** Map the model's vocabulary onto the policy engine's, which is action-only. */
export function policyActionOf(action: AgentAction): ActionType | null {
  switch (action.tool) {
    case 'click':
    case 'double_click':
    case 'type':
    case 'select':
    case 'set_checked':
    case 'press_key':
    case 'navigate':
    case 'scroll_into_view':
    case 'extract':
    case 'dismiss_dialog':
      return action.tool;
    // Not actions on the surface: they end or annotate a run and touch nothing,
    // so there is no policy question to ask about them.
    case 'assert':
    case 'done':
    case 'stuck':
      return null;
  }
}
