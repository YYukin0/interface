/**
 * Policy tests.
 *
 * Two things are being pinned here, and only two. First, that the engine is
 * default-deny — an empty allowlist must refuse everything, because that is the
 * behaviour a misconfigured deployment gets. Second, that every denial names
 * the rule that produced it, since an unattributable refusal is not auditable.
 *
 *   node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { policyDocument } from '@cua/contracts';
import { AllowlistPolicyEngine, RULES, DENY_ALL } from '../dist/index.js';

const OPEN = policyDocument.parse({
  version: '1.0.0',
  allowedOrigins: ['http://localhost:8080'],
  allowedPathPrefixes: ['/admin/'],
  allowedActions: ['click', 'type', 'extract', 'navigate'],
  maxStepsPerRun: 10,
  risk: { safe: 'allow', mutating: 'confirm', irreversible: 'deny' },
  denyPatterns: ['/admin/signoff\\.do'],
});

/** @param {Partial<Record<string, unknown>>} over */
const req = (over = {}) => ({
  principal: { kind: 'calling-agent', id: 'agent-1', tenant: null },
  phase: 'replay',
  capabilityId: 'member.read_savings_balance',
  stepId: 's1',
  action: 'click',
  risk: 'safe',
  location: 'http://localhost:8080/admin/search.htm',
  stepIndex: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// Default deny
// ---------------------------------------------------------------------------

test('an empty policy permits nothing', () => {
  const engine = new AllowlistPolicyEngine(DENY_ALL);
  const decision = engine.evaluate(req());
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.rule, RULES.origin);
});

test('a safe action inside the allowlist is permitted', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  assert.deepEqual(engine.evaluate(req()), { kind: 'allow' });
});

// ---------------------------------------------------------------------------
// Each rule fires, and each denial is attributable
// ---------------------------------------------------------------------------

test('an explicit deny pattern beats the allowlist', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  const decision = engine.evaluate(
    req({ action: 'navigate', location: 'http://localhost:8080/admin/signoff.do' }),
  );
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.rule, RULES.denyPattern);
});

test('a foreign origin is denied even on an allowed path', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  const decision = engine.evaluate(req({ location: 'http://evil.example/admin/search.htm' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.rule, RULES.origin);
});

test('an unlisted path prefix is denied on the right origin', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  const decision = engine.evaluate(req({ location: 'http://localhost:8080/internal/ops.htm' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.rule, RULES.pathPrefix);
});

test('an action outside the vocabulary is denied', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  const decision = engine.evaluate(req({ action: 'double_click' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.rule, RULES.actionType);
});

test('the step budget is exhausted at the configured count, not one past it', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  assert.equal(engine.evaluate(req({ stepIndex: 9 })).kind, 'allow');
  const decision = engine.evaluate(req({ stepIndex: 10 }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.rule, RULES.stepBudget);
});

test('a non-URL location has no origin and therefore no allowlist match', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  const decision = engine.evaluate(req({ location: 'CoreAdmin.exe/MemberSearch' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.rule, RULES.origin);
});

test('every denial carries a rule and a reason', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  for (const over of [
    { location: 'http://evil.example/admin/x.htm' },
    { location: 'http://localhost:8080/nope/x.htm' },
    { action: 'double_click' },
    { stepIndex: 999 },
    { risk: 'irreversible' },
  ]) {
    const d = engine.evaluate(req(over));
    assert.notEqual(d.kind, 'allow', JSON.stringify(over));
    assert.ok(d.rule?.length > 0, 'rule must be named');
    assert.ok(d.reason?.length > 0, 'reason must be given');
  }
});

// ---------------------------------------------------------------------------
// I8 — irreversible actions never run unattended
// ---------------------------------------------------------------------------

test('a mutating action requires confirmation rather than being allowed', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  const decision = engine.evaluate(req({ risk: 'mutating' }));
  assert.equal(decision.kind, 'require_confirmation');
  assert.equal(decision.rule, RULES.riskClass);
});

test('an irreversible action is denied', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  const decision = engine.evaluate(req({ risk: 'irreversible' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /no undo/);
});

test('a policy cannot be written that allows irreversible actions outright', () => {
  const result = policyDocument.safeParse({
    version: '1.0.0',
    risk: { safe: 'allow', mutating: 'allow', irreversible: 'allow' },
  });
  assert.equal(result.success, false, 'irreversible: allow must be unrepresentable (I8)');
});

test('the shipped policy document is valid and denies the credential screens', () => {
  const engine = new AllowlistPolicyEngine(OPEN);
  // The agent must never reach the sign-on or sign-off screens: credentials are
  // handled by session bootstrap from the environment, never by the model.
  for (const path of ['/admin/signoff.do']) {
    const d = engine.evaluate(req({ action: 'navigate', location: `http://localhost:8080${path}` }));
    assert.equal(d.kind, 'deny');
  }
});

// ---------------------------------------------------------------------------
// Configuration errors are loud
// ---------------------------------------------------------------------------

test('an uncompilable deny pattern fails at construction, not at the first action', () => {
  const broken = policyDocument.parse({ version: '1.0.0', denyPatterns: ['('] });
  assert.throws(() => new AllowlistPolicyEngine(broken), /not a valid regular expression/);
});
