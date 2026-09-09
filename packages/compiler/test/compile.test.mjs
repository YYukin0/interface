/**
 * =============================================================================
 * THE COMPILER — TESTS
 * =============================================================================
 * Synthetic recordings, written to a temp directory and compiled.
 *
 * No browser and no model here, and that is the point of the compiler being a
 * separate program: its entire input is a directory of JSON, so every inference
 * it makes — which literal became a parameter, which landmark became a
 * checkpoint, which step got dropped — is testable at the speed of a file write.
 * The integration tests in `@cua/discovery` cover the half that needs a real
 * DOM; nothing here needs one.
 *
 *   npm test --workspace @cua/compiler
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capability } from '@cua/contracts';

import { RecordingCompiler } from '../dist/index.js';

let root;
let runs = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cua-compile-'));
  runs.push(root);
});

after(async () => {
  for (const dir of runs) await rm(dir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const MEMBER_INPUT = {
  name: 'memberId',
  description: 'the five digit member number to look up',
  classification: 'identifier',
};

const REQUEST = {
  goal: "Read the current balance of a member's savings account.",
  entryUrl: 'http://localhost:8080/admin/index.htm',
  surface: 'legacy-web',
  app: 'northgate-core-admin',
  tenant: 'tenant-a',
  proposedId: 'member.read_savings_balance',
  inputs: [MEMBER_INPUT],
  maxSteps: 14,
  deadlineMs: 300_000,
  model: 'k3',
  allowMutating: false,
};

/** A locator bundle with enough candidates not to trip the weak-bundle warning. */
function bundle(role, name, extra = {}) {
  return {
    frame: ['content'],
    containerHint: null,
    positionHint: `${role} labelled "${name}"`,
    expectedRole: role,
    expectedName: name,
    candidates: [
      { strategy: 'role-name', value: `${role}:${name}`, confidence: 0.85, note: null },
      { strategy: 'css', value: `#${name.replace(/\W/g, '')}`, confidence: 0.45, note: null },
    ],
    ...extra,
  };
}

let nextIndex = 0;

function step(overrides) {
  const index = overrides.index ?? nextIndex++;
  return {
    index,
    at: new Date(Date.UTC(2026, 8, 9, 0, 0, index)).toISOString(),
    rationale: 'because the fixture says so',
    action: { tool: 'click' },
    target: null,
    value: null,
    risk: 'safe',
    locationBefore: 'http://localhost:8080/admin/index.htm',
    locationAfter: 'http://localhost:8080/admin/index.htm',
    digestBefore: 'aaaa',
    digestAfter: 'bbbb',
    ok: true,
    extracted: null,
    appeared: [],
    ...overrides,
  };
}

/** Write a run directory and compile it. */
async function compile(steps, { request = REQUEST, manifest = {}, options = {} } = {}) {
  nextIndex = 0;
  const dir = join(root, 'discovery-fixture');
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      runId: 'discovery-fixture',
      kind: 'discovery',
      startedAt: '2026-09-09T00:00:00.000Z',
      endedAt: '2026-09-09T00:00:30.000Z',
      capabilityId: request?.proposedId ?? null,
      goal: request?.goal ?? null,
      target: request?.entryUrl ?? 'http://localhost:8080/admin/index.htm',
      model: request?.model ?? 'k3',
      schemaVersion: '1.0.0',
      gitSha: null,
      ...manifest,
    }),
    'utf8',
  );
  if (request !== null) {
    await writeFile(join(dir, 'request.json'), JSON.stringify(request), 'utf8');
  }
  await writeFile(
    join(dir, 'recording.jsonl'),
    steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf8',
  );

  const compiler = new RecordingCompiler(options);
  return compiler.compile({ runId: 'discovery-fixture', path: dir });
}

/** The flow the real run produces, as a fixture. */
function happyPath() {
  nextIndex = 0;
  return [
    step({
      action: { tool: 'click' },
      target: bundle('link', 'Member Search', { frame: ['nav'] }),
      rationale: 'Member Search is where a member lookup starts. It opens the form.',
      appeared: ['text:Search Criteria', 'textbox:Member ID', 'button:Search'],
    }),
    step({
      action: { tool: 'type', clearFirst: true },
      target: bundle('textbox', 'Member ID'),
      value: {
        kind: 'redacted',
        classification: 'identifier',
        inferredPattern: '^[0-9]{5}$',
        length: 5,
        ref: '$.inputs.memberId',
      },
    }),
    step({
      action: { tool: 'click' },
      target: bundle('button', 'Search'),
      appeared: ['text:Member Information', 'text:Account Summary', 'link:New Search'],
    }),
    step({
      action: { tool: 'extract', name: 'savingsBalance', as: 'money' },
      target: bundle('cell', 'Savings'),
      extracted: {
        kind: 'redacted',
        classification: 'financial',
        inferredPattern: null,
        length: 9,
      },
    }),
    step({ action: { tool: 'assert', description: 'the balance is on screen' }, appeared: [] }),
  ];
}

const ok = (result) => {
  assert.equal(result.kind, 'compiled', JSON.stringify(result));
  return result;
};

const codes = (result) => result.warnings.map((w) => w.code);

// -----------------------------------------------------------------------------

describe('compiling a recording', () => {
  test('the happy path becomes a capability that parses', async () => {
    const result = ok(await compile(happyPath()));
    // Parsing here is not belt and braces: `capability` carries every
    // cross-field rule the artifact has, so this asserts the compiler cannot
    // emit something replay would choke on.
    capability.parse(result.capability);

    const c = result.capability;
    assert.deepEqual(
      c.steps.map((s) => s.id),
      ['s1', 's2', 's3', 's4'],
      'the assert is a checkpoint, not a step',
    );
    assert.equal(c.approval.state, 'draft', 'nothing is approved by a machine');
    assert.equal(c.provenance.discoveredBy, 'k3');
    assert.match(c.provenance.traceRef, /trace\.jsonl$/);
  });

  test('the artifact points at the trace and inlines none of it (I5)', async () => {
    const { capability: c } = ok(await compile(happyPath()));
    const json = JSON.stringify(c);

    // The rationale legitimately becomes `intent` — that is the compiler
    // choosing a field, which is the whole distinction I5 draws. What must not
    // appear is anything the recorder produced for its own use: observation
    // trees, per-observation refs, digests, screenshot paths.
    assert.equal(/"ref":"f\d+e/.test(json), false, 'an ephemeral ref reached the artifact');
    assert.equal(json.includes('digestBefore'), false);
    assert.equal(json.includes('screenshots/'), false);
    assert.equal(json.includes('appeared'), false);
    assert.match(c.provenance.traceRef, /discovery-fixture/);
  });

  test('compiling twice is byte-identical', async () => {
    // The compiler is the deterministic half of a non-deterministic pipeline;
    // if it were not, recompiling an old recording could not be used to tell
    // whether a change to a heuristic improved anything.
    const a = ok(await compile(happyPath()));
    const b = ok(await compile(happyPath()));
    assert.equal(JSON.stringify(a.capability), JSON.stringify(b.capability));
  });
});

describe('the tool contract', () => {
  test('a declared parameter is referenced, never inlined', async () => {
    const { capability: c } = ok(await compile(happyPath()));
    const typed = c.steps.find((s) => s.action.type === 'type');

    assert.deepEqual(typed.action.value, { from: 'input', ref: '$.inputs.memberId' });
    assert.equal(c.inputs.properties.memberId.pattern, '^[0-9]{5}$');
    assert.equal(c.inputs.properties.memberId.description, MEMBER_INPUT.description);
    assert.deepEqual(c.inputs.required, ['memberId']);
    assert.equal(c.sensitivity.memberId, 'identifier');
  });

  test('an extract declares its output, classified by what was actually read', async () => {
    const { capability: c } = ok(await compile(happyPath()));

    assert.equal(c.outputs.properties.savingsBalance.format, 'money');
    assert.equal(c.sensitivity.savingsBalance, 'financial');
    assert.deepEqual(c.successCondition.requiredOutputs, ['savingsBalance']);
  });

  test('a sensitive literal the model invented is promoted, and flagged', async () => {
    const steps = happyPath();
    steps[1].value = {
      kind: 'redacted',
      classification: 'identifier',
      inferredPattern: '^[0-9]{5}$',
      length: 5,
      ref: null,
    };
    const result = ok(await compile(steps, { request: { ...REQUEST, inputs: [] } }));

    const typed = result.capability.steps.find((s) => s.action.type === 'type');
    assert.deepEqual(typed.action.value, { from: 'input', ref: '$.inputs.value1' });
    assert.ok(codes(result).includes('sensitive_literal_promoted'));
    // Deliberately unhelpful name: the reviewer renames it, the compiler does
    // not pretend to know what it was.
    assert.match(result.capability.inputs.properties.value1.description, /Rename/);
  });

  test('a literal classified none is frozen into the artifact as itself', async () => {
    const steps = happyPath();
    steps[1].value = { kind: 'literal', value: 'Savings' };
    const { capability: c } = ok(await compile(steps, { request: { ...REQUEST, inputs: [] } }));

    const typed = c.steps.find((s) => s.action.type === 'type');
    assert.deepEqual(typed.action.value, { from: 'literal', value: 'Savings' });
  });

  test('a declared parameter nothing used is dropped from the contract', async () => {
    const request = {
      ...REQUEST,
      inputs: [MEMBER_INPUT, { name: 'branch', description: 'branch code', classification: 'none' }],
    };
    const result = ok(await compile(happyPath(), { request }));

    assert.equal('branch' in result.capability.inputs.properties, false);
    assert.ok(codes(result).includes('declared_input_unused'));
  });

  test('the entry point is a path, so the artifact is not bound to one host', async () => {
    const { capability: c } = ok(await compile(happyPath()));
    assert.equal(c.surface.entryPoint, '/admin/index.htm');
    assert.equal(JSON.stringify(c).includes('localhost:8080'), false);
  });
});

describe('checkpoint inference', () => {
  test('the checkpoint asserts what the NEXT step needs', async () => {
    const { capability: c } = ok(await compile(happyPath()));

    // `text:Search Criteria` appeared first, but s2 types into `textbox:Member
    // ID` — asserting the control the flow depends on catches the failure here
    // rather than one step later as an unresolvable locator.
    assert.deepEqual(c.steps[0].checkpoint, {
      id: 'chk.member_id',
      assert: 'role-name-present',
      target: null,
      value: 'textbox:Member ID',
      timeoutMs: 10_000,
    });
  });

  test('with nothing for the next step to need, a text landmark stands in', async () => {
    const { capability: c } = ok(await compile(happyPath()));

    // s4 extracts from an unnamed cell, so nothing in `appeared` matches it.
    assert.equal(c.steps[2].checkpoint.assert, 'text-present');
    assert.equal(c.steps[2].checkpoint.value, 'Member Information');
  });

  test('record data never becomes a checkpoint', async () => {
    const steps = happyPath();
    steps[2].appeared = ['cell:Renner, Alice M', 'cell:12345', 'row:1'];
    const result = ok(await compile(steps));

    // A checkpoint asserting a particular member passes for one caller and
    // fails for every other one — a correctness bug and a privacy bug at once.
    assert.equal(result.capability.steps[2].checkpoint, null);
    assert.ok(codes(result).includes('no_checkpoint_inferred'));
  });

  test('a step that gains nothing is not warned about', async () => {
    // The model's trailing `assert` confirms the task, not an arrival. Warning
    // about it would name a problem no reviewer can act on.
    const result = ok(await compile(happyPath()));
    const perStep = result.warnings.filter((w) => w.code === 'no_checkpoint_inferred');
    assert.deepEqual(perStep, []);
  });

  test('typing gets no checkpoint of its own', async () => {
    const { capability: c } = ok(await compile(happyPath()));
    assert.equal(c.steps[1].checkpoint, null);
  });

  test('checkpoint ids are unique even when two screens share a landmark', async () => {
    const steps = happyPath();
    steps[2].appeared = ['text:Search Criteria', 'link:New Search'];
    const { capability: c } = ok(await compile(steps));

    const ids = c.steps.flatMap((s) => (s.checkpoint ? [s.checkpoint.id] : []));
    assert.equal(new Set(ids).size, ids.length, ids.join(', '));
  });
});

describe('what the compiler refuses and what it flags', () => {
  test('a failed step is dropped from the flow, and reported', async () => {
    const steps = happyPath();
    steps.splice(3, 0, step({ index: 99, action: { tool: 'click' }, target: bundle('link', 'Reports'), ok: false }));
    const result = ok(await compile(steps));

    assert.equal(result.capability.steps.length, 4);
    assert.ok(codes(result).includes('noise_filtered'));
  });

  test('a mutating step is flagged, because its risk was inferred not observed', async () => {
    const steps = happyPath();
    steps[2].risk = 'mutating';
    const result = ok(await compile(steps));

    const flagged = result.warnings.find((w) => w.code === 'risk_inferred');
    assert.equal(flagged.stepId, 's3');
  });

  test('a step with one locator candidate is flagged as having no fallback', async () => {
    const steps = happyPath();
    steps[0].target.candidates = steps[0].target.candidates.slice(0, 1);
    const result = ok(await compile(steps));

    const flagged = result.warnings.find((w) => w.code === 'weak_locator_bundle');
    assert.equal(flagged.stepId, 's1');
  });

  test('the happy path always warns that no business outcomes were seen', async () => {
    // I2: a run that never met a missing member has nothing to say about one.
    // Inventing the outcome would be worse than declaring none.
    const result = ok(await compile(happyPath()));
    assert.deepEqual(result.capability.businessOutcomes, []);
    assert.ok(codes(result).includes('no_business_outcomes_declared'));
  });

  test('a recording with no request cannot be compiled', async () => {
    const result = await compile(happyPath(), { request: null });
    assert.equal(result.kind, 'rejected');
    assert.match(result.reasons[0], /request\.json/);
  });

  test('a replay run is not a discovery run', async () => {
    const result = await compile(happyPath(), { manifest: { kind: 'replay', model: null } });
    assert.equal(result.kind, 'rejected');
    assert.match(result.reasons[0], /not a discovery run/);
  });

  test('a recording where nothing worked compiles to nothing', async () => {
    const result = await compile(happyPath().map((s) => ({ ...s, ok: false })));
    assert.equal(result.kind, 'rejected');
    assert.match(result.reasons[0], /no successful actions/);
  });

  test('a capability with no way to verify success is refused', async () => {
    // No checkpoint anywhere and no extract: the artifact would replay and have
    // no basis on which to claim it worked. The schema refuses it and the
    // compiler surfaces the schema's own words.
    const result = await compile([
      step({ action: { tool: 'click' }, target: bundle('link', 'Reports'), appeared: [] }),
    ]);
    assert.equal(result.kind, 'rejected');
    assert.ok(result.reasons.some((r) => /successCondition/.test(r)), result.reasons.join('; '));
  });

  test('a sensitive literal that reached the recording fails the compile', async () => {
    // This cannot happen while the recorder classifies correctly — which is why
    // a hit here is reported as a compiler bug rather than masked.
    const steps = happyPath();
    steps[1].value = { kind: 'literal', value: '$4,231.08' };
    const result = await compile(steps, { request: { ...REQUEST, inputs: [] } });

    assert.equal(result.kind, 'rejected');
    assert.ok(
      result.reasons.some((r) => /sensitive|literal/i.test(r)),
      result.reasons.join('; '),
    );
  });
});

describe('recovery rules', () => {
  test('a safe navigational step may wait and may dismiss a dialog', async () => {
    const { capability: c } = ok(await compile(happyPath()));
    assert.deepEqual(
      c.steps[0].recover.map((r) => `${r.on}:${r.do}`),
      ['transient_load:wait_retry', 'unexpected_dialog:dismiss_dialog'],
    );
  });

  test('a mutating step is never given a retry', async () => {
    // Retrying a submit is how one transfer becomes two.
    const steps = happyPath();
    steps[2].risk = 'mutating';
    const { capability: c } = ok(await compile(steps));

    assert.equal(
      c.steps[2].recover.some((r) => r.do === 'wait_retry'),
      false,
    );
  });

  test('typing and extracting carry no recovery at all', async () => {
    const { capability: c } = ok(await compile(happyPath()));
    assert.deepEqual(c.steps[1].recover, []);
    assert.deepEqual(c.steps[3].recover, []);
  });
});
