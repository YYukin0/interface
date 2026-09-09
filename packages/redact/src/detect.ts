import type { Sensitivity } from '@cua/contracts';

/**
 * =============================================================================
 * DETECTION
 * =============================================================================
 * Separated from redaction, following Presidio. That split is the single most
 * useful property of this design and the reason the module is shaped this way:
 * it lets the audit log say *"one FINANCIAL_ACCOUNT found at step 3, confidence
 * 0.85"* and prove the pipeline ran, without the log becoming the leak it was
 * supposed to prevent.
 *
 * The recognizers below are regular expressions. That is a real limitation and
 * it is stated here as well as in REPORT.md §6: a member's name in free prose
 * is not detectable this way, and neither is an account number written in words.
 * Regex detection is the floor, not the ceiling — the load-bearing protections
 * are structural (secrets come from the environment and are never parameters;
 * the artifact schema refuses sensitive literals; known parameter values are
 * redacted by exact match).
 */

export interface Detection {
  readonly entity: string;
  readonly classification: Sensitivity;
  readonly confidence: number;
  readonly start: number;
  readonly end: number;
}

interface Recognizer {
  readonly entity: string;
  readonly classification: Sensitivity;
  readonly confidence: number;
  readonly pattern: RegExp;
  /** Which capture group holds the value. 0 means the whole match. */
  readonly group?: number;
  /** Extra test the match must pass, e.g. a checksum. */
  readonly validate?: (value: string) => boolean;
  /** Confidence when `validate` exists and passes. */
  readonly validatedConfidence?: number;
}

/** Luhn check. Turns "a run of digits" into "a payment card", or does not. */
function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Ordered by specificity, not by severity. Overlap resolution (below) prefers
 * the most specific match, so `4111-1111-1111-1111` is reported once as a
 * payment card rather than three times as a digit run.
 */
export const RECOGNIZERS: readonly Recognizer[] = [
  {
    /**
     * A credential *assignment* — `password: hunter2`, `CUA_APP_PASSWORD=x`.
     *
     * An assignment operator is required, and that restriction is the whole
     * design of this recognizer. Matching "keyword followed by a word" would
     * redact `today` out of "reset your password today", and a redactor that
     * mangles ordinary prose gets switched off. The lookbehind rather than `\b`
     * is so `CUA_APP_PASSWORD` is recognised despite the underscore.
     */
    entity: 'CREDENTIAL',
    classification: 'secret',
    confidence: 0.95,
    pattern:
      /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization)(?![A-Za-z0-9])["']?\s*[:=]\s*["']?(?!(?:bearer|basic)(?![A-Za-z0-9]))([^\s"',;}]{4,})/gi,
    group: 1,
  },
  {
    /** `Authorization: Bearer eyJ…` — the scheme is not the secret. */
    entity: 'BEARER_TOKEN',
    classification: 'secret',
    confidence: 0.95,
    pattern: /(?<![A-Za-z0-9])(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    group: 1,
  },
  {
    entity: 'US_SSN',
    classification: 'pii',
    confidence: 0.9,
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    entity: 'PAYMENT_CARD',
    classification: 'financial',
    confidence: 0.45,
    validatedConfidence: 0.95,
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: luhn,
  },
  {
    // The target application's own account numbering, e.g. `SV-0012345`.
    entity: 'FINANCIAL_ACCOUNT',
    classification: 'financial',
    confidence: 0.85,
    pattern: /\b[A-Z]{2}-\d{6,}\b/g,
  },
  {
    entity: 'MONEY',
    classification: 'financial',
    confidence: 0.8,
    pattern: /(?:[$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})+\.\d{2}\b)/g,
  },
  {
    entity: 'EMAIL',
    classification: 'pii',
    confidence: 0.9,
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    entity: 'PHONE',
    classification: 'pii',
    confidence: 0.65,
    pattern: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
  },
  {
    /**
     * A member name in the vendor's own record convention: `Renner, Alice M`.
     *
     * Deployment-specific by design, like `FINANCIAL_ACCOUNT` above. General
     * person-name detection needs NER and is out of scope (see the header); what
     * is in scope is the one format this product writes names in, everywhere it
     * writes them — search results, detail headers, statement lines. That covers
     * the sink that actually leaked in practice: the model reads a name off the
     * screen and echoes it into its own free-text summary, where no structural
     * protection reaches it.
     *
     * The surname-first comma is what makes the pattern usable. Run over every
     * evidence file this system has produced plus the application's own source,
     * it matched nine distinct strings: eight member and officer names, and the
     * CSS font stack `Verdana, Arial`. That is the shape of the trade — it runs
     * in the safe direction, since an over-redacted font name costs a reader
     * nothing and an under-redacted person costs a member their privacy — and it
     * is why this sits at 0.6 rather than up with SSN: an operator who finds it
     * noisy can raise `minConfidence` and lose this before losing anything that
     * matters more.
     */
    entity: 'PERSON_NAME',
    classification: 'pii',
    confidence: 0.6,
    pattern: /\b[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?,\s+[A-Z][a-z]+(?:\s+[A-Z]\b\.?)?/g,
  },
  {
    // Context-qualified member number. A bare five-digit run is deliberately NOT
    // a recognizer: it is equally a postcode, a step count, or a millisecond
    // duration, and redacting all of them would shred the logs we rely on for
    // evidence. The label is what carries the signal.
    entity: 'MEMBER_ID',
    classification: 'identifier',
    confidence: 0.85,
    pattern: /\b(?:member|acct|account|cif)\s*(?:id|no|num|number|#)?\s*[:=#]?\s*(\d{4,})\b/gi,
    group: 1,
  },
];

/** Severity order, used to break ties when two recognizers overlap. */
const SEVERITY: Record<Sensitivity, number> = {
  none: 0,
  identifier: 1,
  pii: 2,
  financial: 3,
  secret: 4,
};

export function severityOf(classification: Sensitivity): number {
  return SEVERITY[classification];
}

/**
 * Find every sensitive span in `text`.
 *
 * Overlapping detections are resolved by keeping the strongest: higher
 * classification severity first, then higher confidence, then the longer span.
 * The alternative — reporting all of them — would double-count in the audit log
 * and produce nested replacement markers in the output.
 */
export function detect(text: string, minConfidence = 0.5): readonly Detection[] {
  const found: Detection[] = [];

  for (const r of RECOGNIZERS) {
    // Fresh RegExp per call: the module-level literals are /g and therefore
    // stateful, and sharing lastIndex across calls makes detection depend on
    // call order. That is the kind of bug that shows up as an intermittent leak.
    const re = new RegExp(r.pattern.source, r.pattern.flags);
    for (const m of text.matchAll(re)) {
      const group = r.group ?? 0;
      const value = m[group];
      if (value === undefined) continue;

      const offset = group === 0 ? 0 : m[0].indexOf(value);
      if (offset < 0) continue;
      const start = m.index + offset;

      let confidence = r.confidence;
      if (r.validate) {
        confidence = r.validate(value) ? (r.validatedConfidence ?? r.confidence) : r.confidence;
      }
      if (confidence < minConfidence) continue;

      found.push({
        entity: r.entity,
        classification: r.classification,
        confidence,
        start,
        end: start + value.length,
      });
    }
  }

  return resolveOverlaps(found);
}

function resolveOverlaps(all: readonly Detection[]): readonly Detection[] {
  const ranked = [...all].sort((a, b) => {
    const bySeverity = SEVERITY[b.classification] - SEVERITY[a.classification];
    if (bySeverity !== 0) return bySeverity;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.end - b.start - (a.end - a.start);
  });

  const kept: Detection[] = [];
  for (const d of ranked) {
    if (kept.some((k) => d.start < k.end && k.start < d.end)) continue;
    kept.push(d);
  }
  return kept.sort((a, b) => a.start - b.start);
}
