import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  discoveryRequest,
  recordedStep,
  runManifest,
  traceEvent,
  type DiscoveryRequest,
  type RecordedStep,
  type RunManifest,
  type TraceEvent,
} from '@cua/contracts';

/**
 * =============================================================================
 * THE RECORDING
 * =============================================================================
 * `trace.jsonl` and `recording.jsonl` sit in the same directory and are not the
 * same thing. Keeping them apart is deliberate:
 *
 *   trace.jsonl      the audit log. Human-readable, exhaustively redacted,
 *                    covers policy decisions and recoveries as well as actions,
 *                    and is what you read to answer "what happened".
 *   recording.jsonl  the compiler's input. One entry per action the model took,
 *                    carrying the locator bundle harvested from the live DOM at
 *                    that instant — information that cannot be recovered later
 *                    at any price.
 *
 * Merging them would force the audit log to carry candidate bundles nobody
 * reading it wants, or force the compiler to reconstruct element identity from
 * prose. The values in the recording are classified at capture time (see
 * `RecordedValue`), so this file is no less safe than the other one.
 */

export const TRACE_FILE = 'trace.jsonl';
export const RECORDING_FILE = 'recording.jsonl';
export const MANIFEST_FILE = 'manifest.json';
export const REQUEST_FILE = 'request.json';

export class RecordingWriter {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, RECORDING_FILE);
  }

  /**
   * Persist what was asked for, so the compiler can read the input declarations.
   *
   * The recording says a step typed a five-character `identifier` referenced as
   * `$.inputs.memberId`; only the request says that parameter is called "the
   * five digit member number to look up". One is the contract the capability
   * publishes to its callers, and it cannot be reconstructed from step data.
   *
   * Safe to write by construction rather than by redaction: `DiscoveryRequest`
   * declares parameters without their values (see contracts/discovery.ts), so
   * there is nowhere in this object for caller data to sit.
   */
  async writeRequest(request: DiscoveryRequest): Promise<void> {
    const parsed = discoveryRequest.parse(request);
    await writeFile(
      join(this.#dir, REQUEST_FILE),
      JSON.stringify(parsed, null, 2) + '\n',
      'utf8',
    );
  }

  async append(step: RecordedStep): Promise<void> {
    await appendFile(this.#path, JSON.stringify(recordedStep.parse(step)) + '\n', 'utf8');
  }
}

/** Read a run directory back. Used by the compiler and by the evidence tests. */
export async function readRecording(dir: string): Promise<readonly RecordedStep[]> {
  return parseLines(await readOptional(join(dir, RECORDING_FILE)), (line) =>
    recordedStep.parse(JSON.parse(line)),
  );
}

export async function readTrace(dir: string): Promise<readonly TraceEvent[]> {
  return parseLines(await readOptional(join(dir, TRACE_FILE)), (line) =>
    traceEvent.parse(JSON.parse(line)),
  );
}

/** The request this run was given, or null when the run predates one. */
export async function readRequest(dir: string): Promise<DiscoveryRequest | null> {
  const raw = await readOptional(join(dir, REQUEST_FILE));
  return raw === '' ? null : discoveryRequest.parse(JSON.parse(raw));
}

export async function readManifest(dir: string): Promise<RunManifest> {
  const raw = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  return runManifest.parse(JSON.parse(raw));
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * A malformed line fails the whole read rather than being skipped.
 *
 * Silently dropping unparseable evidence is how a compiler quietly produces a
 * capability missing a step, which then fails on the third replay for reasons
 * nobody can trace back to here.
 */
function parseLines<T>(text: string, parse: (line: string) => T): T[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line, i) => {
      try {
        return parse(line);
      } catch (cause) {
        throw new Error(`evidence line ${i + 1} is not a valid record`, { cause });
      }
    });
}
