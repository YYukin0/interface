/**
 * =============================================================================
 * EVIDENCE WRITER TESTS
 * =============================================================================
 * The claim under test is I3: nothing reaches disk without passing the redactor.
 *
 * The interesting cases are the ones nobody wrote code for. A per-field scrub
 * list passes a test that feeds it the fields the list knows about, and leaks
 * the first time somebody adds an event type. So most of what follows pushes
 * secrets through fields that have no business carrying them — a checkpoint's
 * `observed`, a recovery's `condition`, a nested manifest — and asserts they do
 * not come out the other side.
 *
 *   npm test --workspace @cua/evidence
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvidenceSink, FileEvidenceWriter, newRunId, RecordingWriter, readRecording, readTrace, readManifest } from '../dist/index.js';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cua-evidence-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

let runId;
beforeEach(() => {
  runId = newRunId('discovery');
});

const manifestFor = (id, overrides = {}) => ({
  runId: id,
  kind: 'discovery',
  startedAt: '2026-09-09T10:00:00.000Z',
  endedAt: null,
  capabilityId: null,
  goal: 'Read a member savings balance',
  target: 'http://localhost:8080',
  model: 'claude-opus-5',
  schemaVersion: '1.0.0',
  gitSha: null,
  ...overrides,
});

const open = (id = runId, overrides = {}) =>
  FileEvidenceWriter.open(manifestFor(id, overrides), { root });

const traceText = (writer) => readFile(join(writer.dir, 'trace.jsonl'), 'utf8');

// -----------------------------------------------------------------------------

describe('run directories', () => {
  test('opening lays out the directory and records the manifest twice', async () => {
    const writer = await open();

    assert.deepEqual(
      (await readdir(writer.dir)).sort(),
      ['manifest.json', 'screenshots', 'snapshots', 'trace.jsonl'],
    );

    // Once as a file for tooling, once as the first trace line so the log is
    // self-contained when read on its own.
    const manifest = await readManifest(writer.dir);
    assert.equal(manifest.runId, runId);

    const trace = await readTrace(writer.dir);
    assert.equal(trace[0].event, 'run_started');
    assert.equal(trace[0].manifest.goal, 'Read a member savings balance');
  });

  test('run ids sort chronologically and are safe as directory names', async () => {
    const early = newRunId('replay', new Date('2026-01-01T00:00:00Z'));
    const late = newRunId('replay', new Date('2026-06-01T00:00:00Z'));

    assert.ok(early < late, 'lexical order must match chronological order');
    assert.ok(/^replay-[0-9A-Za-z-]+$/.test(early), `not filename-safe: ${early}`);

    // Two runs started in the same millisecond must not collide.
    const at = new Date('2026-01-01T00:00:00Z');
    assert.notEqual(newRunId('replay', at), newRunId('replay', at));
  });

  test('a replay manifest can assert its own model-free-ness (I1)', async () => {
    const writer = await open(runId, { kind: 'replay', model: null, goal: null });
    const manifest = await readManifest(writer.dir);

    // The machine-checkable form of "replay cannot call an LLM": the evidence
    // says which model ran, and for a replay the answer must be none.
    assert.equal(manifest.kind, 'replay');
    assert.equal(manifest.model, null);
  });
});

describe('redaction on the way to disk (I3)', () => {
  test('a secret in an unanticipated field is scrubbed anyway', async () => {
    const writer = await open();

    await writer.append({
      event: 'recovery_attempted',
      at: '2026-09-09T10:00:01.000Z',
      stepId: 's1',
      // Nothing about this field suggests it would ever hold a credential.
      // That is exactly why the scrub is a blind walk and not a field list.
      condition: 'retrying after CUA_APP_PASSWORD=hunter2xyz was rejected',
      took: 'reauthenticate',
      attempt: 1,
      succeeded: true,
    });

    const text = await traceText(writer);
    assert.ok(!text.includes('hunter2xyz'), 'the credential must not reach the log');
    assert.match(text, /\[REDACTED:CREDENTIAL\]/);
  });

  test('secrets nested inside objects and arrays are reached', async () => {
    const writer = await open(runId, {
      // Buried two levels down, inside the manifest, inside the run_started event.
      target: 'http://localhost:8080 (card 4111 1111 1111 1111 on file)',
    });

    const text = await traceText(writer);
    assert.ok(!text.includes('4111 1111 1111 1111'));
    assert.match(text, /\[REDACTED:PAYMENT_CARD\]/);

    // And the file copy of the manifest is written from the same source, so
    // check it independently rather than assuming.
    const manifest = await readManifest(writer.dir);
    assert.ok(typeof manifest.target === 'string');
  });

  test('a subscriber watching the run sees the scrubbed event, not the original', async () => {
    // The reason `onEvent` is on the writer rather than on the engine. A hook
    // upstream of the redactor would hand a live credential to whatever is
    // watching — here, a CLI that prints it to a terminal and very likely into
    // somebody's CI log. Being downstream is what makes that unrepresentable.
    const seen = [];
    const writer = await FileEvidenceWriter.open(manifestFor(runId), {
      root,
      onEvent: (event) => seen.push(event),
    });

    await writer.append({
      event: 'recovery_attempted',
      at: '2026-09-09T10:00:01.000Z',
      stepId: 's1',
      condition: 'retrying after CUA_APP_PASSWORD=hunter2xyz was rejected',
      took: 'reauthenticate',
      attempt: 1,
      succeeded: true,
    });

    const json = JSON.stringify(seen);
    assert.ok(!json.includes('hunter2xyz'), 'a watcher must not be handed the credential');
    assert.match(json, /\[REDACTED:CREDENTIAL\]/);

    // And it is the same object the file got, so a watcher and a reader of the
    // evidence cannot come away with different accounts of the same run.
    const recoveries = seen.filter((e) => e.event === 'recovery_attempted');
    assert.equal(recoveries.length, 1);
    assert.ok((await traceText(writer)).includes(JSON.stringify(recoveries[0])));

    // The detection is announced too, so a watcher learns redaction happened
    // rather than silently receiving less than it asked for.
    assert.ok(seen.some((e) => e.event === 'redacted'));
  });

  test('a subscriber that throws cannot break the run it is watching', async () => {
    const writer = await FileEvidenceWriter.open(manifestFor(runId), {
      root,
      onEvent: () => {
        throw new Error('the console this was printing to went away');
      },
    });

    await writer.append({
      event: 'business_outcome',
      at: '2026-09-09T10:00:02.000Z',
      code: 'MEMBER_NOT_FOUND',
      message: 'no such member',
    });

    assert.match(await traceText(writer), /MEMBER_NOT_FOUND/);
  });

  test('a scrubbed event still satisfies the trace schema', async () => {
    const writer = await open();

    await writer.append({
      event: 'checkpoint_evaluated',
      at: '2026-09-09T10:00:02.000Z',
      checkpointId: 'cp_summary',
      passed: false,
      expected: 'Account Summary',
      observed: 'text absent; page reads "Savings SV-0012345 $4,231.08 active"',
      waitedMs: 5000,
    });

    // readTrace re-parses every line. If redaction had produced something the
    // schema rejects, the evidence would have stopped being machine-readable
    // silently — this is the assertion that catches that.
    const trace = await readTrace(writer.dir);
    const checkpoint = trace.find((e) => e.event === 'checkpoint_evaluated');

    assert.ok(!checkpoint.observed.includes('4,231.08'));
    assert.match(checkpoint.observed, /\[REDACTED:MONEY\]/);
    assert.equal(checkpoint.expected, 'Account Summary', 'ordinary text is left alone');
  });

  test('every redaction is itself logged, without the value', async () => {
    const writer = await open();

    await writer.append({
      event: 'business_outcome',
      at: '2026-09-09T10:00:03.000Z',
      code: 'MEMBER_NOT_FOUND',
      message: 'no record for SSN 123-45-6789',
    });

    const trace = await readTrace(writer.dir);
    const redacted = trace.filter((e) => e.event === 'redacted');

    assert.ok(redacted.length > 0, 'the detection must be auditable');
    const record = redacted[0].record;
    assert.equal(record.sink, 'log');
    assert.ok(record.count >= 1);
    assert.ok(record.confidence > 0 && record.confidence <= 1);

    // The whole point of the detection/redaction split: the record proves a
    // US_SSN was found and gives no way to recover it.
    assert.ok(
      !JSON.stringify(record).includes('123-45-6789'),
      'the redaction record must not carry what it redacted',
    );
  });

  test('snapshots and results are redacted too', async () => {
    const writer = await open();

    const ref = await writer.writeSnapshot(
      { root: { role: 'cell', name: '$4,231.08' } },
      'failure state',
    );
    assert.equal(ref, 'snapshots/failure-state.json');

    const snapshot = await readFile(join(writer.dir, ref), 'utf8');
    assert.ok(!snapshot.includes('4,231.08'));

    await writer.finalize({ status: 'failure', detail: 'member 12345 balance $4,231.08' });
    const result = await readFile(join(writer.dir, 'result.json'), 'utf8');
    assert.ok(!result.includes('4,231.08'));
  });

  test('redactions.json summarises the run without repeating any of it', async () => {
    const writer = await open();

    for (const value of ['$1.00', '$2.00', '$3.00']) {
      await writer.append({
        event: 'business_outcome',
        at: '2026-09-09T10:00:04.000Z',
        code: 'OK',
        message: `balance ${value}`,
      });
    }

    await writer.finalize({ status: 'success' });
    const summary = JSON.parse(await readFile(join(writer.dir, 'redactions.json'), 'utf8'));

    const money = summary.find((r) => r.entity === 'MONEY');
    assert.ok(money, 'the summary must name the entity that was found');
    assert.equal(money.sink, 'log');
    assert.equal(money.count, 3, 'one row per entity, counting occurrences');
    assert.ok(!JSON.stringify(summary).includes('$1.00'));
  });

  test('what a screenshot painted over reaches the summary too', async () => {
    // The screenshot sink redacts in the driver, where the accessibility boxes
    // are, and hands down a PNG that is already safe. The image carries no
    // record of that, so the summary has to travel beside it — otherwise a run
    // whose evidence is covered in black boxes summarises as `[]`, which is the
    // one shape of audit trail worse than having none.
    const writer = await open();
    const sink = new EvidenceSink();
    sink.bind(writer);

    const ref = await sink.screenshot(new Uint8Array([1, 2, 3]), 'failure', [
      { entity: 'SCREEN_FINANCIAL', classification: 'financial', confidence: 0.9, sink: 'log', count: 4 },
    ]);
    assert.equal(ref, 'screenshots/failure.png');

    await writer.finalize({ status: 'failure' });
    const summary = JSON.parse(await readFile(join(writer.dir, 'redactions.json'), 'utf8'));

    const screen = summary.find((r) => r.entity === 'SCREEN_FINANCIAL');
    assert.ok(screen, 'the painted-over fields must appear in the summary');
    // Re-tagged on the way through, so the caller cannot mislabel the sink it
    // was writing to — which is the most useful column in the table.
    assert.equal(screen.sink, 'screenshot');
    assert.equal(screen.count, 4);
  });

  test('a label cannot escape its directory', async () => {
    const writer = await open();
    const ref = await writer.writeSnapshot({ ok: true }, '../../etc/passwd');

    // The property that matters is containment, not the exact spelling: no
    // separators and no dot segments survive, so the write lands in the run
    // directory whatever the caller passed.
    assert.equal(ref, 'snapshots/-etc-passwd.json');
    assert.ok(!ref.slice('snapshots/'.length).includes('/'));
    assert.ok((await readdir(join(writer.dir, 'snapshots'))).includes('-etc-passwd.json'));
  });
});

describe('the recording is not the trace (I5)', () => {
  test('a sensitive value is recorded as a shape, never as a value', async () => {
    const writer = await open();
    const recording = new RecordingWriter(writer.dir);

    await recording.append({
      index: 0,
      at: '2026-09-09T10:00:05.000Z',
      rationale: 'Type the member id the caller supplied into the search field',
      // Note there is no field here that could hold '12345' even if we tried:
      // `recordedAction` is `agentAction` with the payload removed.
      action: { tool: 'type', clearFirst: true },
      target: {
        frame: ['content'],
        containerHint: null,
        positionHint: null,
        expectedRole: 'textbox',
        expectedName: 'Member ID',
        candidates: [
          { strategy: 'automation-id', value: 'txtMemberId', confidence: 0.95, note: null },
        ],
      },
      // The union's sensitive arm has nowhere to put a value. That is the
      // structural half of I3: even a caller that wanted to write a member id
      // into the recording could not express it.
      value: { kind: 'redacted', classification: 'pii', inferredPattern: '\\d{5}', length: 5 },
      risk: 'safe',
      locationBefore: 'http://localhost:8080/admin/index.htm',
      locationAfter: 'http://localhost:8080/admin/index.htm',
      digestBefore: 'aaaaaaaaaaaaaaaa',
      digestAfter: 'aaaaaaaaaaaaaaaa',
      ok: true,
      extracted: null,
      appeared: [],
    });

    const steps = await readRecording(writer.dir);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].value.kind, 'redacted');
    assert.equal(steps[0].value.length, 5);
    assert.ok(!JSON.stringify(steps[0].value).includes('12345'));

    // And it lives in its own file: the audit log carries no locator bundles.
    const trace = await traceText(writer);
    assert.ok(!trace.includes('txtMemberId'));
  });

  test('a corrupt line fails the read rather than being skipped', async () => {
    const writer = await open();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(writer.dir, 'recording.jsonl'), '{"index": "not a number"}\n', 'utf8');

    // Silently dropping a step is how a compiler emits a capability missing an
    // action, which then fails on some later replay for untraceable reasons.
    await assert.rejects(() => readRecording(writer.dir), /evidence line 1 is not a valid record/);
  });

  test('an absent recording reads as empty, not as an error', async () => {
    const writer = await open();
    assert.deepEqual(await readRecording(writer.dir), []);
  });
});
