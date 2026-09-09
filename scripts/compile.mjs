#!/usr/bin/env node
/**
 * =============================================================================
 * COMPILE — one recorded run into one reviewable capability
 * =============================================================================
 *
 *   node scripts/compile.mjs evidence/discovery-<id>
 *   node scripts/compile.mjs evidence/discovery-<id> --out capabilities/
 *
 * Prints the warnings to stderr and the artifact path to stdout. The warnings
 * are the point of the output, not decoration: every one of them marks a place
 * the compiler decided something it could not verify, and a reviewer moving this
 * capability from `draft` to `approved` is signing off on exactly that list.
 *
 * Exits 1 on rejection, so a pipeline can tell "compiled with warnings" from
 * "did not compile".
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';

import { RecordingCompiler } from '@cua/compiler';

const USAGE = `usage: node scripts/compile.mjs <evidence-dir> [--out <dir>]

  --out <dir>   where to write the artifact   (default: capabilities)
  --version <v> version to stamp on it        (default: 1.0.0)
  --print       write the artifact to stdout instead of a file
  --force       overwrite an artifact a human has edited
`;

const argv = parseArgs(process.argv.slice(2));
if (argv.help || argv.dir === null) {
  process.stdout.write(USAGE);
  process.exit(argv.dir === null && !argv.help ? 2 : 0);
}

const dir = argv.dir.replace(/\/+$/, '');
const compiler = new RecordingCompiler(argv.version === null ? {} : { version: argv.version });
const result = await compiler.compile({ runId: basename(dir), path: dir });

if (result.kind === 'rejected') {
  process.stderr.write(`compile: rejected ${dir}\n`);
  for (const reason of result.reasons) process.stderr.write(`  - ${reason}\n`);
  process.exit(1);
}

const { capability, warnings } = result;
const json = JSON.stringify(capability, null, 2) + '\n';

process.stderr.write(
  `compiled ${capability.id}@${capability.version}\n` +
    `  ${capability.steps.length} steps · ` +
    `${capability.successCondition.checkpoints.length} checkpoints · ` +
    `${Object.keys(capability.outputs.properties ?? {}).length} outputs · ` +
    `approval=${capability.approval.state}\n`,
);

if (warnings.length > 0) {
  process.stderr.write(`\n${warnings.length} thing(s) a reviewer must check:\n`);
  for (const w of warnings) {
    process.stderr.write(`  [${w.code}] ${w.stepId ?? 'capability'}: ${w.detail}\n`);
  }
}

if (argv.print) {
  process.stdout.write(json);
} else {
  await mkdir(resolvePath(argv.out), { recursive: true });
  const path = join(argv.out, `${capability.id}.capability.json`);

  const losing = argv.force ? [] : await humanWorkAt(path, capability);
  if (losing.length > 0) {
    process.stderr.write(
      `\ncompile: refusing to overwrite ${path}\n` +
        `  A human has edited that artifact and this compilation would drop:\n` +
        losing.map((w) => `    - ${w}\n`).join('') +
        `\n  The compiler only knows what the recorded run showed it. Everything\n` +
        `  above is a judgement someone made afterwards, and re-recording is not\n` +
        `  a reason to discard it: it is the review, and the review is the part\n` +
        `  that makes the artifact safe to run unattended.\n\n` +
        `  Write it somewhere else and diff:\n` +
        `    node scripts/compile.mjs ${dir} --out /tmp/recompiled\n` +
        `    diff ${path} /tmp/recompiled/${capability.id}.capability.json\n\n` +
        `  Or pass --force, having decided the edits are stale.\n`,
    );
    process.exit(1);
  }

  await writeFile(path, json, 'utf8');
  process.stdout.write(path + '\n');
}

/**
 * What a recompile would silently delete.
 *
 * The compiler is a pure function of one recorded run, so anything in the file
 * on disk that a run cannot produce got there because a person put it there.
 * Overwriting it is the failure mode that makes a review loop worthless: the
 * warnings say "declare your business outcomes", somebody does, and the next
 * `npm run compile` quietly reverts them. This is not a merge — a merge would
 * have to decide which half is right, and only a reviewer can — it is a stop.
 */
async function humanWorkAt(path, fresh) {
  let existing;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return []; // Nothing there, or nothing readable. Writing is the right move.
  }

  const lost = [];
  const count = (v) => (Array.isArray(v) ? v.length : Object.keys(v ?? {}).length);

  const edits = count(existing.provenance?.humanEdits);
  if (edits > 0) lost.push(`${edits} recorded human edit(s) in provenance.humanEdits`);

  const outcomes = existing.businessOutcomes ?? [];
  if (outcomes.length > count(fresh.businessOutcomes)) {
    lost.push(`${outcomes.length} declared business outcome(s): ${outcomes.map((o) => o.code).join(', ')}`);
  }

  const tenants = Object.keys(existing.tenantOverrides ?? {});
  if (tenants.length > count(fresh.tenantOverrides)) {
    lost.push(`tenant override(s) for ${tenants.join(', ')}`);
  }

  // An approval is a signature on a specific document. Even re-approving the
  // recompiled one is a decision someone has to make again, so it counts.
  if ((existing.approval?.state ?? 'draft') !== 'draft') {
    lost.push(`approval.state '${existing.approval.state}', which would revert to '${fresh.approval.state}'`);
  }

  return lost;
}

function parseArgs(args) {
  const out = { dir: null, out: 'capabilities', version: null, print: false, force: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--out':
        out.out = need(args, ++i, '--out');
        break;
      case '--version':
        out.version = need(args, ++i, '--version');
        break;
      case '--print':
        out.print = true;
        break;
      case '--force':
        out.force = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`);
        if (out.dir !== null) fail('only one evidence directory may be given');
        out.dir = arg;
    }
  }
  return out;
}

function need(args, at, flag) {
  const value = args[at];
  if (value === undefined) fail(`${flag} needs a value`);
  return value;
}

function fail(message) {
  process.stderr.write(`compile: ${message}\n`);
  process.exit(2);
}
