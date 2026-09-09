import type {
  A11yNode,
  LocatorCandidate,
  LocatorStrategy,
  Resolution,
  Target,
} from '@cua/contracts';
import {
  byRef,
  descendants,
  flatten,
  named,
  norm,
  sameText,
  scopeOf,
  type FlatNode,
} from './tree.js';

/**
 * =============================================================================
 * MULTI-LOCATOR RESOLUTION
 * =============================================================================
 * D7: a target is an ordered *bundle* of candidates, and resolving it is a vote
 * rather than a first-match-wins scan.
 *
 * The reason for voting rather than falling through the list is the failure
 * mode that first-match hides. If candidate 1 is an XPath that still matches
 * *something* after the page changed, first-match happily clicks the wrong
 * control and reports success. Asking all of them and comparing answers turns
 * that silent wrong action into `disagreement`, which is the one resolution
 * status we never retry and always escalate.
 *
 * Two research and production sources converged on ordered bundles (Leotta et
 * al. ICST'15; workflow-use demoting `cssSelector`/`xpath` to `[LEGACY]`). What
 * neither supplies is what to do when they conflict, which is the part that
 * matters for an unattended system touching financial records.
 */

/**
 * Below this weighted agreement, a split vote is treated as drift rather than
 * as noise.
 *
 * 0.6 is a judgement call, and the shape of the judgement is what matters: with
 * a typical four-candidate bundle it means one dissenter is tolerated and two
 * are not. Set it to 1.0 and every cosmetic change escalates; set it to 0.34
 * and a majority of stale locators can outvote the correct one.
 */
export const AGREEMENT_MIN = 0.6;

/** Roles that can receive typed or selected input. */
const CONTROL_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'button']);

export type DomLookup = (
  kind: 'css' | 'xpath' | 'point' | 'attr',
  value: string,
  frame: string,
) => Promise<readonly string[]>;

export interface ResolveContext {
  readonly root: A11yNode;
  /** Maps a `Target.frame` path to the frame prefix used in refs. */
  readonly frameFor: (path: readonly string[]) => string | null;
  readonly lookup: DomLookup;
}

export async function resolveTarget(target: Target, ctx: ResolveContext): Promise<Resolution> {
  const frame = ctx.frameFor(target.frame);
  if (frame === null) {
    // A missing frame is `not_found` rather than an error: on this kind of app
    // it usually means the frameset was replaced by a login page, which the
    // caller classifies as session expiry — a recoverable condition, not a bug.
    return {
      status: 'not_found',
      ref: null,
      matchedBy: null,
      agreement: 0,
      tried: target.candidates.map((c) => ({ strategy: c.strategy, matched: 0, ref: null })),
    };
  }

  const all = flatten(ctx.root).filter((f) => f.frame === frame);
  const index = byRef(all);

  const tried: Resolution['tried'] = [];
  const votes = new Map<string, number>();
  const strategyOf = new Map<string, LocatorStrategy>();
  let totalWeight = 0;
  let anyMatched = false;

  for (const candidate of target.candidates) {
    let refs = await matchCandidate(candidate, all, frame, ctx.lookup);

    refs = refs.filter((ref) => passesExpectations(index.get(ref), target));
    if (refs.length > 1) refs = disambiguate(refs, index, all, target);

    tried.push({
      strategy: candidate.strategy,
      matched: refs.length,
      ref: refs.length === 1 ? (refs[0] ?? null) : null,
    });

    if (refs.length === 0) continue;
    anyMatched = true;

    // A strategy that matched several elements has an opinion about a set, not
    // about an element, so it does not vote — letting it back its first hit is
    // the first-match bug in disguise. It is skipped rather than fatal: a
    // sharper candidate later in the bundle can still settle the target.
    if (refs.length > 1) continue;

    const ref = refs[0] as string;
    votes.set(ref, (votes.get(ref) ?? 0) + candidate.confidence);
    totalWeight += candidate.confidence;
    if (!strategyOf.has(ref)) strategyOf.set(ref, candidate.strategy);
  }

  if (!anyMatched) {
    return { status: 'not_found', ref: null, matchedBy: null, agreement: 0, tried };
  }
  if (votes.size === 0) {
    return { status: 'ambiguous', ref: null, matchedBy: null, agreement: 0, tried };
  }

  const [winner, weight] = [...votes.entries()].reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  );
  const agreement = totalWeight === 0 ? 0 : weight / totalWeight;

  if (votes.size > 1 && agreement < AGREEMENT_MIN) {
    return { status: 'disagreement', ref: null, matchedBy: null, agreement, tried };
  }

  return {
    status: 'unique',
    ref: winner,
    matchedBy: strategyOf.get(winner) ?? null,
    agreement,
    tried,
  };
}

/**
 * Cross-check against what the artifact expected to find.
 *
 * This is cheap drift detection: a candidate that still matches an element, but
 * one whose role or name changed, is a candidate that has quietly stopped
 * meaning what it meant when it was recorded.
 */
function passesExpectations(node: FlatNode | undefined, target: Target): boolean {
  if (!node) return false;
  if (target.expectedRole !== null && norm(node.node.role) !== norm(target.expectedRole)) {
    return false;
  }
  if (target.expectedName !== null && !sameText(node.node.name, target.expectedName)) {
    return false;
  }
  return true;
}

/**
 * Narrow a multi-match using the container hint.
 *
 * `positionHint` is deliberately NOT used here. It is prose — "row labelled
 * Savings, Balance column" — and parsing prose into a selector is the thing this
 * whole design is trying to avoid. It stays in the artifact for the human
 * reviewing the step; the machine-usable version of the same information is a
 * `container-scoped-text` candidate. Recorded as a cut in REPORT.md §7.
 */
function disambiguate(
  refs: readonly string[],
  index: Map<string, FlatNode>,
  all: readonly FlatNode[],
  target: Target,
): string[] {
  if (target.containerHint === null) return [...refs];

  const containers = all.filter((f) => sameText(f.node.name, target.containerHint));
  if (containers.length === 0) return [...refs];

  const inScope = new Set(containers.flatMap((c) => scopeOf(c)).map((f) => f.node.ref));
  const narrowed = refs.filter((ref) => inScope.has(ref));
  return narrowed.length > 0 ? narrowed : [...refs];
}

async function matchCandidate(
  candidate: LocatorCandidate,
  all: readonly FlatNode[],
  frame: string,
  lookup: DomLookup,
): Promise<string[]> {
  switch (candidate.strategy) {
    case 'automation-id':
      return [...(await lookup('attr', candidate.value, frame))];
    case 'css':
      return [...(await lookup('css', candidate.value, frame))];
    case 'robula-xpath':
      return [...(await lookup('xpath', candidate.value, frame))];
    case 'viewport-coords':
      return [...(await lookup('point', candidate.value, frame))];

    case 'role-name': {
      const at = candidate.value.indexOf(':');
      if (at === -1) return [];
      const role = candidate.value.slice(0, at);
      const name = candidate.value.slice(at + 1);
      return named(all, name, role).map((f) => f.node.ref);
    }

    case 'text':
      return named(all, candidate.value).map((f) => f.node.ref);

    case 'label-text':
      return matchLabelText(all, candidate.value);

    case 'container-scoped-text':
      return matchContainerScoped(all, candidate.value);

    case 'structural-path':
      return matchStructuralPath(all, candidate.value);
  }
}

/**
 * Find a control by the text that labels it.
 *
 * Two paths, because the target application uses both. A control with a real
 * `<label for>` gets an accessible name and is found directly. A control whose
 * only label is the text in the neighbouring `<td>` — which is most of the
 * sub-account form — is found by table adjacency, which is web-specific
 * plumbing behind a portable strategy name (a UIA driver would use LabeledBy
 * here instead).
 */
function matchLabelText(all: readonly FlatNode[], label: string): string[] {
  const direct = all
    .filter((f) => CONTROL_ROLES.has(f.node.role) && sameText(f.node.name, label))
    .map((f) => f.node.ref);
  if (direct.length > 0) return direct;

  const found: string[] = [];
  for (const cell of all) {
    if (cell.node.role !== 'cell' || !sameText(cell.node.name, label)) continue;
    const row = cell.parent;
    if (!row) continue;
    const at = row.children.indexOf(cell);
    for (const sibling of row.children.slice(at + 1)) {
      const controls = [sibling, ...descendants(sibling)].filter((f) =>
        CONTROL_ROLES.has(f.node.role),
      );
      if (controls.length > 0) {
        found.push(...controls.map((f) => f.node.ref));
        break;
      }
    }
  }
  return found;
}

/**
 * `"Account Summary >> row:Savings >> col:Balance"` and `"Container >> Text"`.
 *
 * The table form is the important one and the reason this strategy sits at the
 * top of the bundle for data cells. Addressing a value by the row it is in and
 * the column it is under is immune to a tenant inserting a column ahead of it —
 * which tenant-b does, and which shifts every positional XPath by one. That is
 * the concrete payoff of storing a bundle rather than a selector, and it is
 * demonstrated rather than asserted: the same step runs on both tenants.
 */
function matchContainerScoped(all: readonly FlatNode[], value: string): string[] {
  const parts = value.split('>>').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return [];

  const [containerName, ...rest] = parts;
  const containers = all.filter((f) => sameText(f.node.name, containerName));
  if (containers.length === 0) return [];

  const found: string[] = [];
  for (const container of containers) {
    const scope = scopeOf(container);

    const rowPart = rest.find((p) => p.toLowerCase().startsWith('row:'));
    const colPart = rest.find((p) => p.toLowerCase().startsWith('col:'));

    if (rowPart && colPart) {
      const cell = findTableCell(scope, rowPart.slice(4).trim(), colPart.slice(4).trim());
      if (cell) found.push(cell.node.ref);
      continue;
    }

    for (const target of rest) {
      found.push(...scope.filter((f) => sameText(f.node.name, target)).map((f) => f.node.ref));
    }
  }
  return [...new Set(found)];
}

function findTableCell(scope: readonly FlatNode[], rowLabel: string, colLabel: string): FlatNode | null {
  const table = scope.find((f) => f.node.role === 'table');
  if (!table) return null;

  const rows = [table, ...descendants(table)].filter((f) => f.node.role === 'row');
  const header = rows[0];
  if (!header) return null;

  const columnIndex = header.children.findIndex((cell) => sameText(cell.node.name, colLabel));
  if (columnIndex === -1) return null;

  for (const row of rows.slice(1)) {
    const first = row.children[0];
    if (first && sameText(first.node.name, rowLabel)) {
      return row.children[columnIndex] ?? null;
    }
  }
  return null;
}

/**
 * `table[1]/row[2]/cell[3]` — 1-based, counted among same-role *direct*
 * children, starting from the frame root.
 *
 * `all` has already been narrowed to one frame, so the path is frame-relative
 * and never carries a `frame[n]` step. Descending by children rather than by
 * descendants is what makes each index mean the same thing here as it did in
 * `structuralPath` in harvest.ts; counting descendants at one end and children
 * at the other produces paths that resolve to a different element, or to none.
 */
function matchStructuralPath(all: readonly FlatNode[], path: string): string[] {
  const steps = path.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
  if (steps.length === 0) return [];

  // The one node in this frame whose parent lies outside it.
  const root = all.find((f) => f.parent === null || f.parent.frame !== f.frame);
  if (!root) return [];

  let level: readonly FlatNode[] = root.children;
  let current: FlatNode | null = null;

  for (const step of steps) {
    const parsed = /^([a-z-]+)\[(\d+)\]$/.exec(step);
    if (!parsed) return [];
    const [, role, nth] = parsed;
    const matches = level.filter((f) => norm(f.node.role) === norm(role ?? ''));
    const picked = matches[Number(nth) - 1];
    if (!picked) return [];
    current = picked;
    level = picked.children;
  }

  return current ? [current.node.ref] : [];
}
