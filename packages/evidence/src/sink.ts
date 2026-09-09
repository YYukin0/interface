import type { RedactionRecord } from '@cua/contracts';
import { atSink } from '@cua/redact';

import type { FileEvidenceWriter } from './writer.js';

/**
 * A late-bound destination for the driver's screenshots and snapshots.
 *
 * The awkwardness this resolves is real and worth naming. The driver has to be
 * constructed before the run — it owns the browser session the operator is
 * already signed in to — but the run directory does not exist until the run
 * starts, and a driver that took an `EvidenceWriter` in its constructor would
 * force the session to be torn down and rebuilt per run. That is exactly the
 * property the handoff design cannot afford to lose (I7: the human takes over
 * the *same* session).
 *
 * So the driver is given these two functions once, and they acquire a
 * destination when a run opens one. Before that, and after the run ends, they
 * report that nothing was persisted rather than throwing — a screenshot is
 * evidence, and failing to file it must never be what ends a run.
 *
 * It lives in this package rather than beside either loop because both phases
 * need it and replay may not import from `@cua/discovery` at any depth: that
 * package holds the system's only model SDK import, and a dependency edge from
 * replay to it — even for twenty lines of plumbing — would make I1 a matter of
 * which symbols happen to be referenced rather than a property of the graph.
 */
export class EvidenceSink {
  #writer: FileEvidenceWriter | null = null;
  #prefix = '';

  /** Set by the loop each step, so per-step captures do not overwrite each other. */
  set prefix(value: string) {
    this.#prefix = value;
  }

  bind(writer: FileEvidenceWriter): void {
    this.#writer = writer;
  }

  release(): void {
    this.#writer = null;
  }

  /**
   * `found` is what the driver blacked out before handing the image down. The
   * image itself carries no record of that — it is a picture with rectangles on
   * it — so the summary has to travel alongside, or `redactions.json` reports
   * `[]` for a run whose screenshots are covered in black boxes. It is re-tagged
   * here rather than in the driver so the sink name is decided in one place, the
   * same way the log and prompt sinks decide theirs.
   */
  readonly screenshot = async (
    png: Uint8Array,
    label: string,
    found: readonly RedactionRecord[] = [],
  ): Promise<string> => {
    const ref = (await this.#writer?.writeScreenshot(png, this.#label(label))) ?? '(not persisted)';
    if (found.length > 0) await this.#writer?.noteRedactions(atSink(found, 'screenshot'));
    return ref;
  };

  readonly snapshot = async (json: unknown, label: string): Promise<string> => {
    return (await this.#writer?.writeSnapshot(json, this.#label(label))) ?? '(not persisted)';
  };

  #label(label: string): string {
    return this.#prefix === '' ? label : `${this.#prefix}-${label}`;
  }
}
