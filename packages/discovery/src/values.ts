import type { DiscoveryInput, RecordedValue, Sensitivity, Target } from '@cua/contracts';
import type { DefaultRedactor } from '@cua/redact';

/**
 * =============================================================================
 * VALUES: SUBSTITUTION AND CLASSIFICATION
 * =============================================================================
 * Two directions across the same boundary.
 *
 * Outbound, `resolve` turns `$.inputs.memberId` into the digits the driver types
 * — the only point in the system where a declared parameter and its value meet,
 * and it is three lines long and holds nothing.
 *
 * Inbound, `record` turns what was typed into a `RecordedValue`. A parameter
 * reference records as `redacted` because it *is* one by construction; a literal
 * the model invented is classified, and records as `redacted` too if it looks
 * sensitive. Only what survives both tests is written down.
 */

export const INPUT_REF = /^\$\.inputs\.([a-zA-Z][a-zA-Z0-9_]*)$/;

export function inputRefName(text: string): string | null {
  return INPUT_REF.exec(text)?.[1] ?? null;
}

export type Resolved =
  | { readonly ok: true; readonly text: string; readonly ref: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * Substitute a parameter reference, or pass a literal through.
 *
 * An unknown or undeclared reference is an error rather than a silent literal.
 * Typing `$.inputs.memberId` into a search box because nobody declared it would
 * produce a run that "worked" and a capability that searches for the string
 * `$.inputs.memberId` forever after.
 */
export function resolve(
  text: string,
  declared: readonly DiscoveryInput[],
  values: ReadonlyMap<string, string>,
): Resolved {
  const name = inputRefName(text);
  if (name === null) {
    if (text.startsWith('$.')) {
      return { ok: false, error: `'${text}' is not a valid parameter reference` };
    }
    return { ok: true, text, ref: null };
  }

  if (!declared.some((d) => d.name === name)) {
    const known = declared.map((d) => `$.inputs.${d.name}`).join(', ') || '(none)';
    return { ok: false, error: `no parameter named '${name}'; this run declares ${known}` };
  }

  const value = values.get(name);
  if (value === undefined) {
    return { ok: false, error: `parameter '${name}' was declared but no value was supplied` };
  }
  return { ok: true, text: value, ref: `$.inputs.${name}` };
}

/**
 * Classify what was typed, for the recording.
 *
 * `resolvedText` is the real value and is used only to measure it — its length
 * and its shape. It is never returned. That is what lets the compiler write
 * "this step takes a five-digit identifier" without anyone downstream having had
 * the chance to write down which five digits.
 */
export function record(
  literalOrRef: string,
  resolvedText: string,
  declared: readonly DiscoveryInput[],
  redactor: DefaultRedactor,
): RecordedValue {
  const name = inputRefName(literalOrRef);
  if (name !== null) {
    const input = declared.find((d) => d.name === name);
    return redactedValue(input?.classification ?? 'identifier', resolvedText, literalOrRef);
  }

  const { classification } = redactor.classify(literalOrRef);
  if (classification === 'none') return { kind: 'literal', value: literalOrRef };
  return redactedValue(classification, literalOrRef, null);
}

/**
 * Same classification, applied to a value read off the screen by `extract`.
 *
 * Never carries a `ref`: an extracted value is an output, and nothing the run
 * was handed produced it.
 */
export function recordExtracted(text: string, redactor: DefaultRedactor): RecordedValue {
  const { classification } = redactor.classify(text);
  return classification === 'none'
    ? { kind: 'literal', value: text }
    : redactedValue(classification, text, null);
}

function redactedValue(
  classification: Sensitivity,
  sample: string,
  ref: string | null,
): RecordedValue {
  return {
    kind: 'redacted',
    classification,
    inferredPattern: patternOf(sample),
    length: sample.length,
    ref,
  };
}

/**
 * Roles whose accessible name is page furniture rather than somebody's record.
 *
 * Used to filter `RecordedStep.appeared`, from which the compiler infers
 * checkpoints. Excluding `cell` is a safety measure and a correctness one at the
 * same time, which is the reason it is a filter rather than a redaction: a
 * checkpoint asserting that `cell:Renner, Alice M` appeared would pass for
 * exactly one member and fail for every other caller of the capability. The
 * landmarks — "Member Information", "Account Summary" — are what actually mean
 * "we arrived", and they are the same for everyone.
 */
const LANDMARK_ROLES = new Set([
  'heading',
  'text',
  'form',
  'table',
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'frame',
]);

/** Keep the landmarks, and drop any that still carry something sensitive. */
export function landmarks(appeared: readonly string[], redactor: DefaultRedactor): string[] {
  return appeared.filter((key) => {
    const role = key.slice(0, key.indexOf(':'));
    if (!LANDMARK_ROLES.has(role)) return false;
    return redactor.redactText(key).text === key;
  });
}

/**
 * Remove anything from a harvested bundle that carries record data.
 *
 * The interesting case is a `text` candidate for the savings balance cell,
 * whose value is `$4,231.08`. Storing it would put a member's balance in an
 * artifact, and the obvious fix — masking it to `[REDACTED:MONEY]` — would be
 * worse, because the bundle would then vote on a locator that can never match.
 *
 * So such candidates are *dropped*, and the loss is not a loss: a locator keyed
 * on one member's balance is worthless the moment the capability is invoked for
 * a different member. What survives redaction is exactly the set of candidates
 * that generalise, which is the set replay wanted anyway.
 */
export function sanitiseTarget(target: Target, redactor: DefaultRedactor): Target | null {
  const clean = (text: string | null): string | null =>
    text === null || redactor.redactText(text).text !== text ? null : text;

  const candidates = target.candidates.filter(
    (candidate) => redactor.redactText(candidate.value).text === candidate.value,
  );
  if (candidates.length === 0) return null;

  return {
    ...target,
    containerHint: clean(target.containerHint),
    positionHint: clean(target.positionHint),
    expectedName: clean(target.expectedName),
    candidates,
  };
}

/**
 * A regex describing the shape of a value, for the capability's input schema.
 *
 * Deliberately coarse. A tighter pattern derived from one example is a
 * validation rule fitted to a sample of size one, and it will reject the second
 * caller's perfectly good input.
 */
export function patternOf(value: string): string | null {
  if (value.length === 0) return null;
  if (/^\d+$/.test(value)) return `^[0-9]{${value.length}}$`;
  if (/^[A-Za-z]+$/.test(value)) return `^[A-Za-z]{${value.length}}$`;
  if (/^[A-Za-z0-9]+$/.test(value)) return `^[A-Za-z0-9]{${value.length}}$`;
  return null;
}
