import {
  refProperty,
  type DiscoveryInput,
  type ExtractAs,
  type JsonSchemaObject,
  type RecordedStep,
  type Sensitivity,
} from '@cua/contracts';

/**
 * =============================================================================
 * THE TOOL CONTRACT
 * =============================================================================
 * The inputs and outputs a calling agent sees, derived from what the run
 * actually did rather than from what it was told it might do.
 *
 * The distinction matters in both directions. A parameter that was declared but
 * never referenced is dropped, because publishing it would oblige every caller
 * to supply something no step consumes. A value the model typed that looked
 * sensitive but was not declared is *promoted* into a parameter, because the
 * alternative — freezing it into the artifact as a literal — is the leak the
 * whole system exists to prevent, and the schema refuses it anyway.
 */

export interface Contracts {
  readonly inputs: JsonSchemaObject;
  readonly outputs: JsonSchemaObject;
  readonly sensitivity: Record<string, Sensitivity>;
  /** Declared but unreferenced; reported as `declared_input_unused`. */
  readonly unusedInputs: readonly string[];
  /** Promoted literals, by step index; reported as `sensitive_literal_promoted`. */
  readonly promoted: ReadonlyMap<number, string>;
}

export function buildContracts(
  steps: readonly RecordedStep[],
  declared: readonly DiscoveryInput[],
): Contracts {
  const inputProps: Record<string, unknown> = {};
  const outputProps: Record<string, unknown> = {};
  const sensitivity: Record<string, Sensitivity> = {};
  const required: string[] = [];
  const promoted = new Map<number, string>();
  const used = new Set<string>();

  for (const step of steps) {
    // ---- inputs ------------------------------------------------------------
    const value = step.value;
    if (value?.kind === 'redacted') {
      const name = value.ref === null ? promotedName(inputProps) : refProperty(value.ref);
      if (value.ref === null) promoted.set(step.index, name);
      used.add(name);

      const input = declared.find((d) => d.name === name);
      inputProps[name] = {
        type: 'string',
        ...(value.inferredPattern === null ? {} : { pattern: value.inferredPattern }),
        description: input?.description ?? describePromoted(value.classification, value.length),
      };
      sensitivity[name] = value.classification;
      if (!required.includes(name)) required.push(name);
    }

    // ---- outputs -----------------------------------------------------------
    if (step.action.tool === 'extract') {
      const name = step.action.name;
      outputProps[name] = {
        type: 'string',
        ...formatOf(step.action.as),
        description: describeOutput(name, step.action.as),
      };
      // The classification comes from what was actually read off the screen, not
      // from a guess about the property name: `savingsBalance` is `financial`
      // because the redactor recognised a currency amount at capture time.
      sensitivity[name] = step.extracted?.kind === 'redacted' ? step.extracted.classification : 'none';
    }
  }

  return {
    inputs: {
      type: 'object',
      properties: inputProps,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    outputs: { type: 'object', properties: outputProps, additionalProperties: false },
    sensitivity,
    unusedInputs: declared.map((d) => d.name).filter((n) => !used.has(n)),
    promoted,
  };
}

/**
 * A name for a sensitive literal the model typed without a declaration.
 *
 * Deliberately unhelpful — `value1`, `value2`. A prettier guess ("memberId")
 * would read like a considered decision when it is a coin flip, and this
 * parameter is already flagged for human review by
 * `sensitive_literal_promoted`. The reviewer renames it; the compiler does not
 * pretend to know.
 */
function promotedName(taken: Record<string, unknown>): string {
  for (let n = 1; ; n++) {
    const name = `value${n}`;
    if (!(name in taken)) return name;
  }
}

function describePromoted(classification: Sensitivity, length: number): string {
  return (
    `Promoted from a literal typed during discovery (${classification}, ` +
    `${length} characters). Rename and describe this before approving.`
  );
}

function describeOutput(name: string, as: ExtractAs): string {
  return `Value read from the screen during discovery, as ${as} (${name}).`;
}

/** JSON Schema `format`, where one exists for the coercion we recorded. */
function formatOf(as: ExtractAs): Record<string, string> {
  switch (as) {
    case 'money':
      return { format: 'money' };
    case 'date':
      return { format: 'date' };
    case 'text':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'table':
      return {};
  }
}
