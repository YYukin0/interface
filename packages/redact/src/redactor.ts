import type { RedactionRecord, Redactor, Sensitivity } from '@cua/contracts';
import { detect, severityOf, type Detection } from './detect.js';
import { blackOutRegions, type Region } from './png.js';

/**
 * =============================================================================
 * THE REDACTOR
 * =============================================================================
 * Guards the three sinks named in I3: artifact writes, log writes, and outbound
 * prompts. There is no fourth path to disk or to a model.
 *
 * Two mechanisms, and the order matters because they have very different
 * reliability:
 *
 *   1. KNOWN VALUES — exact-match removal of the parameter values this run was
 *      actually given, plus any credentials read from the environment. This is
 *      the strong one. We know `memberId` is "12345" because the caller told
 *      us, so no pattern has to guess.
 *   2. RECOGNIZERS — regular expressions for things we were not told about.
 *      This is the weak one, and it is a backstop rather than the design.
 *
 * Most redaction discussions only ever build (2) and then rely on it. Getting
 * (1) is free here purely because a capability declares its parameters and
 * their classifications up front — which is one of the quieter arguments for
 * the artifact having a typed contract at all.
 */

export interface RedactorOptions {
  /** Detections below this confidence are ignored. */
  readonly minConfidence?: number;
  /**
   * Values this run is known to be handling, mapped to their classification.
   * Anything classified `none` is ignored; everything else is removed by exact
   * match wherever it appears.
   */
  readonly knownValues?: ReadonlyMap<string, Sensitivity>;
}

/** Values shorter than this are not exact-matched: too many false positives. */
const MIN_KNOWN_VALUE_LENGTH = 3;

export class DefaultRedactor implements Redactor {
  readonly #minConfidence: number;
  readonly #known: ReadonlyMap<string, Sensitivity>;

  constructor(options: RedactorOptions = {}) {
    this.#minConfidence = options.minConfidence ?? 0.5;
    this.#known = options.knownValues ?? new Map();
  }

  /**
   * A new redactor that also knows these values.
   *
   * Returns a copy rather than mutating, so a run's redactor cannot acquire
   * knowledge of another run's parameters by accident.
   */
  withKnownValues(values: ReadonlyMap<string, Sensitivity>): DefaultRedactor {
    const merged = new Map(this.#known);
    for (const [value, classification] of values) merged.set(value, classification);
    return new DefaultRedactor({ minConfidence: this.#minConfidence, knownValues: merged });
  }

  /**
   * Convenience for the common case: a capability's parameters plus its
   * declared per-property classifications.
   */
  withParameters(
    params: Readonly<Record<string, unknown>>,
    classification: Readonly<Record<string, Sensitivity>>,
  ): DefaultRedactor {
    const values = new Map<string, Sensitivity>();
    for (const [name, value] of Object.entries(params)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const tag = classification[name] ?? 'identifier';
      if (tag === 'none') continue;
      const text = String(value);
      if (text.length >= MIN_KNOWN_VALUE_LENGTH) values.set(text, tag);
    }
    return this.withKnownValues(values);
  }

  redactText(input: string): { text: string; found: readonly RedactionRecord[] } {
    const spans: Detection[] = [...this.#knownValueSpans(input), ...detect(input, this.#minConfidence)];

    // Known-value spans are pushed first and win ties, because an exact match on
    // a value we were handed beats any pattern's opinion about it.
    const kept: Detection[] = [];
    for (const d of spans) {
      if (kept.some((k) => d.start < k.end && k.start < d.end)) continue;
      kept.push(d);
    }
    kept.sort((a, b) => a.start - b.start);

    let text = '';
    let cursor = 0;
    for (const d of kept) {
      text += input.slice(cursor, d.start) + `[REDACTED:${d.entity}]`;
      cursor = d.end;
    }
    text += input.slice(cursor);

    return { text, found: summarise(kept) };
  }

  async redactImage(png: Uint8Array, regions: readonly Region[]): Promise<Uint8Array> {
    return blackOutRegions(png, regions);
  }

  classify(value: string): { classification: Sensitivity; confidence: number } {
    const known = this.#known.get(value);
    if (known) return { classification: known, confidence: 1 };

    // Anchor so that classifying a single field value asks "is this thing
    // sensitive", not "does this contain something sensitive". A page of prose
    // is redactText's job, not classify's.
    const hits = detect(value, this.#minConfidence).filter(
      (d) => d.start === 0 && d.end === value.length,
    );
    if (hits.length === 0) return { classification: 'none', confidence: 0 };

    const strongest = hits.reduce((best, d) =>
      severityOf(d.classification) > severityOf(best.classification) ||
      (severityOf(d.classification) === severityOf(best.classification) &&
        d.confidence > best.confidence)
        ? d
        : best,
    );
    return { classification: strongest.classification, confidence: strongest.confidence };
  }

  *#knownValueSpans(input: string): Generator<Detection> {
    for (const [value, classification] of this.#known) {
      if (value.length < MIN_KNOWN_VALUE_LENGTH) continue;
      let from = 0;
      for (;;) {
        const at = input.indexOf(value, from);
        if (at === -1) break;
        yield {
          entity: entityFor(classification),
          classification,
          confidence: 1,
          start: at,
          end: at + value.length,
        };
        from = at + value.length;
      }
    }
  }
}

/**
 * Entity label for a value we know is sensitive but have no pattern for. It
 * names the classification rather than inventing a type, because claiming we
 * recognised a "MEMBER_ID" when all we know is that the caller called it an
 * identifier would be a small lie in an audit record.
 */
function entityFor(classification: Sensitivity): string {
  return `SUPPLIED_${classification.toUpperCase()}`;
}

/**
 * Collapse detections into per-entity counts.
 *
 * This is the audit record, and it deliberately carries no offsets and no
 * values: an attacker with the log should learn that a card number was present,
 * not where or what.
 */
function summarise(detections: readonly Detection[]): readonly RedactionRecord[] {
  const byEntity = new Map<string, RedactionRecord>();
  for (const d of detections) {
    const existing = byEntity.get(d.entity);
    byEntity.set(d.entity, {
      entity: d.entity,
      classification: d.classification,
      confidence: existing ? Math.max(existing.confidence, d.confidence) : d.confidence,
      sink: 'log',
      count: (existing?.count ?? 0) + 1,
    });
  }
  return [...byEntity.values()];
}

/**
 * Re-tag an audit record for the sink it was produced at.
 *
 * `redactText` cannot know whether its caller is writing a log line, an
 * artifact, or a prompt, and the sink is the most useful column in the audit
 * table — "we caught a card number on its way into a prompt" and "we caught one
 * on its way into a log" are different incidents.
 */
export function atSink(
  records: readonly RedactionRecord[],
  sink: RedactionRecord['sink'],
): readonly RedactionRecord[] {
  return records.map((r) => ({ ...r, sink }));
}
