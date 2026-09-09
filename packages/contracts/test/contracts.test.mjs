/**
 * Invariant tests for the contract layer.
 *
 * These are not schema-library smoke tests. Every case below corresponds to a
 * way a capability can be internally inconsistent while every individual field
 * is valid — the class of bug that survives review and surfaces later as a
 * mystifying replay failure. If one of these starts passing when it should
 * fail, an invariant in AGENTS.md §3 has quietly stopped being enforced.
 *
 *   node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  capability,
  policyDocument,
  recordedAction,
  replayResult,
  toRecordedAction,
  toToolDefinition,
  applyTenantOverride,
  DRIFT_REBASELINE_THRESHOLD,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '..',
  'examples',
  'member.read_savings_balance.capability.json',
);
const FIXTURE = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** Fresh mutable copy of the fixture, so cases cannot leak into each other. */
const base = () => structuredClone(FIXTURE);

/** Assert parsing fails, and that it fails for the expected reason. */
function rejects(doc, expectedFragment) {
  const result = capability.safeParse(doc);
  assert.equal(result.success, false, 'expected the schema to reject this document');
  const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  assert.ok(
    messages.toLowerCase().includes(expectedFragment.toLowerCase()),
    `expected an issue mentioning "${expectedFragment}", got:\n${messages}`,
  );
}

// ---------------------------------------------------------------------------
// The artifact parses at all
// ---------------------------------------------------------------------------

test('the example capability parses', () => {
  const result = capability.safeParse(base());
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

test('parsing is stable under round-trip', () => {
  const once = capability.parse(base());
  const twice = capability.parse(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

// ---------------------------------------------------------------------------
// I5 — the artifact is decoupled from the transcript
// ---------------------------------------------------------------------------

test('rejects unknown top-level keys so recorder internals cannot leak in', () => {
  const doc = base();
  doc.rawModelTranscript = 'I clicked the thing because…';
  rejects(doc, 'unrecognized key');
});

test('rejects unknown keys inside a step', () => {
  const doc = base();
  doc.steps[0].elementHash = 'a1b2c3';
  rejects(doc, 'unrecognized key');
});

// ---------------------------------------------------------------------------
// The contract must be internally consistent
// ---------------------------------------------------------------------------

test('rejects a step reading an input that is not declared', () => {
  const doc = base();
  doc.steps[1].action.value.ref = '$.inputs.notDeclared';
  rejects(doc, 'not a declared input');
});

test('rejects a step extracting into an output that is not declared', () => {
  const doc = base();
  doc.steps[3].action.into = '$.outputs.phantom';
  rejects(doc, 'not a declared output');
});

test('rejects a declared output that no step ever produces', () => {
  const doc = base();
  doc.outputs.properties.lastVisitDate = { type: 'string' };
  doc.sensitivity.lastVisitDate = 'none';
  rejects(doc, 'never extracted');
});

test('rejects duplicate step ids', () => {
  const doc = base();
  doc.steps[2].id = doc.steps[1].id;
  rejects(doc, 'duplicate step id');
});

test('rejects duplicate checkpoint ids across steps and outcomes', () => {
  const doc = base();
  doc.businessOutcomes[0].detect.id = 'chk.on_detail';
  rejects(doc, 'duplicate checkpoint id');
});

test('rejects a success condition referencing an unknown checkpoint', () => {
  const doc = base();
  doc.successCondition.checkpoints.push('chk.never_declared');
  rejects(doc, 'unknown checkpoint');
});

test('rejects a capability with no success condition at all', () => {
  const doc = base();
  doc.successCondition = { checkpoints: [], requiredOutputs: [] };
  rejects(doc, 'cannot verify');
});

test('rejects a tenant override pointing at a step that does not exist', () => {
  const doc = base();
  doc.tenantOverrides['tenant-b'].steps.s99 = { target: null, timeoutMs: null, skip: false };
  rejects(doc, 'unknown step');
});

// ---------------------------------------------------------------------------
// Actions and their targets — illegal states unrepresentable
// ---------------------------------------------------------------------------

test('rejects a click with no target', () => {
  const doc = base();
  doc.steps[0].target = null;
  rejects(doc, 'requires a target');
});

test('rejects a navigate that carries a target', () => {
  const doc = base();
  doc.steps.splice(1, 0, {
    id: 's9',
    intent: 'Navigate somewhere',
    risk: 'safe',
    action: { type: 'navigate', to: '/admin/search.htm' },
    target: structuredClone(doc.steps[0].target),
    checkpoint: null,
    recover: [],
    timeoutMs: 5000,
    optional: false,
  });
  rejects(doc, 'target must be null');
});

test('rejects a page-scoped assertion that carries a target', () => {
  const doc = base();
  doc.steps[0].checkpoint.target = structuredClone(doc.steps[0].target);
  rejects(doc, 'page-scoped');
});

test('rejects an element-scoped assertion with no target', () => {
  const doc = base();
  doc.steps[0].checkpoint = {
    id: 'chk.balance_visible',
    assert: 'element-visible',
    value: 'Savings',
    target: null,
    timeoutMs: 5000,
  };
  rejects(doc, 'requires a target');
});

test("rejects a role-name-present assertion that is not 'role:name'", () => {
  const doc = base();
  doc.steps[0].checkpoint.value = 'Member ID';
  rejects(doc, "'role:name'");
});

// ---------------------------------------------------------------------------
// I3 — sensitive data never lands in the artifact
// ---------------------------------------------------------------------------

test('rejects a literal that looks like an account number', () => {
  const doc = base();
  doc.steps[1].action.value = { from: 'literal', value: '4012 8888 8888 1881' };
  rejects(doc, 'sensitive');
});

test('rejects a literal that looks like a currency amount', () => {
  const doc = base();
  doc.steps[1].action.value = { from: 'literal', value: '$4,231.08' };
  rejects(doc, 'sensitive');
});

test('allows a harmless literal', () => {
  const doc = base();
  doc.steps[1].action.value = { from: 'literal', value: 'Savings' };
  assert.equal(capability.safeParse(doc).success, true);
});

test('the recorded action has nowhere to put the text that was typed', () => {
  // I3, enforced by construction rather than by a scrub. The driver receives an
  // `agentAction` carrying the literal string, because it has to type it; what
  // reaches disk is a `recordedAction`, and `.strict()` means a caller that
  // tries to smuggle the value through anyway is rejected outright.
  assert.equal(recordedAction.safeParse({ tool: 'type', clearFirst: true }).success, true);

  const smuggled = recordedAction.safeParse({ tool: 'type', clearFirst: true, text: '12345' });
  assert.equal(smuggled.success, false);
  assert.match(JSON.stringify(smuggled.error.issues), /unrecognized_keys|text/);

  assert.equal(recordedAction.safeParse({ tool: 'select', option: 'Northgate' }).success, false);
});

test('translating an agent action drops the payload and keeps the shape', () => {
  assert.deepEqual(toRecordedAction({ tool: 'type', ref: 'f1e7', text: '12345' }), {
    tool: 'type',
    clearFirst: true,
  });
  assert.deepEqual(toRecordedAction({ tool: 'select', ref: 'f1e9', option: 'Northgate' }), {
    tool: 'select',
  });

  // Non-payload arguments survive, because the compiler needs them and none of
  // them can carry member data.
  assert.deepEqual(toRecordedAction({ tool: 'press_key', key: 'Enter' }), {
    tool: 'press_key',
    key: 'Enter',
  });

  // Terminal tools are not steps and produce nothing to record.
  assert.equal(toRecordedAction({ tool: 'done', summary: 'read the balance' }), null);
  assert.equal(
    toRecordedAction({ tool: 'stuck', reason: 'ambiguous_ui', explanation: 'two Savings rows' }),
    null,
  );
});

test('rejects an input or output with no data classification', () => {
  const doc = base();
  delete doc.sensitivity.savingsBalance;
  rejects(doc, 'no data classification');
});

test('rejects a capability parameter classified as a secret', () => {
  const doc = base();
  doc.sensitivity.memberId = 'secret';
  rejects(doc, 'must not be a capability parameter');
});

// ---------------------------------------------------------------------------
// I8 and the risk model
// ---------------------------------------------------------------------------

test('rejects an irreversible step with no checkpoint', () => {
  const doc = base();
  doc.steps[2].risk = 'irreversible';
  doc.steps[2].checkpoint = null;
  rejects(doc, 'must declare a checkpoint');
});

test('rejects a mutating step marked optional, which would allow a silent partial write', () => {
  const doc = base();
  doc.steps[4].risk = 'mutating';
  rejects(doc, 'must not be skippable');
});

test('rejects an approved capability with no approver recorded', () => {
  const doc = base();
  doc.approval.state = 'approved';
  rejects(doc, 'who approved it');
});

test('policy cannot be configured to allow irreversible actions unattended', () => {
  const result = policyDocument.safeParse({
    version: '1.0.0',
    risk: { safe: 'allow', mutating: 'confirm', irreversible: 'allow' },
  });
  assert.equal(result.success, false, 'irreversible: allow must be unrepresentable');
});

// ---------------------------------------------------------------------------
// I1 — the production path does not consult a model
// ---------------------------------------------------------------------------

const okStats = {
  startedAt: '2026-09-09T10:22:03Z',
  durationMs: 4210,
  stepsExecuted: 5,
  stepsTotal: 5,
  recoveriesPerformed: 0,
  llmCalls: 0,
};

const okResultBase = {
  capabilityId: 'member.read_savings_balance',
  capabilityVersion: '1.0.0',
  tenant: null,
  evidence: { runId: 'r1', path: 'evidence/r1' },
  stats: okStats,
  steps: [],
};

test('a replay result recording any LLM call is invalid', () => {
  const result = replayResult.safeParse({
    kind: 'success',
    ...okResultBase,
    stats: { ...okStats, llmCalls: 1 },
    outputs: {},
  });
  assert.equal(result.success, false, 'llmCalls must be pinned to 0 on the replay path');
});

// ---------------------------------------------------------------------------
// I2 — outcomes and failures are different things, structurally
// ---------------------------------------------------------------------------

test('a failure result cannot carry outputs', () => {
  const result = replayResult.safeParse({
    kind: 'failure',
    ...okResultBase,
    failure: {
      class: 'CHECKPOINT_FAILED',
      stepId: 's3',
      expected: 'Account Summary',
      observed: 'No records matched your search',
      detail: null,
    },
    outputs: { savingsBalance: '$4,231.08' },
  });
  assert.equal(result.success, false, 'outputs on a failure must be unrepresentable');
});

test('a business outcome is a valid result that may carry partial outputs', () => {
  const result = replayResult.safeParse({
    kind: 'outcome',
    ...okResultBase,
    code: 'MEMBER_NOT_FOUND',
    message: 'No member exists with the supplied ID.',
    retryable: true,
    outputs: {},
  });
  assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
});

// ---------------------------------------------------------------------------
// The agent-facing projection
// ---------------------------------------------------------------------------

test('a read-only capability is annotated read-only and idempotent', () => {
  const tool = toToolDefinition(capability.parse(base()));
  assert.equal(tool.readOnlyHint ?? tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
});

test('a draft capability is not available for unattended invocation', () => {
  const tool = toToolDefinition(capability.parse(base()));
  assert.equal(tool.annotations.availableUnattended, false);
});

test('one irreversible step makes the whole capability destructive', () => {
  const doc = base();
  doc.steps[2].risk = 'irreversible';
  const tool = toToolDefinition(capability.parse(doc));
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.readOnlyHint, false);
});

test('declared business outcomes reach the calling agent', () => {
  const tool = toToolDefinition(capability.parse(base()));
  assert.deepEqual(
    tool.outcomes.map((o) => o.code).sort(),
    ['MEMBER_NOT_FOUND', 'PERMISSION_DENIED'],
  );
});

// ---------------------------------------------------------------------------
// Cross-tenant reuse
// ---------------------------------------------------------------------------

test('an unknown tenant runs the baseline unchanged rather than failing', () => {
  const c = capability.parse(base());
  const resolved = applyTenantOverride(c, 'tenant-never-seen-before');
  assert.deepEqual(resolved.effective, c);
  assert.equal(resolved.applied.length, 0);
  assert.equal(resolved.driftScore, 0);
  assert.equal(resolved.needsRebaseline, false);
});

test('a null tenant runs the baseline unchanged', () => {
  const c = capability.parse(base());
  assert.deepEqual(applyTenantOverride(c, null).effective, c);
});

test('tenant overrides replace only the steps they name', () => {
  const c = capability.parse(base());
  const resolved = applyTenantOverride(c, 'tenant-b');

  assert.deepEqual(
    resolved.applied.map((a) => a.stepId).sort(),
    ['s1', 's4'],
  );

  // The overridden step picked up this tenant's renamed nav link…
  const s1 = resolved.effective.steps.find((s) => s.id === 's1');
  assert.equal(s1.target.expectedName, 'Find Member');

  // …and every untouched step is identical to the baseline.
  for (const id of ['s2', 's3', 's5']) {
    assert.deepEqual(
      resolved.effective.steps.find((s) => s.id === id),
      c.steps.find((s) => s.id === id),
    );
  }
});

test('the drift score flags a tenant that has diverged too far to keep patching', () => {
  const c = capability.parse(base());
  const resolved = applyTenantOverride(c, 'tenant-b');

  // 2 of 5 steps overridden.
  assert.equal(resolved.driftScore, 0.4);
  assert.ok(resolved.driftScore > DRIFT_REBASELINE_THRESHOLD);
  assert.equal(resolved.needsRebaseline, true);
});

test('the resolved capability is still a valid capability', () => {
  const c = capability.parse(base());
  const resolved = applyTenantOverride(c, 'tenant-b');
  const reparsed = capability.safeParse(resolved.effective);
  assert.equal(reparsed.success, true, JSON.stringify(reparsed.error?.issues, null, 2));
});
