import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * =============================================================================
 * CONSOLE TOKENS
 * =============================================================================
 * A console URL is a credential, and it needs to be treated as one.
 *
 * This is the lesson Browserbase's Live View documentation states plainly and
 * that is easy to get wrong: the URL grants keyboard and mouse control of a
 * browser that is *already signed in* to a back-office system. Anyone who sees
 * it — in a chat message, a ticket comment, a screenshot of a terminal, a proxy
 * log — has the operator's hands. That is a higher privilege than most of the
 * credentials a system like this is careful about, and it is the one people
 * paste into Slack.
 *
 * So a URL here is signed and short-lived rather than merely unguessable:
 *
 *   - the payload names the session, the intervention, and an expiry;
 *   - it is HMAC'd with a per-process secret, so a token cannot be forged for a
 *     session the holder was never given;
 *   - it expires on its own, so a stale link in a resolved ticket is inert;
 *   - the secret is generated at startup and never written down, so tokens do
 *     not survive a restart — which is the correct default for a link whose
 *     whole purpose was one incident.
 *
 * Comparison is `timingSafeEqual`. That is close to superstition at this scale,
 * and it costs one line.
 */

export interface ConsoleClaim {
  readonly sessionId: string;
  readonly interventionId: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export class ConsoleTokenIssuer {
  readonly #secret: Buffer;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { secret?: Buffer; ttlMs?: number; now?: () => number } = {}) {
    this.#secret = options.secret ?? randomBytes(32);
    this.#ttlMs = options.ttlMs ?? 15 * 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  issue(sessionId: string, interventionId: string): string {
    const claim: ConsoleClaim = {
      sessionId,
      interventionId,
      expiresAt: this.#now() + this.#ttlMs,
    };
    const body = base64url(Buffer.from(JSON.stringify(claim), 'utf8'));
    return `${body}.${this.#sign(body)}`;
  }

  /** The claim, or null for anything that is not a currently valid token. */
  verify(token: string): ConsoleClaim | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;

    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'utf8');
    const expected = Buffer.from(this.#sign(body), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    let claim: ConsoleClaim;
    try {
      claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConsoleClaim;
    } catch {
      return null;
    }

    // Signature first, expiry second. An expired token is a real token whose
    // moment has passed; a forged one never was, and the two should not be told
    // apart by which check ran first.
    return claim.expiresAt > this.#now() ? claim : null;
  }

  #sign(body: string): string {
    return createHmac('sha256', this.#secret).update(body).digest('base64url');
  }
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');
