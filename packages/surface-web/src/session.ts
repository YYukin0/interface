import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type { DefaultRedactor } from '@cua/redact';
import { PlaywrightSurfaceDriver, type WebDriverOptions } from './driver.js';
import { CdpLiveView } from './liveview.js';

/**
 * =============================================================================
 * SESSION BOOTSTRAP
 * =============================================================================
 * Opens a browser, signs in, and hands back a driver already inside the
 * application.
 *
 * **Authentication happens here, outside the action vocabulary, on purpose.**
 * That looks like a hole in I4 ("every action is policy-checked") and is the
 * opposite. If signing in were an ordinary step then the model would have to be
 * shown a password field and given something to type into it, and a credential
 * would travel through a prompt, a trace, and eventually an artifact. Instead:
 *
 *   - credentials are read from the environment and typed by this file;
 *   - the shipped policy denies navigation to `logon.do` and `signoff.do`, so
 *     the agent cannot reach the credential surface even if it tries;
 *   - `reauthenticate` recovery re-enters through this same path rather than
 *     replaying recorded steps.
 *
 * The seam this leaves is honest and worth naming: a deployment with SSO or MFA
 * replaces this file, and nothing above it changes.
 */

export interface SessionOptions {
  readonly baseUrl: string;
  readonly entryPoint: string;
  readonly username: string;
  readonly password: string;
  readonly headless?: boolean;
  /**
   * Fixed viewport. Not cosmetic: `viewport-coords` candidates are normalised
   * against it, and a replay whose window size varies is a replay whose
   * last-resort locator means something different every time.
   */
  readonly viewport?: { width: number; height: number };
  readonly redactor?: DefaultRedactor;
  readonly onScreenshot?: WebDriverOptions['onScreenshot'];
  readonly onSnapshot?: WebDriverOptions['onSnapshot'];
  /** Playwright trace, written on close. Free step-level evidence. */
  readonly tracePath?: string;
}

export interface Session {
  readonly driver: PlaywrightSurfaceDriver;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  /**
   * A live view of this very session, for an operator console to attach to.
   *
   * Built here rather than by the caller because it needs the viewport the
   * context was actually created with, and a console showing a different
   * viewport than the automation used is a console whose clicks land elsewhere.
   */
  readonly liveView: CdpLiveView;
  /** Re-enters credentials on the live session. Backs `reauthenticate`. */
  signIn(): Promise<boolean>;
  close(): Promise<void>;
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export async function openSession(options: SessionOptions): Promise<Session> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({
    viewport,
    // Animations off and a fixed locale: two of the three sources of run-to-run
    // variation in a browser. The third is timing, which checkpoints handle.
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  });

  if (options.tracePath) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }

  const page = await context.newPage();

  const signIn = async (): Promise<boolean> => {
    await page.goto(new URL(options.entryPoint, options.baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
    });

    // Already inside: the frameset is served only to a signed-on session.
    if (await page.locator('frameset').count()) return true;

    const user = page.locator('input[name="u"]');
    if ((await user.count()) === 0) return false;

    await user.fill(options.username);
    await page.locator('input[name="p"]').fill(options.password);
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('input[type="submit"]').click(),
    ]);

    return (await page.locator('frameset').count()) > 0;
  };

  if (!(await signIn())) {
    await browser.close();
    throw new Error(
      'sign-on failed: check CUA_APP_USERNAME and CUA_APP_PASSWORD, and that the ' +
        'target application is reachable at ' + options.baseUrl,
    );
  }

  const driver = new PlaywrightSurfaceDriver({
    context,
    page,
    ...(options.redactor ? { redactor: options.redactor } : {}),
    kind: 'legacy-web',
    ...(options.onScreenshot ? { onScreenshot: options.onScreenshot } : {}),
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
  });

  return {
    driver,
    browser,
    context,
    page,
    liveView: new CdpLiveView({ context, page, viewport }),
    signIn,
    async close() {
      if (options.tracePath) {
        await context.tracing.stop({ path: options.tracePath }).catch(() => undefined);
      }
      await browser.close();
    },
  };
}
