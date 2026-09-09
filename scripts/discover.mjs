#!/usr/bin/env node
/**
 * =============================================================================
 * DISCOVER — the entry point for a real, model-driven run
 * =============================================================================
 * Opens a browser session against a running application, hands it to the
 * discovery loop with a live model, and leaves an evidence directory behind.
 *
 *   node scripts/discover.mjs jobs/read-savings-balance.json
 *   node scripts/discover.mjs jobs/read-savings-balance.json --check   # no model
 *
 * Three things about this file are deliberate.
 *
 * THE JOB IS DATA, THE VALUES ARE NOT. A job file describes a run — goal, entry
 * point, tenant, which parameters exist — and is meant to be committed and
 * reviewed. The digits behind `memberId` reach the process through an
 * environment variable (`valueFrom`) in any real deployment; the fixture job
 * carries an inline `value` because 12345 is a member of nobody. Either way the
 * value is put into a `Map` that is passed to `run()` and never into the
 * `DiscoveryRequest`, which is the object that gets serialised into evidence.
 *
 * CREDENTIALS COME FROM THE ENVIRONMENT AND ARE NEVER ARGUMENTS. Neither the
 * application password nor the model key can be passed on the command line,
 * because argv is visible in `ps` and lands in shell history. `--check` exists
 * so the whole pipeline can be exercised on a machine that has no model key at
 * all.
 *
 * THE EXIT CODE IS THE RESULT. `completed` exits 0; anything else exits 1 with
 * the stop reason on stderr. A discovery run that ends in `dead_end` has not
 * failed as a program — it has produced a real, negative answer — but a CI job
 * asking "did we learn the capability?" needs to be able to tell.
 */
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { discoveryRequest } from '@cua/contracts';
import {
  AnthropicDecisionModel,
  DiscoveryLoop,
  EvidenceSink,
  ScriptedDecisionModel,
  ENV,
} from '@cua/discovery';
import { loadPolicyEngine } from '@cua/policy';
import { openSession } from '@cua/surface-web';

const USAGE = `usage: node scripts/discover.mjs <job.json> [options]

  --policy <path>     policy document            (default: policy.json)
  --evidence <path>   evidence root directory    (default: evidence)
  --max-steps <n>     override the job's budget
  --headed            show the browser
  --check             render the first prompt and stop, without calling a model

environment
  ${ENV.apiKey}      model credentials; required unless --check
  ${ENV.baseUrl}     optional model endpoint override
  ${ENV.model}         optional model id
  CUA_APP_USERNAME     application operator id    (default: teller01)
  CUA_APP_PASSWORD     application password       (default: letmein)
  CUA_INPUT_<NAME>     value for an input declared with "valueFrom"
`;

const main = async () => {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help || argv.job === null) {
    process.stdout.write(USAGE);
    process.exit(argv.job === null && !argv.help ? 2 : 0);
  }

  const job = JSON.parse(await readFile(resolvePath(argv.job), 'utf8'));
  const { inputs, values } = splitValues(job.inputs ?? []);

  const model = argv.check ? preflightModel() : AnthropicDecisionModel.fromEnv();
  if (model === null) {
    fail(
      `no model credentials: set ${ENV.apiKey}.\n` +
        `The ambient ANTHROPIC_* variables are deliberately not inherited — see ` +
        `packages/discovery/src/model.ts. Use --check to exercise everything but the model.`,
    );
  }

  // Parse before opening a browser. A malformed job should cost nothing.
  const request = discoveryRequest.parse({
    goal: job.goal,
    entryUrl: job.entryUrl,
    surface: job.surface,
    app: job.app,
    tenant: job.tenant ?? null,
    proposedId: job.proposedId ?? null,
    inputs,
    ...(argv.maxSteps === null ? pick(job, 'maxSteps') : { maxSteps: argv.maxSteps }),
    ...pick(job, 'deadlineMs'),
    ...pick(job, 'allowMutating'),
    model: model.id,
  });

  const entry = new URL(request.entryUrl);
  const policy = await loadPolicyEngine(resolvePath(argv.policy));
  const sink = new EvidenceSink();

  const session = await openSession({
    baseUrl: entry.origin,
    entryPoint: entry.pathname + entry.search,
    username: process.env.CUA_APP_USERNAME || 'teller01',
    password: process.env.CUA_APP_PASSWORD || 'letmein',
    headless: !argv.headed,
    onScreenshot: sink.screenshot,
    onSnapshot: sink.snapshot,
  });

  process.stderr.write(
    `discovering: ${request.goal}\n` +
      `  entry   ${request.entryUrl}\n` +
      `  model   ${request.model}\n` +
      `  policy  ${argv.policy}\n` +
      `  budget  ${request.maxSteps} steps\n\n`,
  );

  let result;
  try {
    const loop = new DiscoveryLoop({
      driver: session.driver,
      model,
      policy,
      sink,
      evidenceRoot: argv.evidence,
    });
    result = await loop.run(request, values);
  } finally {
    // Always close: a run that throws must not leave a browser holding a
    // signed-in session open.
    await session.close();
  }

  report(result);
  process.exit(result.kind === 'completed' ? 0 : 1);
};

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/**
 * Split declared inputs from their values.
 *
 * The returned `inputs` are exactly what `discoveryInput` allows — name,
 * description, classification — so a value cannot reach the request object even
 * by accident. `strict()` on the schema would reject it, but doing the split
 * here means the error is a clear one rather than a zod complaint from four
 * frames away.
 */
function splitValues(declared) {
  const inputs = [];
  const values = new Map();

  for (const input of declared) {
    const { name, description, classification, value, valueFrom } = input;
    inputs.push({ name, description, classification });

    if (valueFrom !== undefined) {
      const fromEnv = process.env[valueFrom];
      if (fromEnv === undefined) {
        fail(`input '${name}' reads from ${valueFrom}, which is not set`);
      }
      values.set(name, fromEnv);
      continue;
    }
    if (value === undefined) {
      fail(`input '${name}' declares neither 'value' nor 'valueFrom'`);
    }
    values.set(name, String(value));
  }

  return { inputs, values };
}

/**
 * A model that renders one turn and asks for a human.
 *
 * `--check` exercises the browser, the sign-in, the policy load, the
 * observation, the redactor and the evidence writer — everything except the
 * network call that costs money — and prints the prompt the real model would
 * have received. `stuck` is the honest way to end such a run: it is not a
 * completed discovery and the evidence should not claim to be one.
 */
function preflightModel() {
  return new ScriptedDecisionModel([
    (prompt) => {
      process.stdout.write(prompt + '\n');
      return {
        rationale: 'preflight only; no model was consulted',
        action: {
          tool: 'stuck',
          reason: 'agent_requested_help',
          explanation: 'run started with --check, so no decision was made',
        },
      };
    },
  ]);
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------

function report(result) {
  const { stats } = result;
  const headline =
    result.kind === 'completed'
      ? `completed: ${result.summary}`
      : result.kind === 'escalated'
        ? `escalated (${result.reason}): intervention ${result.interventionId}`
        : `stopped (${result.reason}): ${result.detail}`;

  process.stderr.write(
    `\n${headline}\n` +
      `  evidence  ${result.evidence.path}\n` +
      `  steps     ${stats.stepsTaken}  model calls ${stats.modelCalls}  ` +
      `denials ${stats.policyDenials}\n` +
      `  tokens    ${stats.tokensIn} in / ${stats.tokensOut} out  ` +
      `in ${Math.round(stats.durationMs / 1000)}s\n`,
  );
}

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

function parseArgs(args) {
  const out = {
    job: null,
    policy: 'policy.json',
    evidence: 'evidence',
    maxSteps: null,
    headed: false,
    check: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--policy':
        out.policy = need(args, ++i, '--policy');
        break;
      case '--evidence':
        out.evidence = need(args, ++i, '--evidence');
        break;
      case '--max-steps':
        out.maxSteps = Number(need(args, ++i, '--max-steps'));
        break;
      case '--headed':
        out.headed = true;
        break;
      case '--check':
        out.check = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`);
        if (out.job !== null) fail('only one job file may be given');
        out.job = arg;
    }
  }
  return out;
}

function need(args, at, flag) {
  const value = args[at];
  if (value === undefined) fail(`${flag} needs a value`);
  return value;
}

/** Copy a key only when the job actually sets it, so schema defaults apply. */
function pick(job, key) {
  return job[key] === undefined ? {} : { [key]: job[key] };
}

function fail(message) {
  process.stderr.write(`discover: ${message}\n`);
  process.exit(2);
}

await main();
