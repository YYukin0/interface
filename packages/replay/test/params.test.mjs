/**
 * =============================================================================
 * PARAMETER BINDING — UNIT TESTS
 * =============================================================================
 * No browser and no application: this module's whole job is to decide, from a
 * JSON Schema and an object, whether a run may start. The interesting cases are
 * the three kinds of answer — bind it, reject the caller, refuse the schema —
 * and the last one is the one worth testing hardest, because "we quietly did not
 * enforce that constraint" is the failure nobody notices.
 *
 *   npm test --workspace @cua/replay
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bindParams } from '../dist/index.js';

/** The member-id schema the real capability declares, plus what each test needs. */
const memberId = {
  type: 'object',
  properties: {
    memberId: { type: 'string', pattern: '^[0-9]{5}$', description: "The member's five-digit id" },
  },
  required: ['memberId'],
  additionalProperties: false,
};

describe('accepting', () => {
  test('binds a value that satisfies the schema', () => {
    const bound = bindParams(memberId, { memberId: '12345' });
    assert.equal(bound.ok, true);
    assert.equal(bound.values.get('memberId'), '12345');
  });

  test('renders a number as the characters that will be typed', () => {
    const schema = { type: 'object', properties: { amount: { type: 'number', minimum: 1 } } };
    const bound = bindParams(schema, { amount: 500 });
    assert.equal(bound.ok, true);
    assert.equal(bound.values.get('amount'), '500');
  });

  test('an absent optional input binds nothing rather than an empty string', () => {
    const schema = { type: 'object', properties: { memo: { type: 'string' } } };
    const bound = bindParams(schema, {});
    assert.equal(bound.ok, true);
    assert.equal(bound.values.has('memo'), false);
  });

  test('ignores annotations, which JSON Schema says have no validation effect', () => {
    const schema = {
      type: 'object',
      properties: {
        amount: { type: 'string', title: 'Amount', format: 'money', examples: ['$1.00'] },
      },
    };
    assert.equal(bindParams(schema, { amount: '$1.00' }).ok, true);
  });
});

describe('rejecting the caller', () => {
  const invalid = (params, schema = memberId) => {
    const bound = bindParams(schema, params);
    assert.equal(bound.ok, false);
    assert.equal(bound.kind, 'invalid');
    return bound.errors.join(' | ');
  };

  test('a missing required input', () => {
    assert.match(invalid({}), /'memberId' is required/);
  });

  test('a wrong type, reported as a type error and not as a pattern error', () => {
    const message = invalid({ memberId: 12345 });
    assert.match(message, /must be a string/);
    assert.doesNotMatch(message, /pattern|\^/);
  });

  test('an undeclared input, when the schema is closed', () => {
    assert.match(invalid({ memberId: '12345', sneaky: 'x' }), /'sneaky' is not a declared input/);
  });

  test('a pattern failure never echoes the value (I3)', () => {
    // The rejected value is still a member id. An error message is a sink like
    // any other, and this is the one place where a validation failure would
    // otherwise hand a PII-shaped string to a log line.
    const message = invalid({ memberId: '4111111111111111' });
    assert.match(message, /does not match/);
    assert.equal(message.includes('4111111111111111'), false);
  });

  test('numeric bounds', () => {
    const schema = {
      type: 'object',
      properties: { amount: { type: 'number', minimum: 1, maximum: 100 } },
    };
    assert.match(invalid({ amount: 0 }, schema), /≥ 1/);
    assert.match(invalid({ amount: 101 }, schema), /≤ 100/);
  });

  test('enum and const', () => {
    const schema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['SV1', 'SV2'] },
        fixed: { type: 'string', const: 'yes' },
      },
    };
    assert.match(invalid({ kind: 'CK1', fixed: 'yes' }, schema), /must be one of/);
    assert.match(invalid({ kind: 'SV1', fixed: 'no' }, schema), /must equal "yes"/);
  });
});

describe('refusing the schema', () => {
  const unsupported = (schema, params = {}) => {
    const bound = bindParams(schema, params);
    assert.equal(bound.ok, false);
    assert.equal(bound.kind, 'unsupported');
    return bound.errors.join(' | ');
  };

  test('an unimplemented constraint stops the run instead of being ignored', () => {
    // The point of the whole module. `multipleOf` is not enforced here, and the
    // wrong behaviour would be to bind 7 anyway: the artifact says a constraint
    // holds, so either it is checked or the run does not start.
    const schema = {
      type: 'object',
      properties: { amount: { type: 'number', multipleOf: 5 } },
    };
    assert.match(unsupported(schema, { amount: 7 }), /multipleOf.*does not enforce/s);
  });

  test('refusal outranks a caller error, because it is our bug and not theirs', () => {
    const schema = {
      type: 'object',
      properties: { amount: { type: 'number', exclusiveMinimum: 0 } },
      required: ['amount'],
    };
    // `amount` is also missing; the answer is still the schema we cannot honour.
    assert.match(unsupported(schema, {}), /exclusiveMinimum/);
  });

  test('a non-scalar input, which no step could type', () => {
    const schema = { type: 'object', properties: { who: { type: 'object' } } };
    const bound = bindParams(schema, { who: { name: 'x' } });
    assert.equal(bound.ok, false);
    assert.equal(bound.kind, 'invalid');
  });
});
