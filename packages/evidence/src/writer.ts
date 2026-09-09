import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  runManifest,
  traceEvent,
  type EvidenceWriter,
  type RedactionRecord,
  type RunManifest,
  type RunRef,
  type TraceEvent,
} from '@cua/contracts';
import { DefaultRedactor, atSink } from '@cua/redact';

/**
 * =============================================================================
 * EVIDENCE
 * =============================================================================
 * One run, one directory. Append-only JSONL plus the artefacts a human needs to
 * reconstruct a failure without rerunning it.
 *
 * Two properties are load-bearing and worth stating before the code:
 *
 *   REDACTION IS NOT OPTIONAL. Every event goes through the redactor on its way
 *   to disk, including the ones this file did not anticipate. That is why the
 *   scrub is a generic walk over the parsed event rather than a per-event-type
 *   list of fields to clean: a new event type added later is protected by
 *   default instead of by whoever remembers to update a switch.
 *
 *   THE TRACE IS NOT THE ARTIFACT (I5). Nothing here ever produces a
 *   Capability. The compiler reads this directory and emits one; the artifact
 *   then references the directory by path and inlines none of it.
 */

/** Run ids sort chronologically and survive being used as a directory name. */
export function newRunId(kind: RunManifest['kind'], at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const salt = createHash('sha256').update(`${stamp}:${Math.random()}`).digest('hex').slice(0, 6);
  return `${kind}-${stamp}-${salt}`;
}

export interface FileEvidenceOptions {
  /** Root under which run directories are created. Defaults to `evidence/`. */
  readonly root?: string;
  readonly redactor?: DefaultRedactor;
}

export class FileEvidenceWriter implements EvidenceWriter {
  readonly runId: string;
  readonly dir: string;
  readonly #redactor: DefaultRedactor;
  readonly #tracePath: string;
  #redactions: RedactionRecord[] = [];
  #opened = false;

  private constructor(runId: string, dir: string, redactor: DefaultRedactor) {
    this.runId = runId;
    this.dir = dir;
    this.#redactor = redactor;
    this.#tracePath = join(dir, 'trace.jsonl');
  }

  static async open(
    manifest: RunManifest,
    options: FileEvidenceOptions = {},
  ): Promise<FileEvidenceWriter> {
    const root = options.root ?? 'evidence';
    const dir = join(root, manifest.runId);
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    await mkdir(join(dir, 'snapshots'), { recursive: true });

    const writer = new FileEvidenceWriter(
      manifest.runId,
      dir,
      options.redactor ?? new DefaultRedactor(),
    );
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await writer.append({ event: 'run_started', at: manifest.startedAt, manifest });
    writer.#opened = true;
    return writer;
  }

  /** Where this run lives, in the shape artifacts and results reference it by. */
  get ref(): RunRef {
    return { runId: this.runId, path: this.dir };
  }

  /** Everything the redactor caught this run, for the summary in `result.json`. */
  get redactions(): readonly RedactionRecord[] {
    return this.#redactions;
  }

  async append(event: TraceEvent): Promise<void> {
    const { value, found } = this.#scrub(event);

    // Parse after scrubbing, not before: it proves the redactor did not produce
    // something that no longer satisfies the trace schema, which is the failure
    // mode where evidence silently stops being machine-readable.
    const parsed = traceEvent.parse(value);
    await appendFile(this.#tracePath, JSON.stringify(parsed) + '\n', 'utf8');

    if (found.length === 0) return;

    const records = atSink(found, 'log');
    this.#redactions.push(...records);

    // Recording the redaction is itself an event, but only once the writer is
    // open — during `open()` we are still inside the first append.
    //
    // These go out unscrubbed and that is safe by construction: a
    // `RedactionRecord` carries an entity type, a count and a confidence, and
    // has nowhere to put the value it describes. Scrubbing them again would
    // also double-count every detection in `redactions.json`.
    if (!this.#opened) return;
    for (const record of records) {
      const event = traceEvent.parse({ event: 'redacted', at: nowIso(), record });
      await appendFile(this.#tracePath, JSON.stringify(event) + '\n', 'utf8');
    }
  }

  /**
   * Record redactions that happened somewhere this writer cannot see.
   *
   * The prompt is the sink that gets forgotten, because it does not look like
   * storage — but a member's balance in a context window is a member's balance
   * in somebody else's infrastructure. Redacting the prompt happens in the
   * caller, where the outbound text is; without this method the resulting
   * detections would be invisible to `redactions.json`, and the safety summary
   * would quietly under-report the sink most worth reporting.
   *
   * The records go out unscrubbed, which is safe by construction: a
   * `RedactionRecord` carries an entity type, a count and a confidence, and has
   * nowhere to put the value it describes.
   */
  async noteRedactions(records: readonly RedactionRecord[]): Promise<void> {
    this.#redactions.push(...records);
    for (const record of records) {
      const event = traceEvent.parse({ event: 'redacted', at: nowIso(), record });
      await appendFile(this.#tracePath, JSON.stringify(event) + '\n', 'utf8');
    }
  }

  /**
   * Screenshots arrive already redacted and are written as given.
   *
   * That is not an exception to I3, it is where the redaction has to happen:
   * blacking out a balance needs the accessibility box that holds it, and by the
   * time an image reaches this class the tree that produced it is gone. So the
   * driver classifies node text, paints over the boxes, and hands down a PNG
   * that is already safe. The consequence to be aware of is that any *other*
   * caller of this method owes the same guarantee.
   */
  async writeScreenshot(png: Uint8Array, label: string): Promise<string> {
    const name = `screenshots/${safe(label)}.png`;
    await writeFile(join(this.dir, name), png);
    return name;
  }

  async writeSnapshot(json: unknown, label: string): Promise<string> {
    const name = `snapshots/${safe(label)}.json`;
    const { text } = this.#redactor.redactText(JSON.stringify(json, null, 2));
    await writeFile(join(this.dir, name), text + '\n', 'utf8');
    return name;
  }

  /**
   * Close the run: write the result, stamp the manifest, summarise redaction.
   *
   * `endedAt` is rewritten into `manifest.json` rather than appended somewhere
   * new, because the manifest is the file a human opens first and "when did this
   * end" is the second thing they want from it. Leaving it null forever — which
   * is what it is between `open` and here — makes every completed run look like
   * a run that died.
   */
  async finalize(result: unknown, endedAt?: string): Promise<void> {
    const { text } = this.#redactor.redactText(JSON.stringify(result, null, 2));
    await writeFile(join(this.dir, 'result.json'), text + '\n', 'utf8');

    if (endedAt !== undefined) {
      const path = join(this.dir, 'manifest.json');
      const manifest = runManifest.parse(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(path, JSON.stringify({ ...manifest, endedAt }, null, 2) + '\n', 'utf8');
    }

    // A one-page summary of what redaction did, so the safety claim is
    // verifiable from the evidence directory alone rather than from the code.
    await writeFile(
      join(this.dir, 'redactions.json'),
      JSON.stringify(mergeRecords(this.#redactions), null, 2) + '\n',
      'utf8',
    );
  }

  /**
   * Redact every string anywhere in the event.
   *
   * Deliberately structure-agnostic. A per-field allowlist would be tighter and
   * would also be wrong the first time somebody adds an event type and forgets
   * to extend it — and that omission is invisible until it is a leak.
   */
  #scrub(value: unknown): { value: unknown; found: RedactionRecord[] } {
    const found: RedactionRecord[] = [];

    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const result = this.#redactor.redactText(node);
        found.push(...result.found);
        return result.text;
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
      }
      return node;
    };

    return { value: walk(value), found };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Turn a caller-supplied label into a filename that cannot leave the run
 * directory.
 *
 * Dots are stripped along with separators rather than kept: labels come from
 * step descriptions and failure reasons, none of which need a dot, and an
 * allowlist with no `.` in it makes `..` unrepresentable instead of merely
 * unlikely.
 */
function safe(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'unlabelled';
}

/** Collapse per-append records into one row per (entity, sink). */
function mergeRecords(records: readonly RedactionRecord[]): RedactionRecord[] {
  const byKey = new Map<string, RedactionRecord>();
  for (const r of records) {
    const key = `${r.entity}:${r.sink}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      ...r,
      confidence: existing ? Math.max(existing.confidence, r.confidence) : r.confidence,
      count: (existing?.count ?? 0) + r.count,
    });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}
