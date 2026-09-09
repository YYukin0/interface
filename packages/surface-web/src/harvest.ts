import type { A11yNode, LocatorCandidate, Target } from '@cua/contracts';

import type { DomLocators } from './perceive.js';
import { descendants, flatten, norm, sameText, type FlatNode } from './tree.js';

/**
 * =============================================================================
 * HARVESTING A LOCATOR BUNDLE
 * =============================================================================
 * D7 in practice. At the instant the model acts on an element we ask several
 * independent heuristics "how would you find this again?", and store every
 * answer. Replay then resolves by agreement (see resolve.ts), which is what
 * turns a stale locator from a silent wrong click into an escalation.
 *
 * The confidences below are the interesting part of this file, because they are
 * a claim about the *future*: how likely is this candidate still to mean the
 * same element after the application's next release?
 *
 *   automation-id          0.95  a developer named it; names outlive layouts
 *   container-scoped-text  0.90  "Balance column of the Savings row" survives a
 *                                tenant inserting a column ahead of it — the
 *                                concrete case this project demonstrates
 *   role-name / label-text 0.85  the accessible contract; changes when the
 *                                wording changes, which is a change you *want*
 *                                to be told about
 *   text                   0.60  right kind of signal, but ambiguous on a page
 *                                that repeats a word
 *   css                    0.45  workflow-use marks these `[LEGACY] avoid in new
 *   robula-xpath           0.40  workflows`, and their reasoning matches ours:
 *                                both encode structure that changes for
 *                                cosmetic reasons
 *   structural-path        0.30  pure position; first thing to break
 *   viewport-coords        0.15  last resort, and only useful because the
 *                                viewport is pinned
 *
 * These are priors, not measurements. What makes them defensible is that they
 * are only ever used as *weights in a vote* — no single candidate can act alone,
 * so a prior that is somewhat wrong degrades agreement rather than causing a
 * wrong action.
 */

export const CONFIDENCE = {
  automationId: 0.95,
  containerScopedCell: 0.9,
  containerScopedText: 0.75,
  roleName: 0.85,
  labelText: 0.85,
  text: 0.6,
  css: 0.45,
  xpath: 0.4,
  structural: 0.3,
  coords: 0.15,
} as const;

/** Roles that can receive input, and whose label is therefore worth storing. */
const CONTROL_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'button']);

/** Roles whose name is page furniture, and so can act as a container hint. */
const CONTAINER_ROLES = new Set(['text', 'heading', 'form', 'table']);

export interface HarvestInput {
  readonly root: A11yNode;
  readonly ref: string;
  /** Frame name path from the top document, for `Target.frame`. */
  readonly framePath: readonly string[];
  readonly dom: DomLocators | null;
}

/**
 * Build the bundle. Candidates come out ordered by confidence, which is also the
 * order a human reviewing the artifact should read them in.
 */
export function harvestTarget(input: HarvestInput): Target | null {
  const all = flatten(input.root);
  const node = all.find((f) => f.node.ref === input.ref);
  if (!node) return null;

  const role = norm(node.node.role);
  const name = node.node.name;
  const candidates: LocatorCandidate[] = [];

  const add = (
    strategy: LocatorCandidate['strategy'],
    value: string | null | undefined,
    confidence: number,
    note: string,
  ): void => {
    if (!value || value.length === 0) return;
    if (candidates.some((c) => c.strategy === strategy)) return;
    candidates.push({ strategy, value, confidence, note });
  };

  add(
    'automation-id',
    input.dom?.automationId,
    CONFIDENCE.automationId,
    'id or name attribute; the closest thing to a developer-supplied handle',
  );

  if (name) {
    if (CONTROL_ROLES.has(role)) {
      add(
        'label-text',
        name,
        CONFIDENCE.labelText,
        'the text that labels this control, via <label for> or table adjacency',
      );
    }
    add('role-name', `${role}:${name}`, CONFIDENCE.roleName, 'accessible role and name');
  }

  const scoped = containerScoped(node, all);
  if (scoped) {
    add(
      'container-scoped-text',
      scoped.value,
      scoped.isCell ? CONFIDENCE.containerScopedCell : CONFIDENCE.containerScopedText,
      scoped.isCell
        ? 'addressed by row and column, so an inserted column does not move it'
        : 'text within a named container',
    );
  }

  // Bare text is only worth storing when it is actually distinguishing.
  if (name && all.filter((f) => sameText(f.node.name, name)).length === 1) {
    add('text', name, CONFIDENCE.text, 'unique visible text at capture time');
  }

  add('css', input.dom?.css, CONFIDENCE.css, 'LEGACY: encodes structure that changes cosmetically');
  add(
    'robula-xpath',
    input.dom?.xpath,
    CONFIDENCE.xpath,
    'LEGACY: ROBULA+-style, attribute predicates preferred over position',
  );
  add(
    'structural-path',
    structuralPath(node),
    CONFIDENCE.structural,
    'position in the accessibility tree; breaks on any inserted sibling',
  );
  add(
    'viewport-coords',
    input.dom?.coords,
    CONFIDENCE.coords,
    'last resort; only meaningful because the viewport is pinned',
  );

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);

  return {
    frame: [...input.framePath],
    containerHint: scoped?.container ?? null,
    positionHint: positionHint(node, scoped),
    // Stored so resolution can detect drift: a candidate that still matches, but
    // matches something whose role or name changed, has quietly stopped meaning
    // what it meant.
    expectedRole: node.node.role || null,
    expectedName: name,
    candidates,
  };
}

interface Scoped {
  readonly value: string;
  readonly container: string;
  readonly isCell: boolean;
  readonly row?: string;
  readonly column?: string;
}

/**
 * Express the element as "inside <container>", and for a table cell as
 * "row X, column Y".
 *
 * The table case is the one that earns this strategy its place at the top of the
 * bundle. Every other locator for a data cell encodes its position; this one
 * encodes its meaning, and position is exactly what a tenant changes.
 */
function containerScoped(node: FlatNode, all: readonly FlatNode[]): Scoped | null {
  const container = nearestContainer(node, all);
  if (!container) return null;

  if (norm(node.node.role) === 'cell') {
    const cell = rowAndColumn(node);
    if (cell) {
      return {
        value: `${container} >> row:${cell.row} >> col:${cell.column}`,
        container,
        isCell: true,
        row: cell.row,
        column: cell.column,
      };
    }
  }

  if (!node.node.name) return null;
  return { value: `${container} >> ${node.node.name}`, container, isCell: false };
}

/**
 * The nearest named thing that scopes this element: an ancestor, or — for the
 * `<div class="sec">Account Summary</div>` idiom this application is built from —
 * the nearest preceding named sibling of an ancestor.
 */
function nearestContainer(node: FlatNode, all: readonly FlatNode[]): string | null {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (cursor.node.name && CONTAINER_ROLES.has(norm(cursor.node.role))) {
      return cursor.node.name;
    }

    const preceding = (cursor.parent?.children ?? [])
      .filter((sibling) => sibling.order < cursor.order && sibling.node.name)
      .filter((sibling) => CONTAINER_ROLES.has(norm(sibling.node.role)))
      .at(-1);
    if (preceding?.node.name) return preceding.node.name;
  }
  return null;
}

function rowAndColumn(cell: FlatNode): { row: string; column: string } | null {
  const row = cell.parent;
  if (!row || norm(row.node.role) !== 'row') return null;

  const table = row.parent;
  if (!table) return null;

  const rows = [table, ...descendants(table)].filter((f) => norm(f.node.role) === 'row');
  const header = rows[0];
  if (!header || header === row) return null;

  const index = row.children.indexOf(cell);
  const column = header.children[index]?.node.name;
  const label = row.children[0]?.node.name;
  if (!column || !label || index === 0) return null;

  return { row: label, column };
}

/**
 * `table[1]/row[2]/cell[3]` — 1-based, counted among same-role *direct*
 * siblings, and rooted at the element's own frame rather than at the document.
 *
 * Both of those details have to match `matchStructuralPath` in resolve.ts
 * exactly, because this is the one strategy where the two halves of the system
 * have to agree on a grammar rather than on a value. A path that counts
 * descendants where the resolver counts children is a locator that harvests
 * cleanly and resolves to nothing.
 */
function structuralPath(node: FlatNode): string | null {
  const steps: string[] = [];

  for (let cursor: FlatNode | null = node; cursor; cursor = cursor.parent) {
    const parent = cursor.parent;
    // The frame root is where the resolver starts, so it is not a step.
    if (!parent || isFrameRoot(cursor)) break;

    const role = norm(cursor.node.role);
    const at = parent.children.filter((s) => norm(s.node.role) === role).indexOf(cursor);
    if (at === -1) return null;
    steps.unshift(`${role}[${at + 1}]`);

    if (isFrameRoot(parent)) break;
  }

  return steps.length > 0 ? steps.join('/') : null;
}

/** Our own ref convention: `f2e-root` is the synthetic root of frame `f2`. */
function isFrameRoot(node: FlatNode): boolean {
  return node.node.ref.endsWith('e-root');
}

/**
 * Prose for the human reading the artifact.
 *
 * Never parsed at runtime — see the note in resolve.ts. It exists so a reviewer
 * approving a capability can tell at a glance which cell a step reads, without
 * decoding a selector.
 */
function positionHint(node: FlatNode, scoped: Scoped | null): string | null {
  if (scoped?.isCell && scoped.row && scoped.column) {
    return `${scoped.column} column of the ${scoped.row} row`;
  }
  if (node.node.name) return `${node.node.role} labelled "${node.node.name}"`;
  return null;
}
