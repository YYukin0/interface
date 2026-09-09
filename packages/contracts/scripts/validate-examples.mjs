/**
 * Parses every artifact in the given directories against the real schema and
 * prints a summary.
 *
 * This used to also re-implement a handful of cross-field checks. Those now live
 * in `capability.superRefine`, where they run for every caller instead of only
 * when someone remembers to run this script — one of them had been silently
 * broken (it looked up the sensitivity map by value instead of by property name,
 * so it could never fire). A rule worth having is worth putting in the schema.
 *
 * It takes directories on the command line and defaults to this package's
 * `examples/`, which is a *schema fixture*: hand-written, deliberately larger
 * than anything the compiler emits, and the document 40 contract tests are
 * written against. It shares an id with the compiled artifact in the
 * repository's `capabilities/`, which is a trap worth naming — the two are
 * different documents and the numbers below differ between them. The root
 * `npm run validate` passes both directories for exactly that reason: a
 * reviewer should see the fixture and the shipped capability side by side
 * rather than wonder which one they are reading.
 *
 *   node scripts/validate-examples.mjs [dir...]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capability, toToolDefinition, applyTenantOverride } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const given = process.argv.slice(2);
const targets = given.length > 0 ? given : [join(here, '..', 'examples')];

let failed = 0;
for (const dir of targets) {
  if (targets.length > 1) console.log(`\n${dir}/`);
  failed += validate(dir);
}
process.exit(failed === 0 ? 0 : 1);

function validate(dir) {
  let bad = 0;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.capability.json'))) {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const result = capability.safeParse(raw);

    if (!result.success) {
      bad++;
      console.error(`✗ ${file}`);
      for (const issue of result.error.issues) {
        console.error(`    ${issue.path.join('.') || '<root>'}: ${issue.message}`);
      }
      continue;
    }

    const c = result.data;
    const tool = toToolDefinition(c);

    console.log(`✓ ${file}`);
    console.log(`    ${c.id}@${c.version}  (${c.surface.kind} · ${c.surface.app})`);
    console.log(
      `    ${c.steps.length} steps · ${c.businessOutcomes.length} declared outcomes · ` +
        `approval=${c.approval.state}`,
    );
    console.log(
      `    as a tool: readOnly=${tool.annotations.readOnlyHint} ` +
        `destructive=${tool.annotations.destructiveHint} ` +
        `unattended=${tool.annotations.availableUnattended}`,
    );
    console.log(`    outcomes: ${tool.outcomes.map((o) => o.code).join(', ') || '(none)'}`);

    for (const tenant of Object.keys(c.tenantOverrides)) {
      const r = applyTenantOverride(c, tenant);
      const flag = r.needsRebaseline ? '  ⚠ exceeds drift threshold — consider re-recording' : '';
      console.log(
        `    tenant ${tenant}: ${r.applied.length}/${c.steps.length} steps overridden ` +
          `(drift ${r.driftScore.toFixed(2)})${flag}`,
      );
    }
  }

  return bad;
}
