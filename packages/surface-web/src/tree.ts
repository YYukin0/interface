import type { A11yNode } from '@cua/contracts';

/** A node plus the context the resolver needs: parent, siblings, order. */
export interface FlatNode {
  readonly node: A11yNode;
  readonly parent: FlatNode | null;
  /** Position in document order across the whole observation. */
  readonly order: number;
  /** `f0`, `f1`, … — which frame this node came from. */
  readonly frame: string;
  readonly children: FlatNode[];
}

/**
 * `f2e17`, and the per-frame root `f2e-root`.
 *
 * The root alternative matters: without it a frame's own root node inherits its
 * *parent's* frame, and a container hint naming the frame would then be filtered
 * out of that frame's candidate set.
 */
const REF = /^(f\d+)e(?:(\d+)|-root)$/;

export function frameOfRef(ref: string): string | null {
  return REF.exec(ref)?.[1] ?? null;
}

/** Index into that frame's `window.__cua.nodes`; null for a frame root. */
export function ordinalOfRef(ref: string): number | null {
  const n = REF.exec(ref)?.[2];
  return n === undefined ? null : Number(n);
}

/** Whitespace-insensitive, case-insensitive comparison for accessible names. */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return norm(a) === norm(b) && norm(a).length > 0;
}

export function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function flatten(root: A11yNode): FlatNode[] {
  const all: FlatNode[] = [];

  const visit = (node: A11yNode, parent: FlatNode | null): FlatNode => {
    const flat: FlatNode = {
      node,
      parent,
      order: all.length,
      frame: frameOfRef(node.ref) ?? parent?.frame ?? 'f0',
      children: [],
    };
    all.push(flat);
    for (const child of node.children) flat.children.push(visit(child, flat));
    return flat;
  };

  visit(root, null);
  return all;
}

export function byRef(all: readonly FlatNode[]): Map<string, FlatNode> {
  return new Map(all.map((f) => [f.node.ref, f]));
}

/** Every node beneath `from`, in document order, excluding `from` itself. */
export function descendants(from: FlatNode): FlatNode[] {
  const out: FlatNode[] = [];
  const stack = [...from.children];
  while (stack.length > 0) {
    const next = stack.shift();
    if (!next) break;
    out.push(next);
    stack.unshift(...next.children);
  }
  return out;
}

/**
 * The region a container hint refers to.
 *
 * Two shapes, because legacy markup uses both. A `<fieldset>`-like container
 * has its content as descendants. A section *heading* — `<div class="sec">
 * Account Summary</div>` followed by a table — has none, and what it labels is
 * its following siblings. Treating the second case as "no scope" would break
 * every container-scoped locator on the target application, so a childless
 * container scopes to what follows it within its parent.
 */
export function scopeOf(container: FlatNode): FlatNode[] {
  const own = descendants(container);
  if (own.length > 0) return own;
  if (!container.parent) return [];
  return container.parent.children
    .filter((sibling) => sibling.order > container.order)
    .flatMap((sibling) => [sibling, ...descendants(sibling)]);
}

/** Find nodes whose accessible name matches, optionally restricted by role. */
export function named(
  all: readonly FlatNode[],
  name: string,
  role?: string,
): FlatNode[] {
  return all.filter(
    (f) => sameText(f.node.name, name) && (role === undefined || norm(f.node.role) === norm(role)),
  );
}
