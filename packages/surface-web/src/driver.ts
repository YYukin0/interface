import { createHash } from 'node:crypto';
import type { BrowserContext, Dialog, ElementHandle, Frame, Page } from 'playwright';

import type {
  A11yNode,
  Action,
  ExtractAs,
  AssertionResult,
  Checkpoint,
  Observation,
  ObserveOptions,
  PerformResult,
  RedactionRecord,
  Resolution,
  Sensitivity,
  SurfaceDriver,
  SurfaceKind,
  Target,
  ValueSource,
} from '@cua/contracts';
import { DefaultRedactor } from '@cua/redact';

import {
  harvestInPage,
  lookupInPage,
  perceiveInPage,
  type DomLocators,
  type RawNode,
} from './perceive.js';
import { harvestTarget } from './harvest.js';
import { resolveTarget, type DomLookup } from './resolve.js';
import { flatten, frameOfRef, norm, ordinalOfRef, sameText } from './tree.js';

/**
 * =============================================================================
 * THE WEB SURFACE DRIVER
 * =============================================================================
 * One implementation of the seam (I6). Everything web-specific in this system
 * is behind this class: Playwright, CDP, frames, CSS, XPath.
 *
 * The interface it satisfies has no `Page`, no `Locator`, and no selector type,
 * which is what lets the same `Capability` describe a desktop application. The
 * desktop driver is designed and deliberately not built (REPORT.md §7), but the
 * seam is load-bearing rather than aspirational: nothing above this file can
 * name a browser concept, and the compiler emits no locator strategy that a
 * UIA/AX driver could not implement.
 */

const DEFAULT_MAX_NODES = 1200;
/** Poll interval for checkpoint waits. Explicit waiting only — never sleeps. */
const POLL_MS = 150;
/**
 * Per-action budget inside the driver.
 *
 * Shorter than any step timeout on purpose: a step's budget is meant to cover
 * an action plus its checkpoint plus a recovery attempt or two, so an action
 * that hangs must give up early enough to leave room for that.
 */
const ACTION_TIMEOUT_MS = 5000;

/**
 * How long to hold the door open for a navigation an action may have started.
 * A ceiling, not a delay: see `#withNavigation`.
 */
const NAV_GRACE_MS = 300;

export interface WebDriverOptions {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly redactor?: DefaultRedactor;
  /** Surfaced in `Observation.surface`; `legacy-web` for frameset-era apps. */
  readonly kind?: SurfaceKind;
  /**
   * Screenshots are written through this so evidence is redacted at source.
   *
   * `found` is what was painted over, summarised the same way the text sinks
   * summarise theirs — entity, classification, confidence, count, no values and
   * no coordinates. Passing it is not optional politeness: without it the
   * screenshot is the one sink that redacts silently, and `redactions.json`
   * reports `[]` for a run whose evidence has five black boxes in it. An audit
   * summary that under-reports the most visible sink is worse than none.
   */
  readonly onScreenshot?: (
    png: Uint8Array,
    label: string,
    found: readonly RedactionRecord[],
  ) => Promise<string>;
  readonly onSnapshot?: (json: unknown, label: string) => Promise<string>;
}

export class PlaywrightSurfaceDriver implements SurfaceDriver {
  readonly kind: SurfaceKind;

  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #redactor: DefaultRedactor;
  readonly #options: WebDriverOptions;

  /** Frame prefix → Playwright frame, valid for the latest observation only. */
  #frames = new Map<string, Frame>();
  /** Frame name path (joined by `/`) → prefix, for `Target.frame` lookups. */
  #framePaths = new Map<string, string>();
  #lastObservation: Observation | null = null;

  /**
   * Dialogs are queued, not auto-dismissed.
   *
   * Playwright's default is to dismiss every dialog silently, which would make
   * the target application's maintenance `confirm()` invisible — and an
   * interstitial the automation never noticed is one it never proved it can
   * recover from. Holding the dialog makes it a real blocking condition that
   * the replay engine classifies and clears through a recovery rule.
   */
  #dialogs: Dialog[] = [];
  #paused = false;

  constructor(options: WebDriverOptions) {
    this.#context = options.context;
    this.#page = options.page;
    this.#redactor = options.redactor ?? new DefaultRedactor();
    this.#options = options;
    this.kind = options.kind ?? 'legacy-web';

    this.#page.on('dialog', (dialog) => {
      this.#dialogs.push(dialog);
    });
  }

  /** The page, for the handoff layer only. Nothing above the seam may call it. */
  get page(): Page {
    return this.#page;
  }

  get redactor(): DefaultRedactor {
    return this.#redactor;
  }

  // ---------------------------------------------------------------------------
  // Observation
  // ---------------------------------------------------------------------------

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

    if (this.#dialogs.length > 0) {
      return this.#dialogObservation();
    }

    this.#frames = new Map();
    this.#framePaths = new Map();

    const { node, count, truncated } = await this.#perceiveFrame(
      this.#page.mainFrame(),
      [],
      { x: 0, y: 0 },
      maxNodes,
      { next: 0 },
    );

    let screenshotRef: string | null = null;
    if (options.withScreenshot) {
      screenshotRef = await this.#capture(node, 'observation');
    }

    const observation: Observation = {
      at: new Date().toISOString(),
      surface: this.kind,
      location: this.#page.url(),
      title: (await this.#page.title()) || null,
      root: node,
      digest: digestOf(node),
      screenshotRef,
      truncated: truncated || count >= maxNodes,
    };

    this.#lastObservation = observation;
    return observation;
  }

  /**
   * Recurse the frame tree, giving each frame its own ref prefix.
   *
   * Child frames are appended as siblings of the parent document's content
   * rather than nested at the `<frame>` element's position. On a `<frameset>`
   * the element has no meaningful place in the visual order anyway, and keeping
   * the frame subtrees adjacent is what makes `Target.frame` a flat path.
   */
  async #perceiveFrame(
    frame: Frame,
    path: readonly string[],
    offset: { x: number; y: number },
    maxNodes: number,
    counter: { next: number },
  ): Promise<{ node: A11yNode; count: number; truncated: boolean }> {
    const prefix = `f${counter.next++}`;
    this.#frames.set(prefix, frame);
    this.#framePaths.set(path.join('/'), prefix);

    let result: Awaited<ReturnType<typeof perceiveInPage>>;
    try {
      result = await frame.evaluate(perceiveInPage, {
        maxNodes,
        offsetX: offset.x,
        offsetY: offset.y,
        framePrefix: prefix,
      });
    } catch {
      // A frame that navigated mid-observation is reported as empty rather than
      // failing the whole observation: the caller will see the checkpoint fail
      // and classify it, which is more useful than a driver exception.
      result = { url: frame.url(), title: null, nodeCount: 0, truncated: false, children: [] };
    }

    const children = result.children.map(toA11yNode);
    let count = result.nodeCount;
    let truncated = result.truncated;

    for (const child of frame.childFrames()) {
      const childOffset = await frameOffset(child, offset);
      const sub = await this.#perceiveFrame(
        child,
        [...path, child.name() || `#${counter.next}`],
        childOffset,
        Math.max(0, maxNodes - count),
        counter,
      );
      children.push(sub.node);
      count += sub.count;
      truncated ||= sub.truncated;
    }

    return {
      node: {
        ref: `${prefix}e-root`,
        role: path.length === 0 ? 'document' : 'frame',
        name: path.at(-1) ?? null,
        value: null,
        states: [],
        box: null,
        children,
      },
      count,
      truncated,
    };
  }

  /**
   * What the world looks like while a JavaScript dialog is open: nothing else,
   * because nothing else is reachable.
   *
   * Modelled as an `alertdialog` node rather than as a new field on
   * `Observation`, so a desktop driver reporting a modal window produces the
   * same shape and the replay engine needs no web-specific branch.
   */
  #dialogObservation(): Observation {
    const dialog = this.#dialogs[0];
    const root: A11yNode = {
      ref: 'f0e-root',
      role: 'document',
      name: null,
      value: null,
      states: ['modal-blocked'],
      box: null,
      children: [
        {
          ref: 'f0e-dialog',
          role: 'alertdialog',
          name: dialog?.message() ?? null,
          value: dialog?.type() ?? null,
          states: [],
          box: null,
          children: [],
        },
      ],
    };

    const observation: Observation = {
      at: new Date().toISOString(),
      surface: this.kind,
      location: this.#lastObservation?.location ?? this.#page.url(),
      title: null,
      root,
      digest: digestOf(root),
      screenshotRef: null,
      truncated: false,
    };
    this.#lastObservation = observation;
    return observation;
  }

  // ---------------------------------------------------------------------------
  // Resolution and action
  // ---------------------------------------------------------------------------

  async resolve(target: Target): Promise<Resolution> {
    const root = this.#lastObservation?.root ?? (await this.observe()).root;

    const lookup: DomLookup = async (kind, value, frame) => {
      const handle = this.#frames.get(frame);
      if (!handle) return [];
      try {
        return await handle.evaluate(lookupInPage, { kind, value, framePrefix: frame });
      } catch {
        return [];
      }
    };

    return resolveTarget(target, {
      root,
      frameFor: (path) => this.#framePaths.get(path.join('/')) ?? null,
      lookup,
    });
  }

  async perform(action: Action, ref: string | null): Promise<PerformResult> {
    /** Lazily resolved: the three page-scoped actions never need an element. */
    const element = async (): Promise<ElementHandle<Element>> => {
      const handle = await this.#handleFor(ref);
      if (!handle) {
        throw new Error(`ref '${ref ?? '(null)'}' is not resolvable in this observation`);
      }
      return handle;
    };

    try {
      switch (action.type) {
        case 'navigate':
          await this.#page.goto(action.to, { waitUntil: 'domcontentloaded' });
          return ok();

        case 'dismiss_dialog': {
          const dialog = this.#dialogs.shift();
          if (!dialog) return fail('no dialog was open');
          if (action.accept) await dialog.accept();
          else await dialog.dismiss();
          return ok();
        }

        case 'press_key':
          await this.#withNavigation(() => this.#page.keyboard.press(action.key));
          return ok();

        case 'click':
          await this.#withNavigation(async () =>
            (await element()).click({ timeout: ACTION_TIMEOUT_MS }),
          );
          return ok();

        case 'double_click':
          await this.#withNavigation(async () =>
            (await element()).dblclick({ timeout: ACTION_TIMEOUT_MS }),
          );
          return ok();

        case 'type': {
          // Resolved before anything is touched: if the caller handed down an
          // unsubstituted parameter reference, the field must be left exactly as
          // it was rather than cleared and then abandoned half-edited.
          const text = literalOf(action.value);
          const target = await element();
          if (action.clearFirst) await target.fill('', { timeout: ACTION_TIMEOUT_MS });
          await target.fill(text, { timeout: ACTION_TIMEOUT_MS });
          return ok();
        }

        case 'select': {
          const option = literalOf(action.value);
          await (await element()).selectOption(option, { timeout: ACTION_TIMEOUT_MS });
          return ok();
        }

        case 'set_checked':
          await (await element()).setChecked(action.checked, { timeout: ACTION_TIMEOUT_MS });
          return ok();

        case 'scroll_into_view':
          await (await element()).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
          return ok();

        case 'extract': {
          const raw = await this.#readValue(await element());
          if (raw === null) return fail('element carried no readable text or value');
          const coerced = coerce(raw, action.as);
          if (coerced === null) return fail(`could not read '${action.as}' from the element`);
          return { ok: true, extracted: coerced, detail: null };
        }
      }
    } catch (error) {
      // Driver detail is redacted before it leaves: Playwright puts the
      // element's text into timeout messages, and that text is member data.
      return fail(this.#redactor.redactText(messageOf(error)).text);
    }
  }

  /**
   * Run an action that might navigate, and do not return until it has.
   *
   * This exists because of a property of `<frameset>` applications that is easy
   * to miss and expensive to discover: the top-level URL never changes, so
   * nothing about the page tells a caller that the *content* frame just went
   * somewhere else. An observation taken immediately after a click can catch
   * that frame between documents and see it empty — which reads downstream as
   * "the action changed nothing", i.e. as a dead end, on a step that in fact
   * worked perfectly.
   *
   * The listener is armed *before* the action, and that ordering is the whole
   * trick. After the fact there is no way to distinguish "this click navigated
   * and the new document has not arrived" from "this click navigated nowhere":
   * both look like the old page. Arming first turns the question into an event
   * we either receive or do not.
   *
   * The grace period is the cost of the click that navigates nowhere, and it is
   * a ceiling rather than a delay — a navigation resolves it the instant it
   * starts. Note that no fixed wait reaches replay, which times itself on
   * checkpoints (D6); this is a perception concern, and it is local to the one
   * driver that has frames.
   */
  async #withNavigation<T>(act: () => Promise<T>): Promise<T> {
    const navigated = this.#page
      .waitForEvent('framenavigated', { timeout: NAV_GRACE_MS })
      .catch(() => null);

    const result = await act();

    const frame = await navigated;
    // A frame detached by its own navigation rejects rather than resolving;
    // that is not a failure of the action that caused it.
    //
    // The timeout is load-bearing and was missing here at first. Without it this
    // line inherits Playwright's 30-second default, and a slow response is
    // absorbed *inside* the action — which sounds harmless and is not: it puts a
    // half-minute wait on a code path that no checkpoint budget governs, and it
    // makes the engine's `transient_load` recovery unreachable, because the slow
    // load has already finished by the time anything asks. Both are the same
    // mistake, that a fixed wait down here can decide how patient a run is.
    // Bounded, the driver only smooths over the instant between documents; how
    // long to wait for a page is the checkpoint's decision (D6).
    if (frame !== null) {
      await frame
        .waitForLoadState('domcontentloaded', { timeout: NAV_GRACE_MS })
        .catch(() => undefined);
    }
    return result;
  }

  /**
   * Build the locator bundle for a ref, now, while the DOM that produced it is
   * still on screen.
   *
   * Split deliberately: the DOM-native strategies are computed in the page, and
   * the role/name/container ones in Node against the tree we already hold. That
   * keeps role computation in exactly one place, and means the portable half of
   * every bundle is produced by code a desktop driver could reuse verbatim.
   */
  async harvest(ref: string): Promise<Target | null> {
    const observation = this.#lastObservation ?? (await this.observe());

    const prefix = frameOfRef(ref);
    const ordinal = ordinalOfRef(ref);
    const frame = prefix === null ? undefined : this.#frames.get(prefix);
    if (ordinal === null || !frame || prefix === null) return null;

    let dom: DomLocators | null = null;
    try {
      dom = await frame.evaluate(harvestInPage, { ordinal, framePrefix: prefix });
    } catch {
      // A frame that navigated mid-harvest costs us the DOM-native candidates.
      // The tree-derived ones still stand, so this degrades rather than fails.
      dom = null;
    }

    return harvestTarget({
      root: observation.root,
      ref,
      framePath: this.#framePathOf(prefix),
      dom,
    });
  }

  /** Inverse of `#framePaths`: prefix → the frame name path targets use. */
  #framePathOf(prefix: string): readonly string[] {
    for (const [path, at] of this.#framePaths) {
      if (at === prefix) return path.length === 0 ? [] : path.split('/');
    }
    return [];
  }

  async #handleFor(ref: string | null): Promise<ElementHandle<Element> | null> {
    if (ref === null) return null;
    const ordinal = ordinalOfRef(ref);
    const frame = this.#frames.get(frameOfRef(ref) ?? '');
    if (ordinal === null || !frame) return null;

    const handle = await frame.evaluateHandle(
      (i: number) =>
        (window as unknown as { __cua?: { nodes: Element[] } }).__cua?.nodes[i] ?? null,
      ordinal,
    );
    const element = handle.asElement();
    return (element as ElementHandle<Element> | null) ?? null;
  }

  async #readValue(element: ElementHandle<Element>): Promise<string | null> {
    return element.evaluate((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
      if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.text ?? '';
      return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  /**
   * Wait for a condition, polling.
   *
   * This is the ONLY way this system waits. There is no `sleep(ms)` in the
   * action vocabulary, because a fixed sleep makes a replay's outcome a function
   * of how loaded the machine is — which is the definition of non-deterministic.
   */
  async check(checkpoint: Checkpoint): Promise<AssertionResult> {
    const started = Date.now();
    let observed = '(never evaluated)';

    for (;;) {
      const result = await this.#evaluateOnce(checkpoint);
      observed = result.observed;
      if (result.passed) {
        return {
          passed: true,
          expected: checkpoint.value,
          observed,
          waitedMs: Date.now() - started,
        };
      }
      if (Date.now() - started >= checkpoint.timeoutMs) {
        return {
          passed: false,
          expected: checkpoint.value,
          observed: this.#redactor.redactText(observed).text,
          waitedMs: Date.now() - started,
        };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async #evaluateOnce(checkpoint: Checkpoint): Promise<{ passed: boolean; observed: string }> {
    // A dialog blocks everything, so a checkpoint under one is neither passing
    // nor meaningfully failing — say so, and let the caller recover.
    if (this.#dialogs.length > 0) {
      return { passed: false, observed: `blocked by dialog: ${this.#dialogs[0]?.message() ?? ''}` };
    }

    const observation = await this.observe();
    const nodes = flatten(observation.root);

    switch (checkpoint.assert) {
      case 'location-matches': {
        const passed = matchesLocation(observation.location, checkpoint.value);
        return { passed, observed: observation.location };
      }

      case 'text-present':
      case 'text-absent': {
        const haystack = await this.#allText();
        const present = haystack.toLowerCase().includes(checkpoint.value.toLowerCase());
        const want = checkpoint.assert === 'text-present';
        return {
          passed: present === want,
          observed: present ? `text present` : `text absent; page reads "${excerpt(haystack)}"`,
        };
      }

      case 'role-name-present': {
        const at = checkpoint.value.indexOf(':');
        const role = checkpoint.value.slice(0, at);
        const name = checkpoint.value.slice(at + 1);
        const hit = nodes.find(
          (f) => norm(f.node.role) === norm(role) && sameText(f.node.name, name),
        );
        return {
          passed: hit !== undefined,
          observed: hit
            ? `found ${hit.node.role}:${hit.node.name ?? ''}`
            : `no ${role} named '${name}'; nearest roles present: ${nearestRoles(nodes, role)}`,
        };
      }

      case 'element-visible':
      case 'element-absent':
      case 'value-equals': {
        // The schema guarantees a target for these three, but the type is still
        // nullable; treat the impossible case as a failed assertion rather than
        // as an exception, so a bad artifact degrades into a readable failure.
        if (checkpoint.target === null) {
          return { passed: false, observed: 'checkpoint has no target' };
        }
        const resolution = await this.resolve(checkpoint.target);

        if (checkpoint.assert === 'element-absent') {
          return {
            passed: resolution.status === 'not_found',
            observed: `resolution ${resolution.status}`,
          };
        }
        if (resolution.status !== 'unique' || resolution.ref === null) {
          return { passed: false, observed: `resolution ${resolution.status}` };
        }

        const node = flatten(observation.root).find((f) => f.node.ref === resolution.ref);
        if (checkpoint.assert === 'element-visible') {
          const hidden = node?.node.states.includes('hidden') ?? true;
          return { passed: !hidden, observed: hidden ? 'element hidden' : 'element visible' };
        }

        const actual = node?.node.value ?? node?.node.name ?? '';
        return { passed: sameText(actual, checkpoint.value), observed: actual };
      }
    }
  }

  async #allText(): Promise<string> {
    const parts: string[] = [];
    for (const frame of this.#page.frames()) {
      try {
        parts.push(await frame.evaluate(() => document.body?.innerText ?? ''));
      } catch {
        /* frame navigated away mid-read */
      }
    }
    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Evidence and lifecycle
  // ---------------------------------------------------------------------------

  async captureEvidence(): Promise<{ screenshotRef: string; snapshotRef: string }> {
    const observation = this.#lastObservation ?? (await this.observe());
    const screenshotRef = await this.#capture(observation.root, 'failure');
    const snapshotRef =
      (await this.#options.onSnapshot?.(observation, 'failure')) ?? '(not persisted)';
    return { screenshotRef, snapshotRef };
  }

  /**
   * Screenshot, with financial and personal fields blacked out before it is
   * written.
   *
   * Regions come from accessibility boxes rather than OCR: we already know
   * which node holds a balance, so classifying the *text* and blacking out its
   * *box* is both cheaper and exact. Text baked into an image is not covered,
   * and that limit is stated in REPORT.md §6.
   */
  async #capture(root: A11yNode, label: string): Promise<string> {
    if (!this.#options.onScreenshot) return '(not persisted)';

    const png = await this.#page.screenshot({ type: 'png' });
    const regions: [number, number, number, number][] = [];
    const found = new Map<Sensitivity, RedactionRecord>();

    for (const flat of flatten(root)) {
      const text = [flat.node.name, flat.node.value].filter((s): s is string => s !== null).join(' ');
      if (text.length === 0 || flat.node.box === null) continue;
      const { classification, confidence } = this.#redactor.classify(text);
      if (classification === 'none') continue;
      regions.push([...flat.node.box] as [number, number, number, number]);

      // Keyed by classification rather than by entity, because `classify`
      // answers "how sensitive is this field" and not "which recognizer fired".
      // Naming an entity we did not actually identify would be a small lie in
      // an audit record, which is the same reason `entityFor` exists.
      const seen = found.get(classification);
      found.set(classification, {
        entity: `SCREEN_${classification.toUpperCase()}`,
        classification,
        confidence: Math.max(seen?.confidence ?? 0, confidence),
        sink: 'screenshot',
        count: (seen?.count ?? 0) + 1,
      });
    }

    const redacted = await this.#redactor.redactImage(png, regions);
    return this.#options.onScreenshot(redacted, label, [...found.values()]);
  }

  /**
   * Stop acting without tearing anything down.
   *
   * There is deliberately no browser call here. Pausing is a statement about
   * who may act, not about the page — the whole point of the handoff design is
   * that the session, its cookies, and its half-filled form stay exactly as
   * they are while a human takes over. Closing or freezing anything would give
   * the operator a different session, which the brief rules out explicitly.
   */
  async pause(): Promise<void> {
    this.#paused = true;
  }

  async resume(): Promise<void> {
    this.#paused = false;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** CDP endpoint the operator console attaches to. Opaque above the seam. */
  sessionEndpoint(): string {
    return this.#page.url();
  }

  async dispose(): Promise<void> {
    await this.#context.close();
  }
}

// -----------------------------------------------------------------------------

function ok(): PerformResult {
  return { ok: true, extracted: null, detail: null };
}

function fail(detail: string): PerformResult {
  return { ok: false, extracted: null, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A step's value has already been resolved to a literal by the caller.
 *
 * The driver never sees `$.inputs.memberId`: the replay engine substitutes the
 * caller's parameter before handing the action down, so the only place real
 * data exists is in memory for the duration of one action. Reaching here with
 * an unresolved reference is a bug in the engine, and it fails loudly.
 */
function literalOf(value: ValueSource): string {
  if (value.from === 'literal') return value.value;
  throw new Error(
    `unresolved parameter reference '${value.ref}' reached the driver; ` +
      `the caller must substitute values before performing an action`,
  );
}

function toA11yNode(raw: RawNode): A11yNode {
  return {
    ref: raw.ref,
    role: raw.role,
    name: raw.name,
    value: raw.value,
    states: raw.states,
    box: raw.box,
    children: raw.children.map(toA11yNode),
  };
}

/**
 * Roles whose accessible name is record content rather than page furniture.
 *
 * A `cell` is named by whatever the database put in it and a `text` node by
 * whatever prose surrounds it; a `link` or `button` is named by the application.
 * Only the second kind describes *where you are*.
 */
const CONTENT_ROLES = new Set(['cell', 'text']);

/**
 * Stable hash of the screen's shape, with record data removed.
 *
 * This is the only progress signal available on a frameset application: the top
 * document's URL is `index.htm` from sign-on to sign-off, so "did anything
 * happen?" cannot be answered by looking at the location. The digest answers it
 * instead, which is what makes "three actions and the digest never moved" a
 * usable dead-end signal rather than a coin flip.
 *
 * Two members' detail screens must therefore hash *alike* — same screen,
 * different record — while the search screen and the not-authorized screen must
 * not. That requires dropping content names entirely rather than merely
 * collapsing digits: `Renner, Alice M` and `Toledo, Marcus J` contain no digits
 * at all, and a digest that separated them would report progress every time the
 * operator looked up a different person.
 */
function digestOf(root: A11yNode): string {
  const hash = createHash('sha256');
  const walk = (node: A11yNode) => {
    // Digits are still collapsed in the names we do keep, for labels like
    // "Page 3 of 7" that are furniture with a counter in them.
    const name = CONTENT_ROLES.has(node.role)
      ? ''
      : (node.name ?? '').replace(/\d+/g, '#');
    hash.update(`${node.role}|${name}|`);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return hash.digest('hex').slice(0, 16);
}

async function frameOffset(
  frame: Frame,
  parentOffset: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  try {
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    if (!box) return parentOffset;
    return { x: box.x, y: box.y };
  } catch {
    return parentOffset;
  }
}

function matchesLocation(location: string, expected: string): boolean {
  if (location.includes(expected)) return true;
  try {
    return new RegExp(expected).test(location);
  } catch {
    return false;
  }
}

function excerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function nearestRoles(nodes: ReturnType<typeof flatten>, role: string): string {
  const seen = new Map<string, number>();
  for (const f of nodes) seen.set(f.node.role, (seen.get(f.node.role) ?? 0) + 1);
  return (
    [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([r, n]) => `${r}×${n}`)
      .join(', ') || `(nothing; expected a ${role})`
  );
}

/**
 * Coerce extracted text into the declared output shape.
 *
 * Returning null rather than throwing on a miss is what turns "we reached the
 * right screen but the cell was empty" into `OUTPUT_EXTRACTION_FAILED` — a
 * specific failure class the caller can act on — instead of a stack trace.
 */
export function coerce(raw: string, as: ExtractAs): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;

  switch (as) {
    case 'text':
    case 'table':
      return text;

    case 'money': {
      const match = /[$€£]\s?-?[\d,]+(?:\.\d{2})?|-?[\d,]+\.\d{2}/.exec(text);
      return match?.[0].replace(/\s+/g, '') ?? null;
    }

    case 'number': {
      const match = /-?[\d,]*\.?\d+/.exec(text.replace(/,/g, ''));
      return match ? String(Number(match[0])) : null;
    }

    case 'integer': {
      const match = /-?\d+/.exec(text.replace(/,/g, ''));
      return match ? String(parseInt(match[0], 10)) : null;
    }

    case 'date': {
      const iso = /\d{4}-\d{2}-\d{2}/.exec(text);
      if (iso) return iso[0];
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
    }

    case 'boolean': {
      const yes = /^(y|yes|true|checked|active|on)$/i.test(text);
      const no = /^(n|no|false|unchecked|inactive|off)$/i.test(text);
      return yes ? 'true' : no ? 'false' : null;
    }
  }
}
