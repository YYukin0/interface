/**
 * =============================================================================
 * PERCEPTION — runs inside the page
 * =============================================================================
 * Builds the accessibility-shaped tree that everything upstream reasons about.
 *
 * The decision worth defending: **we compute roles from the DOM ourselves
 * rather than reading Chrome's accessibility tree.**
 *
 * That sounds like reinventing a wheel the browser already ships. It is not,
 * and the target application is the proof. Chrome correctly decides that a
 * `<table>` used for layout carries no semantics and flattens it — every cell
 * in the member's account summary comes back as `generic` with no role and no
 * name. Verified against the fixture before writing this: the entire summary
 * table, the thing the whole capability exists to read, is invisible to the
 * accessibility tree. So is every `<td>` label on the sub-account form.
 *
 * A browser-agent that reads only `ariaSnapshot()` is therefore blind on
 * exactly the class of application this project is about. Computing roles from
 * tag names gives us `table`/`row`/`cell` back, which is what makes
 * "the Balance column of the Savings row" expressible — and that locator is the
 * one that survives tenant-b inserting a column ahead of it.
 *
 * The cost is honest and belongs in REPORT.md §6: our roles are *presentational*
 * where a browser's are *semantic*. On a modern app with real ARIA we would be
 * slightly worse than the platform tree, and on a legacy one we are the
 * difference between working and not.
 *
 * Everything in this file is serialised into the page by Playwright, so it may
 * not close over module scope. That is why it is one large function with nested
 * helpers rather than a tidy set of exports.
 */

export interface PerceiveOptions {
  /** Cap on emitted nodes; sets `truncated` when hit. */
  readonly maxNodes: number;
  /** Added to every box so coordinates are page-global across frames. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Prefix for refs emitted by this frame, e.g. `f2`. */
  readonly framePrefix: string;
}

/** JSON-safe mirror of `A11yNode`; the contract type is rebuilt from it. */
export interface RawNode {
  ref: string;
  role: string;
  name: string | null;
  value: string | null;
  states: string[];
  box: [number, number, number, number] | null;
  children: RawNode[];
}

export interface PerceiveResult {
  url: string;
  title: string | null;
  nodeCount: number;
  truncated: boolean;
  children: RawNode[];
}

/**
 * Walk the document and emit the tree.
 *
 * Also installs `window.__cua`, the ref → element table that `resolve` and
 * `perform` use afterwards. It lives on `window` because refs are valid only
 * within the observation that produced them (per the `A11yNode.ref` contract),
 * and a navigation destroying it is therefore correct rather than a bug.
 */
export function perceiveInPage(options: PerceiveOptions): PerceiveResult {
  const { maxNodes, offsetX, offsetY, framePrefix } = options;

  const nodes: Element[] = [];
  const index = new Map<Element, number>();
  let truncated = false;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE']);

  function collapse(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase().split(/\s+/)[0] ?? null;

    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';

    switch (tag) {
      case 'a':
        return el.hasAttribute('href') ? 'link' : null;
      case 'button':
        return 'button';
      case 'input': {
        const type = (el.getAttribute('type') ?? 'text').toLowerCase();
        if (type === 'hidden') return null;
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
          return 'button';
        }
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      }
      case 'select':
        return 'combobox';
      case 'textarea':
        return 'textbox';
      case 'option':
        return 'option';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'td':
      case 'th':
        return 'cell';
      case 'form':
        return 'form';
      case 'img':
        return 'image';
      case 'label':
        return 'label';
      default:
        return null;
    }
  }

  /** Text contributed directly by this element, not by its element children. */
  function directText(el: Element): string {
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
    }
    return collapse(out);
  }

  /** Roles whose accessible name is their rendered text. */
  const TEXT_NAMED = new Set(['link', 'button', 'heading', 'cell', 'option', 'label', 'text']);

  function nameOf(el: Element, role: string): string | null {
    const aria = collapse(el.getAttribute('aria-label'));
    if (aria) return aria;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => collapse(el.ownerDocument.getElementById(id)?.textContent))
        .filter((s) => s.length > 0);
      if (parts.length > 0) return parts.join(' ');
    }

    if (el.id) {
      const escaped = el.id.replace(/["\\]/g, '\\$&');
      const label = el.ownerDocument.querySelector(`label[for="${escaped}"]`);
      const text = collapse(label?.textContent);
      if (text) return text;
    }

    const wrapping = el.closest('label');
    if (wrapping && wrapping !== el) {
      const text = collapse(wrapping.textContent);
      if (text) return text;
    }

    // `<input type="button" value="Search">` — the accessible name is the
    // value attribute, and this is the single most common control on the
    // target application's screens.
    if (role === 'button' && el instanceof HTMLInputElement) {
      const value = collapse(el.value);
      if (value) return value;
    }

    const title = collapse(el.getAttribute('title'));
    if (title) return title;

    if (el instanceof HTMLImageElement) {
      const alt = collapse(el.alt);
      if (alt) return alt;
    }

    if (TEXT_NAMED.has(role)) {
      const text = collapse(el.textContent);
      // A cell holding a nested table would otherwise be "named" with the whole
      // subtree, which is worse than having no name at all.
      if (text && text.length <= 120) return text;
    }

    return null;
  }

  function valueOf(el: Element): string | null {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return null;
      return el.value === '' ? null : el.value;
    }
    if (el instanceof HTMLTextAreaElement) return el.value === '' ? null : el.value;
    if (el instanceof HTMLSelectElement) {
      return el.selectedOptions.length > 0 ? (el.selectedOptions[0]?.text ?? null) : null;
    }
    return null;
  }

  function statesOf(el: Element): string[] {
    const states: string[] = [];
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      states.push('disabled');
    }
    if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') {
      states.push('required');
    }
    if (el.hasAttribute('readonly')) states.push('readonly');
    if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      states.push(el.checked ? 'checked' : 'unchecked');
    }
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) states.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.ownerDocument.activeElement === el) states.push('focused');
    if (!isVisible(el)) states.push('hidden');
    return states;
  }

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function boxOf(el: Element): [number, number, number, number] | null {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return [
      Math.round(rect.x + offsetX),
      Math.round(rect.y + offsetY),
      Math.round(rect.width),
      Math.round(rect.height),
    ];
  }

  function emit(el: Element, role: string, children: RawNode[]): RawNode {
    const ordinal = nodes.length;
    nodes.push(el);
    index.set(el, ordinal);
    return {
      ref: `${framePrefix}e${ordinal}`,
      role,
      name: nameOf(el, role),
      value: valueOf(el),
      states: statesOf(el),
      box: boxOf(el),
      children,
    };
  }

  /**
   * Emit this element if it carries meaning, and recurse regardless.
   *
   * Meaningless wrappers are flattened rather than emitted with a null role:
   * a legacy page is four levels of `<td>` deep, and preserving that in the
   * tree we hand a model would spend the whole context budget on scaffolding.
   */
  function walk(el: Element): RawNode[] {
    if (SKIP.has(el.tagName)) return [];
    if (truncated) return [];

    // Frames are entered by the caller, one Playwright frame at a time; their
    // contents are not reachable from this document.
    if (el.tagName === 'FRAME' || el.tagName === 'IFRAME') return [];

    let role = roleOf(el);
    if (role === null && directText(el).length > 0) role = 'text';

    const children: RawNode[] = [];
    for (const child of el.children) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      children.push(...walk(child));
    }

    if (role === null) return children;
    if (nodes.length >= maxNodes) {
      truncated = true;
      return children;
    }
    return [emit(el, role, children)];
  }

  const children = document.body ? walk(document.body) : [];

  // The ref table the driver acts through. `index` is kept alongside so that
  // DOM-based strategies (css, xpath, coordinates) can map an element they
  // found back to the ref the rest of the system speaks in.
  (window as unknown as { __cua: unknown }).__cua = { nodes, index };

  return {
    url: location.href,
    title: document.title || null,
    nodeCount: nodes.length,
    truncated,
    children,
  };
}

/** The DOM-native half of a locator bundle. Nulls mean "not available here". */
export interface DomLocators {
  automationId: string | null;
  css: string | null;
  xpath: string | null;
  /** Normalised viewport centre, `"0.4213,0.6180"`. Resolution-independent. */
  coords: string | null;
}

/**
 * Harvest the DOM-specific locators for one element.
 *
 * Only the strategies that need a document live here. Role, name, label and
 * container-scoped locators are derived in Node from the tree we already have,
 * which keeps the role-computation logic in exactly one place and means a driver
 * with no DOM at all still gets four of the nine strategies for free.
 */
export function harvestInPage(args: { ordinal: number; framePrefix: string }): DomLocators | null {
  const store = (window as unknown as { __cua?: { nodes: Element[] } }).__cua;
  const found = store?.nodes[args.ordinal];
  if (!found) return null;
  const el: Element = found;

  const quote = (s: string): string => s.replace(/["\\]/g, '\\$&');

  /** `id` first, then `name` — a 2003 form uses `name` far more often. */
  function automationIdOf(): string | null {
    const id = el.getAttribute('id');
    // Framework-generated ids (`ctl00_x_1234`, `:r3:`) are churn, not identity.
    if (id && !/^\s*$/.test(id) && !/\d{4,}|^:|\$/.test(id)) return id;
    const name = el.getAttribute('name');
    if (name && !/\d{4,}/.test(name)) return name;
    return id || name || null;
  }

  /**
   * A short CSS selector, preferring anything that carries meaning.
   *
   * Deliberately does not walk the full ancestor chain: a selector like
   * `body > table:nth-child(2) > tbody > tr > td > table` is exactly the kind of
   * locator that breaks when a tenant inserts a row, and emitting it with a low
   * confidence is more honest than emitting it with a long one.
   */
  function cssOf(): string | null {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('id');
    if (id && !/\d{4,}|^:|\$/.test(id)) {
      try {
        return `#${CSS.escape(id)}`;
      } catch {
        /* fall through */
      }
    }

    const name = el.getAttribute('name');
    if (name) return `${tag}[name="${quote(name)}"]`;

    if (el instanceof HTMLInputElement && el.value && el.type !== 'text') {
      return `${tag}[value="${quote(el.value)}"]`;
    }

    const form = el.closest('form');
    const formName = form?.getAttribute('name');
    if (form && formName) {
      const scope = `form[name="${quote(formName)}"]`;
      const within = Array.from(form.querySelectorAll(tag));
      const at = within.indexOf(el);
      if (at !== -1) {
        return within.length === 1 ? `${scope} ${tag}` : `${scope} ${tag}:nth-of-type(${at + 1})`;
      }
    }

    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) return `a[href="${quote(href)}"]`;
    }
    return null;
  }

  /**
   * ROBULA+-flavoured XPath: walk up from the element adding predicates until
   * the expression is unique, rather than emitting a full positional path.
   *
   * The full algorithm has more refinement steps; this keeps its useful core —
   * prefer attributes over position, stop as soon as the path is unambiguous —
   * because the bundle is what provides robustness here, not any one member.
   */
  function xpathOf(): string | null {
    const unique = (expr: string): boolean => {
      try {
        const found = document.evaluate(
          expr,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        return found.snapshotLength === 1 && found.snapshotItem(0) === el;
      } catch {
        return false;
      }
    };

    const tag = el.tagName.toLowerCase();

    for (const attr of ['id', 'name', 'value', 'href']) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 80) continue;
      const expr = `//${tag}[@${attr}="${quote(value)}"]`;
      if (unique(expr)) return expr;
    }

    // Disambiguate among same-tag siblings before climbing: on a table-layout
    // page the element's own position under its parent is usually the only
    // thing separating it from a dozen identical cells.
    const twins = el.parentElement
      ? Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName)
      : [];
    let expr = twins.length > 1 ? `//${tag}[${twins.indexOf(el) + 1}]` : `//${tag}`;
    if (unique(expr)) return expr;

    // Climb one ancestor at a time, preferring an attribute predicate over a
    // positional one, and stopping as soon as the expression is unambiguous.
    let cursor: Element | null = el.parentElement;
    let depth = 0;

    while (cursor && depth < 8) {
      const parentTag = cursor.tagName.toLowerCase();
      const named = cursor.getAttribute('name')
        ? { attr: 'name', value: cursor.getAttribute('name') }
        : cursor.getAttribute('id')
          ? { attr: 'id', value: cursor.getAttribute('id') }
          : null;

      let step = parentTag;
      if (named?.value) {
        step = `${parentTag}[@${named.attr}="${quote(named.value)}"]`;
      } else if (cursor.parentElement) {
        const peers = Array.from(cursor.parentElement.children).filter(
          (c) => c.tagName === cursor?.tagName,
        );
        if (peers.length > 1) step = `${parentTag}[${peers.indexOf(cursor) + 1}]`;
      }

      expr = `//${step}${expr.replace(/^\/\//, '/')}`;
      if (unique(expr)) return expr;

      cursor = cursor.parentElement;
      depth++;
    }

    return null;
  }

  function coordsOf(): string | null {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    const x = (rect.x + rect.width / 2) / window.innerWidth;
    const y = (rect.y + rect.height / 2) / window.innerHeight;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return `${x.toFixed(4)},${y.toFixed(4)}`;
  }

  return {
    automationId: automationIdOf(),
    css: cssOf(),
    xpath: xpathOf(),
    coords: coordsOf(),
  };
}

/**
 * Look up elements by a DOM-native strategy and return their refs.
 *
 * Kept in the page because these three strategies are the only ones that cannot
 * be evaluated against the snapshot: they ask the document questions the tree
 * does not carry. Everything else resolves in Node against the tree, which is
 * both faster and portable to a driver that has no DOM at all.
 */
export function lookupInPage(args: {
  kind: 'css' | 'xpath' | 'point' | 'attr';
  value: string;
  framePrefix: string;
}): string[] {
  const store = (window as unknown as { __cua?: { nodes: Element[]; index: Map<Element, number> } })
    .__cua;
  if (!store) return [];

  const refFor = (el: Element | null): string | null => {
    if (!el) return null;
    // Walk up to the nearest ancestor that made it into the tree: a coordinate
    // hit or a CSS selector may land on a wrapper we deliberately flattened.
    let cursor: Element | null = el;
    while (cursor) {
      const at = store.index.get(cursor);
      if (at !== undefined) return `${args.framePrefix}e${at}`;
      cursor = cursor.parentElement;
    }
    return null;
  };

  const found: Element[] = [];

  if (args.kind === 'css') {
    try {
      found.push(...document.querySelectorAll(args.value));
    } catch {
      return [];
    }
  } else if (args.kind === 'xpath') {
    try {
      const result = document.evaluate(
        args.value,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node instanceof Element) found.push(node);
      }
    } catch {
      return [];
    }
  } else if (args.kind === 'attr') {
    // `automation-id` maps to whichever of id/name the legacy app happens to
    // use; both are tried because a 2003 form uses `name` far more often.
    const escaped = args.value.replace(/["\\]/g, '\\$&');
    try {
      found.push(...document.querySelectorAll(`#${CSS.escape(args.value)}`));
      found.push(...document.querySelectorAll(`[name="${escaped}"]`));
    } catch {
      /* an id that is not a valid selector simply does not match */
    }
  } else {
    const [nx, ny] = args.value.split(',').map(Number);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      const hit = document.elementFromPoint(
        (nx as number) * window.innerWidth,
        (ny as number) * window.innerHeight,
      );
      if (hit) found.push(hit);
    }
  }

  const refs: string[] = [];
  for (const el of found) {
    const ref = refFor(el);
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}
