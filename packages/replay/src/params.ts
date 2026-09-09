import type { JsonSchemaObject } from '@cua/contracts';

/**
 * =============================================================================
 * PARAMETER BINDING
 * =============================================================================
 * The caller's `params` object, checked against the capability's `inputs` schema
 * and turned into the strings a step will type.
 *
 * Why this is not zod: `Capability.inputs` is literal JSON Schema, on purpose —
 * it is the tool contract a calling agent reads, and it must be consumable by
 * any agent runtime rather than by ours (D6). Validating it therefore means
 * interpreting JSON Schema, not reconstructing it in another library.
 *
 * We interpret a deliberately small subset, and the important decision is what
 * happens at its edge. A keyword we do not implement is NOT ignored: a schema
 * that says `"minimum": 100` and an engine that shrugs at it is worse than one
 * that refuses, because the caller believes a constraint is being enforced and
 * nothing says otherwise. Unknown *constraints* stop the run; unknown
 * *annotations* — `description`, `format`, `title` — are ignored, which is what
 * JSON Schema itself specifies for them.
 */

/** Keywords that constrain a value, and that this module actually checks. */
const ENFORCED = new Set([
  'type',
  'const',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
]);

/**
 * Keywords that describe rather than constrain. JSON Schema treats these as
 * annotations with no validation effect, so ignoring them is correct rather
 * than lenient — `format` included, which is why the compiler is free to emit
 * `"format": "money"` on an output without inventing a dialect.
 */
const ANNOTATIONS = new Set([
  'description',
  'title',
  'default',
  'examples',
  'format',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

export type BindResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string> }
  /** The caller's fault: the parameters do not satisfy the declared schema. */
  | { readonly ok: false; readonly kind: 'invalid'; readonly errors: readonly string[] }
  /** Our fault: the schema asks for something this engine cannot enforce. */
  | { readonly ok: false; readonly kind: 'unsupported'; readonly errors: readonly string[] };

/**
 * Validate `params` against `schema` and render each accepted value as the
 * string a `type` or `select` step will put on screen.
 *
 * Rendering happens here rather than at the step so that the conversion is
 * checked once, against the declared type, instead of being an implicit
 * `String(x)` deep inside the executor where a `[object Object]` would sail
 * through into a form field.
 */
export function bindParams(
  schema: JsonSchemaObject,
  params: Readonly<Record<string, unknown>>,
): BindResult {
  const properties = schema.properties ?? {};
  const required = new Set(readStringArray(schema, 'required'));
  const errors: string[] = [];
  const unsupported: string[] = [];
  const values = new Map<string, string>();

  if (schema.additionalProperties === false) {
    for (const name of Object.keys(params)) {
      if (!(name in properties)) errors.push(`'${name}' is not a declared input`);
    }
  }

  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    if (property === null) {
      unsupported.push(`input '${name}' has a schema this engine cannot read`);
      continue;
    }

    for (const keyword of Object.keys(property)) {
      if (!ENFORCED.has(keyword) && !ANNOTATIONS.has(keyword)) {
        unsupported.push(
          `input '${name}' declares '${keyword}', which this engine does not enforce; ` +
            `refusing to run rather than pretend the constraint holds`,
        );
      }
    }

    const supplied = Object.hasOwn(params, name) ? params[name] : undefined;
    if (supplied === undefined || supplied === null) {
      if (required.has(name)) errors.push(`'${name}' is required`);
      continue;
    }

    const checked = checkValue(name, supplied, property);
    if (checked.ok) values.set(name, checked.rendered);
    else errors.push(...checked.errors);
  }

  if (unsupported.length > 0) return { ok: false, kind: 'unsupported', errors: unsupported };
  if (errors.length > 0) return { ok: false, kind: 'invalid', errors };
  return { ok: true, values };
}

type Checked =
  | { readonly ok: true; readonly rendered: string }
  | { readonly ok: false; readonly errors: readonly string[] };

function checkValue(
  name: string,
  value: unknown,
  property: Readonly<Record<string, unknown>>,
): Checked {
  const errors: string[] = [];
  const declared = typeof property['type'] === 'string' ? property['type'] : null;

  // Type first: every check after this one assumes it holds, and reporting
  // "does not match pattern" about a boolean helps nobody.
  if (declared !== null && !hasType(value, declared)) {
    return { ok: false, errors: [`'${name}' must be a ${declared}, got ${describe(value)}`] };
  }

  const rendered = render(value);

  if ('const' in property && value !== property['const']) {
    errors.push(`'${name}' must equal ${JSON.stringify(property['const'])}`);
  }

  const options = property['enum'];
  if (Array.isArray(options) && !options.includes(value)) {
    errors.push(`'${name}' must be one of ${options.map((o) => JSON.stringify(o)).join(', ')}`);
  }

  const pattern = property['pattern'];
  if (typeof pattern === 'string') {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      return {
        ok: false,
        errors: [`'${name}' declares a pattern that is not a valid regular expression`],
      };
    }
    // Reported without echoing the value: a member id that failed validation is
    // still a member id, and an error message is a sink like any other (I3).
    if (!regex.test(rendered)) errors.push(`'${name}' does not match ${pattern}`);
  }

  const min = property['minLength'];
  if (typeof min === 'number' && rendered.length < min) {
    errors.push(`'${name}' must be at least ${min} characters`);
  }
  const max = property['maxLength'];
  if (typeof max === 'number' && rendered.length > max) {
    errors.push(`'${name}' must be at most ${max} characters`);
  }

  if (typeof value === 'number') {
    const lower = property['minimum'];
    if (typeof lower === 'number' && value < lower) errors.push(`'${name}' must be ≥ ${lower}`);
    const upper = property['maximum'];
    if (typeof upper === 'number' && value > upper) errors.push(`'${name}' must be ≤ ${upper}`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, rendered };
}

function hasType(value: unknown, declared: string): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      // `object`, `array`, `null`: a step can only type a scalar, so a schema
      // asking for one of these is a capability we cannot execute.
      return false;
  }
}

/**
 * The exact characters that will be typed.
 *
 * `String(n)` for numbers is deliberate and worth one line of thought: it means
 * `12345` and `"12345"` produce the same keystrokes, so a caller passing the
 * wrong JSON type still gets a run they can reason about — while the type check
 * above has already had its say about whether that was allowed.
 */
function render(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringArray(schema: JsonSchemaObject, key: string): readonly string[] {
  const raw = (schema as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}
