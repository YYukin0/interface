import { z } from 'zod';
import { checkpointId, inputRef, isoTimestamp, outputRef } from './common.js';

/**
 * =============================================================================
 * THE SEAM (I6)
 * =============================================================================
 * Everything in this file is the boundary between "how we perceive and act on a
 * surface" and "the recorded flow". A `Capability` is written in terms of these
 * types and nothing else, which is what lets one artifact format describe a
 * modern web app, a frameset-era legacy web app, and a native desktop app.
 *
 * Rule: if a Windows UI Automation / macOS AX / AT-SPI driver could not
 * implement it, it does not belong here. That rule is why you will not find
 * `Page`, `Locator`, `querySelector`, or any CSS type in this module's surface
 * area — `css` appears only as one member of the locator-strategy enum, which
 * a desktop driver is free to declare unsupported.
 */

export const surfaceKind = z.enum(['web', 'legacy-web', 'desktop']);

/**
 * Locator strategies, ordered here roughly by expected durability.
 *
 * D7: we never store a single selector. Every target carries an ordered *bundle*
 * of candidates produced by different heuristics, which replay resolves with an
 * agreement check. Two independent lines of evidence drove this:
 *   - research: weighted multi-locator beat the best single algorithm (ROBULA+)
 *     in Leotta et al., ICST'15;
 *   - production: browser-use/workflow-use demoted `cssSelector`/`xpath` to
 *     `[LEGACY] avoid in new workflows` and introduced an ordered
 *     `selectorStrategies` list (read in research/workflow-use).
 *
 * Portability notes per strategy — this column is the desktop story:
 *   automation-id         web `id` / UIA AutomationId / AX identifier   → portable
 *   role-name             ARIA role+name / UIA ControlType+Name / AXRole+AXTitle → portable
 *   label-text            associated <label> / UIA LabeledBy            → portable
 *   container-scoped-text text within a named container                → portable
 *   text                  visible or accessible text                    → portable
 *   robula-xpath          ROBULA+-generated XPath                       → web only
 *   css                   CSS selector                                  → web only
 *   structural-path       index path through the a11y tree              → portable, brittle
 *   viewport-coords       normalised "x,y" in [0,1]                     → portable, last resort
 */
export const locatorStrategy = z.enum([
  'automation-id',
  'role-name',
  'label-text',
  'container-scoped-text',
  'text',
  'robula-xpath',
  'css',
  'structural-path',
  'viewport-coords',
]);

export const locatorCandidate = z
  .object({
    strategy: locatorStrategy,
    /**
     * Strategy-specific payload, always a string so the bundle stays uniform and
     * diffable in review. Encoding by strategy:
     *   role-name             `"button:Search"`
     *   container-scoped-text `"Personal Information >> Submit"`
     *   viewport-coords       `"0.4213,0.6180"` (normalised, resolution-independent)
     *   others                the raw selector / id / text
     */
    value: z.string().min(1),
    /** Compiler's prior belief that this candidate survives to the next release. */
    confidence: z.number().min(0).max(1),
    /** Why the compiler emitted this candidate. Review aid; ignored at runtime. */
    note: z.string().nullable().default(null),
  })
  .strict();

/**
 * How a step finds its control.
 *
 * The `*Hint` fields are stored as human-readable text, never as selectors —
 * a design borrowed from workflow-use's `container_hint` / `position_hint`.
 * They serve double duty: a reviewer reads them to understand the step, and the
 * resolver uses them to disambiguate when several candidates match.
 */
export const target = z
  .object({
    /**
     * Path of frame names from the top document down to the element's frame.
     * Empty for the top document. Legacy `<frameset>` apps need this; on desktop
     * it carries the window/pane path instead.
     */
    frame: z.array(z.string()).default([]),
    containerHint: z.string().nullable().default(null),
    positionHint: z.string().nullable().default(null),
    /** Expected accessible role, cross-checked at resolve time to catch drift early. */
    expectedRole: z.string().nullable().default(null),
    /** Expected accessible name, cross-checked at resolve time. */
    expectedName: z.string().nullable().default(null),
    candidates: z.array(locatorCandidate).min(1),
  })
  .strict();

// -----------------------------------------------------------------------------
// Values
// -----------------------------------------------------------------------------

/**
 * Where a step's value comes from.
 *
 * I3/I5: a `literal` is only legal for data classified `none`. Anything the
 * caller supplies — member ids, amounts, names — must be `input`, so the artifact
 * on disk never contains real data and the same file serves every invocation.
 * The compiler enforces this; `packages/compiler` rejects literals that the
 * redactor flags.
 */
export const valueSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('input'), ref: inputRef }).strict(),
  z.object({ from: z.literal('literal'), value: z.string() }).strict(),
]);

/** How extracted text is coerced before it is returned to the caller. */
export const extractAs = z.enum([
  'text',
  'money',
  'number',
  'integer',
  'date',
  'boolean',
  'table',
]);

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/**
 * The complete action vocabulary. Intentionally small: every verb here must be
 * implementable by a desktop driver, and every additional verb is another thing
 * replay can get wrong.
 *
 * Note what is absent: no `evaluate`, no `screenshot`, no `wait(ms)`. Arbitrary
 * script execution would break the desktop seam, and fixed sleeps would break
 * determinism — waiting is expressed through checkpoints instead.
 */
export const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click') }).strict(),
  z.object({ type: z.literal('double_click') }).strict(),
  z.object({ type: z.literal('type'), value: valueSource, clearFirst: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('select'), value: valueSource }).strict(),
  z.object({ type: z.literal('set_checked'), checked: z.boolean() }).strict(),
  z.object({ type: z.literal('press_key'), key: z.string().min(1) }).strict(),
  z.object({ type: z.literal('navigate'), to: z.string().min(1) }).strict(),
  z.object({ type: z.literal('scroll_into_view') }).strict(),
  z.object({ type: z.literal('extract'), into: outputRef, as: extractAs }).strict(),
  z.object({ type: z.literal('dismiss_dialog'), accept: z.boolean() }).strict(),
]);

export const actionType = z.enum([
  'click',
  'double_click',
  'type',
  'select',
  'set_checked',
  'press_key',
  'navigate',
  'scroll_into_view',
  'extract',
  'dismiss_dialog',
]);

// -----------------------------------------------------------------------------
// Observation
// -----------------------------------------------------------------------------

/**
 * The common denominator of a web accessibility tree, Windows UI Automation, and
 * macOS AX. Deliberately shallow in features so all three can produce it.
 */
export interface A11yNode {
  /** Opaque handle, valid only within the observation that produced it. */
  readonly ref: string;
  readonly role: string;
  readonly name: string | null;
  readonly value: string | null;
  /** e.g. `disabled`, `checked`, `expanded`, `required`, `invalid`. */
  readonly states: readonly string[];
  /** `[x, y, width, height]` in viewport pixels; null when off-screen. */
  readonly box: readonly [number, number, number, number] | null;
  readonly children: readonly A11yNode[];
}

export const a11yNode: z.ZodType<A11yNode> = z.lazy(() =>
  z
    .object({
      ref: z.string().min(1),
      role: z.string(),
      name: z.string().nullable(),
      value: z.string().nullable(),
      states: z.array(z.string()),
      box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
      children: z.array(a11yNode),
    })
    .strict(),
);

export const observation = z
  .object({
    at: isoTimestamp,
    surface: surfaceKind,
    /** URL for web surfaces; window title or app path for desktop. */
    location: z.string(),
    title: z.string().nullable(),
    root: a11yNode,
    /**
     * Stable hash of the tree's structure with volatile text removed. Used to
     * detect dead ends in discovery ("three actions, no state change") without
     * diffing whole trees.
     */
    digest: z.string(),
    screenshotRef: z.string().nullable(),
    /** True when the tree was clipped to fit the model's context budget (D3). */
    truncated: z.boolean(),
  })
  .strict();

// -----------------------------------------------------------------------------
// Checkpoints — how we assert we actually arrived somewhere
// -----------------------------------------------------------------------------

export const assertionKind = z.enum([
  'element-visible',
  'element-absent',
  'role-name-present',
  'text-present',
  'text-absent',
  'location-matches',
  'value-equals',
]);

/** Assertions that address a specific control and therefore need a `target`. */
export const ELEMENT_SCOPED_ASSERTIONS = [
  'element-visible',
  'element-absent',
  'value-equals',
] as const satisfies readonly AssertionKind[];

/** Assertions evaluated against the whole document; a `target` is meaningless. */
export const PAGE_SCOPED_ASSERTIONS = [
  'role-name-present',
  'text-present',
  'text-absent',
  'location-matches',
] as const satisfies readonly AssertionKind[];

/**
 * A checkpoint is the difference between "we clicked" and "it worked".
 *
 * It is also the unit of resume (I7): after a human takeover we do not continue
 * at the next step index, we re-verify a checkpoint and continue from there,
 * because the human may have advanced the UI arbitrarily.
 */
export const checkpoint = z
  .object({
    id: checkpointId,
    assert: assertionKind,
    /** Required for element-scoped assertions; must be null for page-scoped ones. */
    target: target.nullable().default(null),
    /** Expected text, pattern, or `role:name` depending on `assert`. */
    value: z.string(),
    /**
     * How long to wait for the condition. This is the ONLY legal way to wait —
     * fixed sleeps are banned because they make replay timing-dependent.
     */
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  })
  .strict()
  .superRefine((c, ctx) => {
    // A checkpoint that names an element but carries no locator would silently
    // degrade to a page-wide text search, which is how a replay "passes" while
    // looking at the wrong screen. Reject it at parse time instead.
    const elementScoped = (ELEMENT_SCOPED_ASSERTIONS as readonly string[]).includes(c.assert);
    if (elementScoped && c.target === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: `assert '${c.assert}' is element-scoped and requires a target`,
      });
    }
    if (!elementScoped && c.target !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: `assert '${c.assert}' is page-scoped; a target would be ignored`,
      });
    }
    if (c.assert === 'role-name-present' && !c.value.includes(':')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: "must be 'role:name', e.g. 'textbox:Member ID'",
      });
    }
  });

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

export const resolutionStatus = z.enum([
  /** Exactly one element, and surviving candidates agree on it. */
  'unique',
  /** Candidates resolved, but to more than one element; refuse to guess. */
  'ambiguous',
  /** No candidate resolved. */
  'not_found',
  /**
   * Candidates resolved to *different* elements. Strictly worse than
   * `not_found`: something moved, and acting on the winner risks acting on the
   * wrong control. Always escalates, never retries.
   */
  'disagreement',
]);

export const resolution = z
  .object({
    status: resolutionStatus,
    ref: z.string().nullable(),
    matchedBy: locatorStrategy.nullable(),
    /** Fraction of resolving candidates that agreed on the winning element. */
    agreement: z.number().min(0).max(1),
    tried: z.array(
      z
        .object({
          strategy: locatorStrategy,
          matched: z.number().int().min(0),
          ref: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const assertionResult = z
  .object({
    passed: z.boolean(),
    expected: z.string(),
    observed: z.string(),
    waitedMs: z.number().int().min(0),
  })
  .strict();

// -----------------------------------------------------------------------------
// The driver interface
// -----------------------------------------------------------------------------

export interface ObserveOptions {
  /** Cap on serialised tree size; sets `Observation.truncated` when hit. */
  readonly maxNodes?: number;
  /** Capture a screenshot alongside the tree (D3 hybrid fallback). */
  readonly withScreenshot?: boolean;
}

export interface PerformResult {
  readonly ok: boolean;
  /** Populated for `extract`; null for every other action. */
  readonly extracted: string | null;
  /** Driver-level detail on failure, already redacted. */
  readonly detail: string | null;
}

/**
 * The only thing discovery and replay know about the world.
 *
 * Implementations: `packages/surface-web` (Playwright/CDP) ships; a desktop
 * driver over UI Automation / AX / AT-SPI is designed but deliberately not built
 * — see REPORT.md §7 Cuts.
 */
export interface SurfaceDriver {
  readonly kind: SurfaceKind;

  observe(options?: ObserveOptions): Promise<Observation>;
  resolve(target: Target): Promise<Resolution>;
  perform(action: Action, ref: string | null): Promise<PerformResult>;
  check(checkpoint: Checkpoint): Promise<AssertionResult>;

  /**
   * Build a locator bundle for an element that is on screen right now.
   *
   * This is the one operation in the whole system that cannot be deferred. The
   * DOM — or the UI tree, on desktop — that gave a ref its meaning is gone the
   * moment the screen changes, so candidates have to be harvested at the instant
   * the model acts. Compilation, review and replay all work from what this
   * returns, and none of them can reconstruct it afterwards at any price.
   *
   * It lives on the driver rather than in the compiler because the *set* of
   * usable strategies is a property of the surface: a UIA driver would emit
   * AutomationId and ControlType+Name here and no CSS at all.
   *
   * Returns null when the ref no longer refers to a live element.
   */
  harvest(ref: string): Promise<Target | null>;

  /** Full-fidelity evidence capture for failures and handoff context. */
  captureEvidence(): Promise<{ screenshotRef: string; snapshotRef: string }>;

  /**
   * Suspend automation without tearing down the session. The underlying browser
   * context / application stays alive so a human can take over the *same*
   * session — the brief is explicit that a fresh session does not count.
   */
  pause(): Promise<void>;
  resume(): Promise<void>;

  /**
   * Opaque handle the handoff layer uses to attach an operator console. Kept as
   * a string so this interface stays free of CDP and Playwright types (I6).
   */
  sessionEndpoint(): string;

  dispose(): Promise<void>;
}

/**
 * =============================================================================
 * THE LIVE VIEW PORT
 * =============================================================================
 * What a human takeover needs from a surface, and nothing else: a stream of
 * frames going out, and pointer and keyboard events coming back in.
 *
 * It is separate from `SurfaceDriver` because the two are needed by different
 * people at different times — replay never streams video, and an operator
 * console has no business calling `harvest`. Keeping them apart means a
 * deployment can offer a driver with no live view (a headless CI runner, where
 * escalation degrades to a failure) without implementing five methods that
 * throw.
 *
 * It is in `contracts` rather than in `packages/handoff` because it is a port
 * with two sides: handoff consumes it, `packages/surface-web` implements it over
 * CDP, and a desktop implementation would use a screen capture API and
 * `SendInput`. I6 holds here in the same way it holds for the driver — the
 * vocabulary below is pixels, buttons and key names, which every surface has.
 * `Page.startScreencast` appears nowhere in it.
 *
 * Coordinates going in are NORMALISED to [0,1], deliberately. The operator's
 * window is not the session's viewport, the frame they clicked may have been
 * scaled to fit, and a console that sent raw pixels would put the click in the
 * wrong place on any display but the developer's. Normalising also makes the
 * recorded evidence portable: "clicked at (0.31, 0.62)" still means something
 * when the same run is replayed at another size.
 */
export interface LiveViewSource {
  /** Session viewport in device pixels, so a console can size its canvas. */
  viewport(): { width: number; height: number };

  /**
   * Begin streaming. `onFrame` receives an encoded still image; the
   * implementation is responsible for acknowledging frames to its transport, and
   * for stopping when `stop` is called.
   */
  start(onFrame: (frame: LiveViewFrame) => void): Promise<void>;
  stop(): Promise<void>;

  /** `x`/`y` are normalised to [0,1] against the viewport. */
  pointer(event: PointerInput): Promise<void>;
  keyboard(event: KeyInput): Promise<void>;
}

export interface LiveViewFrame {
  /** Base64 image data, format as declared. */
  readonly data: string;
  readonly format: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
}

export interface PointerInput {
  readonly type: 'move' | 'down' | 'up' | 'wheel';
  readonly x: number;
  readonly y: number;
  readonly button?: 'left' | 'middle' | 'right';
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
}

export interface KeyInput {
  readonly type: 'down' | 'up' | 'char';
  /** A DOM `KeyboardEvent.key` value: 'a', 'Enter', 'Tab', 'ArrowLeft'. */
  readonly key: string;
  readonly modifiers?: readonly ('alt' | 'ctrl' | 'meta' | 'shift')[];
}

export type SurfaceKind = z.infer<typeof surfaceKind>;
export type LocatorStrategy = z.infer<typeof locatorStrategy>;
export type LocatorCandidate = z.infer<typeof locatorCandidate>;
export type Target = z.infer<typeof target>;
export type ValueSource = z.infer<typeof valueSource>;
export type ExtractAs = z.infer<typeof extractAs>;
export type Action = z.infer<typeof action>;
export type ActionType = z.infer<typeof actionType>;
export type Observation = z.infer<typeof observation>;
export type AssertionKind = z.infer<typeof assertionKind>;
export type Checkpoint = z.infer<typeof checkpoint>;
export type ResolutionStatus = z.infer<typeof resolutionStatus>;
export type Resolution = z.infer<typeof resolution>;
export type AssertionResult = z.infer<typeof assertionResult>;
