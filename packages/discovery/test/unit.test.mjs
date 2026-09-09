/**
 * =============================================================================
 * DISCOVERY — UNIT TESTS
 * =============================================================================
 * The parts that are pure: the tool vocabulary, prompt rendering, risk
 * inference, and parameter handling. The loop itself is tested against a real
 * browser in loop.test.mjs.
 *
 *   npm test --workspace @cua/discovery
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { agentAction } from '@cua/contracts';
import { DefaultRedactor } from '@cua/redact';
import {
  TOOLS,
  toolsWithRationale,
  parseCall,
  describeInputs,
  inferRisk,
  policyActionOf,
  renderTree,
  turnPrompt,
  resolve,
  record,
  patternOf,
  LINE_BUDGET,
  AnthropicDecisionModel,
  DEFAULT_TOOL_CHOICE,
  ENV,
  parseToolChoice,
} from '../dist/index.js';

const node = (partial) => ({
  ref: 'f0e1',
  role: 'generic',
  name: null,
  value: null,
  states: [],
  box: null,
  children: [],
  ...partial,
});

// -----------------------------------------------------------------------------

describe('the tool vocabulary', () => {
  /**
   * The drift guard. `agentAction` is the authority on what the model may ask
   * for; TOOLS is the same union in the shape an API wants. A tool added to one
   * and forgotten in the other is exactly the kind of omission that surfaces
   * halfway through a paid discovery run, so it fails here instead.
   */
  test('every action in the contract has a tool, and no tool is invented', () => {
    const fromContract = agentAction.options.map((o) => o.shape.tool.value).sort();
    const fromTools = TOOLS.map((t) => t.name).sort();
    assert.deepEqual(fromTools, fromContract);
  });

  test('every tool asks for a rationale, because the evidence has to say why', () => {
    for (const tool of toolsWithRationale()) {
      assert.ok(tool.input_schema.required.includes('rationale'), `${tool.name} does not require one`);
      assert.ok(tool.input_schema.properties.rationale, `${tool.name} does not declare one`);
    }
  });

  test('tool schemas are closed, so a stray argument is a parse error not a surprise', () => {
    for (const tool of TOOLS) {
      assert.equal(tool.input_schema.additionalProperties, false, tool.name);
    }
  });

  test('a well-formed call parses, and the rationale is lifted out of the arguments', () => {
    const parsed = parseCall('click', { ref: 'f2e6', rationale: 'the search button' });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.call.action, { tool: 'click', ref: 'f2e6' });
    assert.equal(parsed.call.rationale, 'the search button');
  });

  test('a malformed call is rejected with a message the model can act on', () => {
    const parsed = parseCall('click', { reference: 'f2e6' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /ref/);
  });

  test('an invented tool is rejected rather than passed through', () => {
    assert.equal(parseCall('evaluate_javascript', { code: '1' }).ok, false);
  });

  test('a missing rationale does not cost a valid action its turn', () => {
    const parsed = parseCall('press_key', { key: 'Enter' });
    assert.ok(parsed.ok);
    assert.match(parsed.call.rationale, /no rationale/);
  });
});

// -----------------------------------------------------------------------------

describe('what the model is told about parameters', () => {
  test('inputs are described by name and shape, never by value', () => {
    const text = describeInputs([
      { name: 'memberId', description: 'the five digit member number', classification: 'identifier' },
    ]);
    assert.match(text, /\$\.inputs\.memberId/);
    assert.match(text, /five digit/);
    assert.match(text, /identifier/);
  });

  test('a run with no parameters says so rather than showing an empty list', () => {
    assert.match(describeInputs([]), /no parameters/);
  });
});

// -----------------------------------------------------------------------------

describe('parameter substitution', () => {
  const declared = [
    { name: 'memberId', description: 'member number', classification: 'identifier' },
  ];
  const values = new Map([['memberId', '12345']]);

  test('a reference resolves to the value, and reports that it was one', () => {
    const out = resolve('$.inputs.memberId', declared, values);
    assert.ok(out.ok);
    assert.equal(out.text, '12345');
    assert.equal(out.ref, '$.inputs.memberId');
  });

  test('a plain literal passes through untouched', () => {
    const out = resolve('Northgate', declared, values);
    assert.ok(out.ok);
    assert.equal(out.text, 'Northgate');
    assert.equal(out.ref, null);
  });

  /**
   * The alternative — treating an unknown reference as a literal — produces a
   * run that appears to succeed and a capability that searches for the string
   * `$.inputs.memberId` for the rest of its life.
   */
  test('an undeclared reference is an error, not a literal', () => {
    const out = resolve('$.inputs.ssn', declared, values);
    assert.equal(out.ok, false);
    assert.match(out.error, /no parameter named 'ssn'/);
  });

  test('a declared parameter with no value supplied is an error', () => {
    const out = resolve('$.inputs.memberId', declared, new Map());
    assert.equal(out.ok, false);
    assert.match(out.error, /no value was supplied/);
  });
});

describe('what gets written down about a value', () => {
  const redactor = new DefaultRedactor();
  const declared = [
    { name: 'memberId', description: 'member number', classification: 'identifier' },
  ];

  test('a parameter records as a shape, and the shape has nowhere to put the value', () => {
    const value = record('$.inputs.memberId', '12345', declared, redactor);
    assert.equal(value.kind, 'redacted');
    assert.equal(value.classification, 'identifier');
    assert.equal(value.length, 5);
    assert.equal(value.inferredPattern, '^[0-9]{5}$');
    assert.equal(JSON.stringify(value).includes('12345'), false);
  });

  test('a harmless literal is kept, because a capability needs its constants', () => {
    const value = record('Northgate', 'Northgate', declared, redactor);
    assert.deepEqual(value, { kind: 'literal', value: 'Northgate' });
  });

  /**
   * Belt and braces: the model was never given a member id, so it should not be
   * able to type one. If it produces something sensitive anyway — from the
   * screen, from the goal, from nowhere — the classifier still catches it.
   */
  test('a literal that looks sensitive is demoted even though nobody declared it', () => {
    const value = record('4111 1111 1111 1111', '4111 1111 1111 1111', declared, redactor);
    assert.equal(value.kind, 'redacted');
    assert.equal(value.classification, 'financial');
  });

  test('inferred patterns describe the shape without over-fitting the sample', () => {
    assert.equal(patternOf('12345'), '^[0-9]{5}$');
    assert.equal(patternOf('SV0012345'), '^[A-Za-z0-9]{9}$');
    assert.equal(patternOf('Renner, Alice M'), null);
    assert.equal(patternOf(''), null);
  });
});

// -----------------------------------------------------------------------------

describe('risk inference', () => {
  const click = { tool: 'click', ref: 'f0e1' };

  test('reading and filling in are safe; nothing is committed yet', () => {
    assert.equal(inferRisk({ tool: 'type', ref: 'f0e1', text: 'x' }, node({ role: 'textbox' })), 'safe');
    assert.equal(inferRisk({ tool: 'extract', ref: 'f0e1', name: 'b', as: 'money' }, null), 'safe');
    assert.equal(inferRisk({ tool: 'scroll_into_view', ref: 'f0e1' }, null), 'safe');
  });

  test('a navigational control stays safe', () => {
    assert.equal(inferRisk(click, node({ role: 'button', name: 'Search' })), 'safe');
    assert.equal(inferRisk(click, node({ role: 'link', name: 'New Search' })), 'safe');
    assert.equal(inferRisk(click, node({ role: 'link', name: 'Member Search' })), 'safe');
  });

  /**
   * "Open Sub-Account" leads to a form that creates one, so `open` earning
   * `mutating` is the heuristic working rather than misfiring — and the run has
   * to be explicitly told it may take mutating actions before it gets there.
   */
  test('a link that leads somewhere state-changing is not excused by being a link', () => {
    assert.equal(inferRisk(click, node({ role: 'link', name: 'Open Sub-Account' })), 'mutating');
  });

  test('a submit is mutating', () => {
    assert.equal(inferRisk(click, node({ role: 'button', name: 'Submit' })), 'mutating');
    assert.equal(inferRisk(click, node({ role: 'button', name: 'Create Account' })), 'mutating');
  });

  test('verbs with no undo classify irreversible, which policy denies outright', () => {
    assert.equal(inferRisk(click, node({ role: 'button', name: 'Transfer Funds' })), 'irreversible');
    assert.equal(inferRisk(click, node({ role: 'button', name: 'Delete Member' })), 'irreversible');
  });

  /**
   * The direction of the error is the point. An unrecognised button gets the
   * conservative class, so an unfamiliar application is treated as dangerous
   * until something says otherwise.
   */
  test('an unknown button is assumed to change something', () => {
    assert.equal(inferRisk(click, node({ role: 'button', name: 'Xfr' })), 'mutating');
    assert.equal(inferRisk(click, null), 'mutating');
  });

  test('Enter is a submit in everything but name', () => {
    assert.equal(inferRisk({ tool: 'press_key', key: 'Enter' }, null), 'mutating');
    assert.equal(inferRisk({ tool: 'press_key', key: 'Tab' }, null), 'safe');
  });

  test('accepting a dialog answers a question the application asked', () => {
    assert.equal(inferRisk({ tool: 'dismiss_dialog', accept: true }, null), 'mutating');
    assert.equal(inferRisk({ tool: 'dismiss_dialog', accept: false }, null), 'safe');
  });

  test('the run-control verbs touch no surface and so have no policy question', () => {
    assert.equal(policyActionOf({ tool: 'done', summary: 'finished' }), null);
    assert.equal(policyActionOf({ tool: 'assert', description: 'arrived' }), null);
    assert.equal(policyActionOf({ tool: 'click', ref: 'f0e1' }), 'click');
  });
});

// -----------------------------------------------------------------------------

describe('rendering the screen', () => {
  test('a node shows its ref, role, name, value and states', () => {
    const tree = node({ ref: 'f2e6', role: 'textbox', name: 'Member ID', value: '', states: ['required'] });
    const { text } = renderTree(tree);
    assert.match(text, /\[f2e6\] textbox "Member ID" \(required\)/);
  });

  /**
   * A legacy account table blows past any sane budget. What matters is not that
   * we truncate but *what we drop*: cutting at N lines would amputate the
   * bottom of the page, which is exactly where the results table lives.
   */
  test('an oversized tree loses scenery, not actionable elements', () => {
    const filler = Array.from({ length: LINE_BUDGET * 2 }, (_, i) =>
      node({ ref: `f0e${i + 10}`, role: 'generic' }),
    );
    const tree = node({
      ref: 'f0e1',
      role: 'frame',
      children: [
        ...filler,
        node({ ref: 'f0e2', role: 'button', name: 'Search' }),
        node({ ref: 'f0e3', role: 'textbox', name: 'Member ID' }),
      ],
    });

    const { text, truncated } = renderTree(tree);
    assert.equal(truncated, true);
    assert.match(text, /\[f0e2\] button "Search"/);
    assert.match(text, /\[f0e3\] textbox "Member ID"/);
  });

  test('collapsing a wrapper does not amputate what is inside it', () => {
    const tree = node({
      ref: 'f0e1',
      role: 'frame',
      children: [
        node({ ref: 'f0e2', role: 'generic', children: [node({ ref: 'f0e3', role: 'link', name: 'Member Search' })] }),
      ],
    });
    const { text } = renderTree(tree, 1);
    assert.match(text, /link "Member Search"/);
  });
});

describe('the turn prompt', () => {
  const observation = {
    at: new Date().toISOString(),
    surface: 'legacy-web',
    location: 'http://localhost:8080/admin/search.htm',
    title: 'Member Search',
    root: node({ ref: 'f0e1', role: 'frame', name: 'content' }),
    digest: 'abc123',
    screenshotRef: null,
    truncated: false,
  };

  const base = {
    goal: 'read the savings balance',
    inputs: [{ name: 'memberId', description: 'member number', classification: 'identifier' }],
    observation,
    history: [],
    stepIndex: 0,
    maxSteps: 25,
    lastError: null,
  };

  test('the first turn says so instead of showing an empty history', () => {
    assert.match(turnPrompt(base), /this is the first step/);
  });

  test('a refusal is stated plainly, so the next turn is a different action', () => {
    const text = turnPrompt({ ...base, lastError: 'policy denied that action (deny-pattern: signoff)' });
    assert.match(text, /REFUSED/);
    assert.match(text, /deny-pattern/);
  });

  /**
   * The history is part of the prompt, so echoing a substituted value back would
   * undo the withholding exactly one turn after it worked.
   */
  test('history shows the parameter reference, never the value it stood for', () => {
    const text = turnPrompt({
      ...base,
      history: [
        {
          action: { tool: 'type', ref: 'f2e6', text: '$.inputs.memberId' },
          rationale: 'the member id goes here',
          result: 'ok',
        },
      ],
    });
    assert.match(text, /type\(f2e6, \$\.inputs\.memberId\)/);
    assert.equal(text.includes('12345'), false);
  });
});

/**
 * Forced tool use is the design; `auto` exists because not every
 * Anthropic-compatible endpoint will accept a required tool choice. Kimi's
 * enables extended thinking unconditionally and rejects the combination, so
 * without the escape hatch discovery there stops on `model_gave_up` at step 0.
 */
describe('how hard the model is pushed to call a tool', () => {
  test('forced tool use is what you get when nobody says otherwise', () => {
    assert.equal(DEFAULT_TOOL_CHOICE, 'any');
    assert.equal(parseToolChoice(undefined), 'any');
    assert.equal(parseToolChoice(''), 'any');
  });

  test('it can be relaxed, but only to a mode that exists', () => {
    assert.equal(parseToolChoice('auto'), 'auto');
    assert.equal(parseToolChoice('any'), 'any');
    // A typo must not silently become forced tool use against an endpoint that
    // refuses it — that failure would surface as an unexplained model_gave_up.
    assert.throws(() => parseToolChoice('required'), /must be 'any' or 'auto'/);
    assert.throws(() => parseToolChoice('none'), new RegExp(ENV.toolChoice));
  });

  test('fromEnv reads it, and still refuses to run without credentials', () => {
    assert.equal(AnthropicDecisionModel.fromEnv({}), null);
    const model = AnthropicDecisionModel.fromEnv({
      [ENV.apiKey]: 'sk-not-a-real-key',
      [ENV.model]: 'kimi-k2.7-code-highspeed',
      [ENV.toolChoice]: 'auto',
    });
    assert.equal(model.id, 'kimi-k2.7-code-highspeed');
    assert.throws(
      () => AnthropicDecisionModel.fromEnv({ [ENV.apiKey]: 'sk-x', [ENV.toolChoice]: 'nonsense' }),
      /must be 'any' or 'auto'/,
    );
  });
});
