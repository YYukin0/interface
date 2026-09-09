import type { BrowserContext, CDPSession, Page } from 'playwright';

import type { KeyInput, LiveViewFrame, LiveViewSource, PointerInput } from '@cua/contracts';

/**
 * =============================================================================
 * LIVE VIEW OVER CDP
 * =============================================================================
 * The transport half of a human takeover, and the only file in the system that
 * knows what a screencast frame is.
 *
 * Read from `research/steel-browser/api/src/plugins/browser-socket/casting.handler.ts`
 * (MIT), which is the shortest correct implementation of this we found. The
 * recipe is small enough to state completely:
 *
 *   out    `Page.startScreencast` with jpeg/q75 — their measured balance between
 *          legibility and bandwidth, and there is no reason to re-derive it
 *   out    ACK EVERY FRAME with `Page.screencastFrameAck`. Their comment says
 *          "free up memory"; what actually happens if you skip it is the stream
 *          delivers a handful of frames and then stops forever, which looks like
 *          a hung page rather than a protocol mistake. This is the one trap.
 *   in     `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
 *   init   fix the viewport first, or the human is looking at a different
 *          window than the automation was
 *
 * What we do NOT take from Steel is its control model, because it has none: its
 * live view is a debugging window anyone may reach into at any time. That is the
 * right call for a debugger and the wrong one for an action against a member's
 * account. Whether input is *allowed* is decided one layer up, by the lease in
 * `@cua/handoff`; this class only knows how to deliver it.
 *
 * We took CDP over the ready-made Xvfb + x11vnc + noVNC stack for one reason
 * that outweighs the extra code: every operator input arrives here as a
 * structured event, so "what did the human do" becomes a queryable record rather
 * than a video somebody has to watch.
 */

/** Steel's measured jpeg quality. Legible text on a 1280px viewport, small frames. */
const QUALITY = 75;

/** Cap on frame size. The console scales to fit; the wire does not need more. */
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 800;

export interface CdpLiveViewOptions {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly viewport: { width: number; height: number };
}

export class CdpLiveView implements LiveViewSource {
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #viewport: { width: number; height: number };

  #cdp: CDPSession | null = null;
  #streaming = false;

  constructor(options: CdpLiveViewOptions) {
    this.#context = options.context;
    this.#page = options.page;
    this.#viewport = options.viewport;
  }

  viewport(): { width: number; height: number } {
    return { ...this.#viewport };
  }

  async start(onFrame: (frame: LiveViewFrame) => void): Promise<void> {
    if (this.#streaming) return;
    const cdp = await this.#session();
    this.#streaming = true;

    // Pin the metrics before the first frame. Without this the operator sees
    // whatever size the renderer happens to be, which is not necessarily the
    // viewport the automation's coordinates were normalised against — and every
    // click they make would land slightly wrong.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.#viewport.width,
      height: this.#viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    cdp.on('Page.screencastFrame', (event) => {
      // Acknowledged first, delivered second, and never awaited by the handler.
      // A console that is slow to consume must not be able to stall the stream
      // for the page itself — the browser is holding a buffer until this ack.
      void cdp
        .send('Page.screencastFrameAck', { sessionId: event.sessionId })
        .catch(() => undefined);

      onFrame({
        data: event.data,
        format: 'jpeg',
        width: event.metadata.deviceWidth ?? this.#viewport.width,
        height: event.metadata.deviceHeight ?? this.#viewport.height,
      });
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: QUALITY,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      everyNthFrame: 1,
    });
  }

  async stop(): Promise<void> {
    if (!this.#streaming || this.#cdp === null) return;
    this.#streaming = false;
    await this.#cdp.send('Page.stopScreencast').catch(() => undefined);
    await this.#cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    await this.#cdp.detach().catch(() => undefined);
    this.#cdp = null;
  }

  async pointer(event: PointerInput): Promise<void> {
    const cdp = await this.#session();
    const { x, y } = this.#denormalise(event.x, event.y);

    if (event.type === 'wheel') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
      });
      return;
    }

    await cdp.send('Input.dispatchMouseEvent', {
      type: MOUSE_EVENT[event.type],
      x,
      y,
      button: event.button ?? 'left',
      // CDP wants a button bitmask on move and a count on press/release. Getting
      // this wrong produces the symptom where clicks register but drags do not.
      buttons: event.type === 'move' ? 0 : 1,
      clickCount: event.type === 'move' ? 0 : (event.clickCount ?? 1),
    });
  }

  async keyboard(event: KeyInput): Promise<void> {
    const cdp = await this.#session();
    const printable = event.key.length === 1;

    await cdp.send('Input.dispatchKeyEvent', {
      type:
        event.type === 'char'
          ? 'char'
          : event.type === 'down'
            ? printable
              ? 'keyDown'
              : 'rawKeyDown'
            : 'keyUp',
      key: event.key,
      // A legacy form that reads `event.keyCode` — and one built in 2003 will —
      // sees nothing without these. Windows virtual key codes for the named keys
      // this console can send; a printable character's code is its uppercase
      // ASCII value, which is what a browser reports.
      windowsVirtualKeyCode: VIRTUAL_KEY[event.key] ?? (printable ? event.key.toUpperCase().charCodeAt(0) : 0),
      ...(printable ? { text: event.key, unmodifiedText: event.key } : {}),
      modifiers: modifierMask(event.modifiers ?? []),
    });
  }

  /** Normalised [0,1] back to the device pixels CDP expects. */
  #denormalise(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.round(clamp(x) * this.#viewport.width),
      y: Math.round(clamp(y) * this.#viewport.height),
    };
  }

  async #session(): Promise<CDPSession> {
    this.#cdp ??= await this.#context.newCDPSession(this.#page);
    return this.#cdp;
  }
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const MOUSE_EVENT = {
  move: 'mouseMoved',
  down: 'mousePressed',
  up: 'mouseReleased',
} as const;

/** CDP's modifier bitmask: alt=1, ctrl=2, meta=4, shift=8. */
function modifierMask(modifiers: readonly string[]): number {
  const bits = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
  let mask = 0;
  for (const m of modifiers) mask |= bits[m as keyof typeof bits] ?? 0;
  return mask;
}

const VIRTUAL_KEY: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};
