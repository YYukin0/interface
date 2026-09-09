#!/usr/bin/env node
/**
 * =============================================================================
 * DRIFT — age a capability artifact by one vendor release
 * =============================================================================
 *
 *   node scripts/drift.mjs                      # writes to /tmp/cua-drifted
 *   node scripts/drift.mjs --step s2 --out ./x
 *
 * Renames one step's expected control and throws away every locator candidate
 * except the one that names it. That is the failure the handoff exists for: not
 * a flaky selector — those the recovery rules already absorb — but a control
 * that is genuinely gone, where no amount of retrying helps and the next move
 * has to be a person's.
 *
 * It lives in `scripts/` rather than in the replay CLI on purpose. Breaking an
 * artifact is a thing you do to stage a demo, and a `--drift` flag on the
 * production entry point would be a way to run automation against a capability
 * nobody compiled. The store is copied, never edited in place, so the checked-in
 * artifact is untouched whatever you pass.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const argv = { from: 'capabilities', out: '/tmp/cua-drifted', step: 's1', name: 'Member Lookup' };

for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i]?.replace(/^--/, '');
  const value = process.argv[i + 1];
  if (!(flag in argv) || value === undefined) {
    process.stderr.write(`usage: node scripts/drift.mjs [--from dir] [--out dir] [--step id] [--name text]\n`);
    process.exit(2);
  }
  argv[flag] = value;
}

await mkdir(argv.out, { recursive: true });

let touched = 0;
for (const file of await readdir(argv.from)) {
  if (!file.endsWith('.capability.json')) continue;

  const capability = JSON.parse(await readFile(join(argv.from, file), 'utf8'));
  const step = capability.steps.find((s) => s.id === argv.step);

  if (step?.target != null) {
    step.target.expectedName = argv.name;
    // One candidate, so the run fails for the stated reason rather than being
    // rescued by a CSS selector that still happens to match.
    step.target.candidates = [
      {
        strategy: 'role-name',
        value: `${step.target.expectedRole}:${argv.name}`,
        confidence: 0.9,
        note: 'renamed by the vendor in a release nobody told us about',
      },
    ];
    touched++;
  }

  await writeFile(join(argv.out, file), JSON.stringify(capability, null, 2) + '\n', 'utf8');
}

process.stderr.write(
  `drifted ${touched} artifact(s) at step ${argv.step} → '${argv.name}'\n` +
    `  ${argv.out}\n\n` +
    `  node scripts/replay.mjs member.read_savings_balance \\\n` +
    `    --params '{"memberId":"12345"}' --capabilities ${argv.out}\n`,
);
