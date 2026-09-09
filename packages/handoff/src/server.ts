import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

import type { KeyInput, LiveViewSource, PointerInput } from '@cua/contracts';

import type { LocalHandoffCoordinator } from './coordinator.js';
import { LeaseError } from './lease.js';

/**
 * =============================================================================
 * THE OPERATOR CONSOLE, SERVER SIDE
 * =============================================================================
 * Frames out over Server-Sent Events, input back in over `POST`.
 *
 * **Why not WebSockets, which is what Steel uses.** Their handler is a duplex
 * socket because a live-view debugger wants the lowest possible latency in both
 * directions. The traffic here is not symmetric: frames are a one-way stream
 * (which is exactly what SSE is for, and it is built into every browser and into
 * `node:http` with no dependency), and input is a request that can *fail* —
 * refused by the lease, expired token, session gone. A `POST` returning 409 with
 * a reason is a better shape for that than a message dropped into a socket that
 * has no notion of a reply.
 *
 * The result is a console with no npm dependency and a surface a test can drive
 * with `fetch`, which is why the lease enforcement below is tested without a
 * browser in the loop at all. The cost is a request per input event; at human
 * typing speed that is nothing, and the client coalesces mouse moves.
 *
 * **Every input is checked against the lease before it is dispatched**, and that
 * is the same rule as I4 rather than a different one: an operator's click is an
 * action on a live back-office session, and it does not get to skip the check
 * because a person made it. What the lease adds beyond the policy engine is the
 * *exclusivity* — that the automation is not also acting right now.
 */

export interface OperatorConsoleOptions {
  readonly coordinator: LocalHandoffCoordinator;
  readonly liveView: LiveViewSource;
  /** Directory holding `index.html` and the console's script. */
  readonly assetsDir: string;
  readonly port?: number;
  readonly host?: string;
}

export interface OperatorConsole {
  readonly origin: string;
  close(): Promise<void>;
}

export async function startOperatorConsole(
  options: OperatorConsoleOptions,
): Promise<OperatorConsole> {
  const host = options.host ?? '127.0.0.1';
  const { coordinator, liveView, assetsDir } = options;

  /** SSE subscribers, by intervention. One console, but a reload makes two. */
  const watchers = new Set<ServerResponse>();
  let streaming = false;

  /**
   * The most recent frame, replayed to whoever subscribes next.
   *
   * A screencast only emits on repaint, and the application this exists for is a
   * 2003 frameset that has finished painting and has no intention of doing it
   * again. Without this, an operator who reloads the console — or a second one
   * opening it to watch — gets a correct, connected, permanently blank rectangle,
   * and the obvious conclusion is that the tool is broken. Found by reloading the
   * page during the end-to-end run in `evidence/handoff-*`.
   */
  let lastFrame: string | null = null;

  const broadcast = (payload: string): void => {
    lastFrame = payload;
    for (const res of watchers) {
      // `write` on a closed socket throws; a dead watcher must not take the
      // stream down for a live one.
      try {
        res.write(payload);
      } catch {
        watchers.delete(res);
      }
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') return asset(res, 'index.html');
    if (path === '/console.js') return asset(res, 'console.js');
    if (path === '/console.css') return asset(res, 'console.css');

    // Everything below this line needs a valid token, and the check is here
    // rather than per-route so a new endpoint cannot forget it.
    const claim = coordinator.tokens.verify(url.searchParams.get('t') ?? '');
    if (claim === null) {
      return send(res, 401, { error: 'this console link is invalid or has expired' });
    }

    const intervention = coordinator.interventionOf(claim.interventionId);
    if (intervention === null) {
      return send(res, 410, { error: 'this intervention is no longer open' });
    }

    switch (`${req.method} ${path}`) {
      case 'GET /api/session':
        return send(res, 200, {
          intervention,
          lease: await coordinator.lease(claim.sessionId),
          viewport: liveView.viewport(),
          inputs: coordinator.inputsOf(claim.interventionId).length,
        });

      case 'GET /api/frames':
        return frames(res);

      case 'POST /api/claim': {
        const body = await json(req);
        const operatorId = String(body['operatorId'] ?? '').trim();
        if (operatorId === '') return send(res, 400, { error: 'operatorId is required' });
        try {
          return send(res, 200, await coordinator.claim(claim.interventionId, operatorId));
        } catch (error) {
          return leaseError(res, error);
        }
      }

      case 'POST /api/input': {
        const lease = await coordinator.lease(claim.sessionId);
        if (lease.holder !== 'operator') {
          // Refused, and said out loud. "Somebody tried to type into a session
          // they did not hold" is a more interesting line than the input would
          // have been, so it is not silently dropped.
          process.stderr.write(
            `handoff: refused input on ${claim.sessionId}; lease held by ${lease.holder}\n`,
          );
          return send(res, 409, {
            error:
              lease.holder === 'automation'
                ? 'automation still holds this session'
                : 'nobody holds this session; claim it first',
            lease,
          });
        }
        return dispatch(res, claim.interventionId, await json(req));
      }

      case 'POST /api/handback': {
        const body = await json(req);
        const disposition = String(body['disposition'] ?? '');
        if (!['resume', 'completed_manually', 'abort'].includes(disposition)) {
          return send(res, 400, { error: `unknown disposition '${disposition}'` });
        }
        try {
          const note = typeof body['note'] === 'string' && body['note'] !== '' ? body['note'] : null;
          const record = await coordinator.handBack(
            claim.interventionId,
            disposition as 'resume' | 'completed_manually' | 'abort',
            note,
          );
          await liveView.stop().catch(() => undefined);
          streaming = false;
          lastFrame = null;
          for (const watcher of watchers) watcher.end();
          watchers.clear();
          return send(res, 200, record);
        } catch (error) {
          return leaseError(res, error);
        }
      }

      default:
        return send(res, 404, { error: `no route for ${req.method} ${path}` });
    }
  }

  /** Subscribe to the screencast. The stream starts on the first subscriber. */
  async function frames(res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Flush the headers so the browser's EventSource fires `onopen` immediately
    // rather than after the first frame — which, on a static page, might be a
    // while.
    res.write(': connected\n\n');
    watchers.add(res);
    res.on('close', () => watchers.delete(res));

    // Whatever was last on screen, so a late subscriber sees the session rather
    // than waiting for a repaint that a static page will never perform.
    if (lastFrame !== null) res.write(lastFrame);

    if (!streaming) {
      streaming = true;
      await liveView.start((frame) => {
        broadcast(`data: ${JSON.stringify(frame)}\n\n`);
      });
    }
  }

  /** One human input: recorded, then performed. */
  async function dispatch(
    res: ServerResponse,
    interventionId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const at = new Date().toISOString();

    if (body['kind'] === 'pointer') {
      const event = body['event'] as PointerInput;
      coordinator.record(interventionId, {
        at,
        kind: event.type === 'wheel' ? 'scroll' : 'mouse',
        detail: event.type,
        x: event.x,
        y: event.y,
        text: null,
      });
      await liveView.pointer(event);
      return send(res, 204, null);
    }

    if (body['kind'] === 'key') {
      const event = body['event'] as KeyInput;
      coordinator.record(interventionId, {
        at,
        kind: 'key',
        detail: event.type,
        x: null,
        y: null,
        // Only the key itself, and only on the way into the redactor. A run of
        // keystrokes reconstructs a password just as well as the password does.
        text: event.key,
      });
      await liveView.keyboard(event);
      return send(res, 204, null);
    }

    return send(res, 400, { error: `unknown input kind '${String(body['kind'])}'` });
  }

  async function asset(res: ServerResponse, name: string): Promise<void> {
    // `normalize` then reject any escape: the console serves files from a
    // directory, and a request for `../../.env` is the oldest trick there is.
    const safe = normalize(name).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(assetsDir, safe));
      res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      send(res, 404, { error: `no asset ${name}` });
    }
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);

  return {
    origin: `http://${host}:${port}`,
    async close() {
      for (const watcher of watchers) watcher.end();
      watchers.clear();
      await liveView.stop().catch(() => undefined);
      await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    },
  };
}

// -----------------------------------------------------------------------------

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function leaseError(res: ServerResponse, error: unknown): void {
  if (error instanceof LeaseError) {
    send(res, 409, { error: error.message, lease: error.current });
    return;
  }
  throw error;
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
