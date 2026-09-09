import { readFile } from 'node:fs/promises';
import { policyDocument, type PolicyDocument } from '@cua/contracts';
import { AllowlistPolicyEngine } from './engine.js';

/**
 * The policy file is JSON, not YAML.
 *
 * YAML would buy comments, and comments in a guardrail file genuinely matter.
 * It would cost a parser dependency, and the brief penalises breadth of
 * dependencies over depth of thought. The compromise: the document is validated
 * by the same zod schema the rest of the system uses, so a malformed policy
 * fails loudly at load rather than quietly at the first action, and the
 * rationale for each rule lives in REPORT.md §6 where a reviewer will actually
 * look for it.
 */
export async function loadPolicy(path: string): Promise<PolicyDocument> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    // Default-deny means a missing policy file must stop the run. Falling back
    // to a permissive built-in would make the safety story a lie.
    throw new Error(`policy file not found at ${path}; refusing to run without one`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`policy file at ${path} is not valid JSON`, { cause });
  }

  const result = policyDocument.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`policy file at ${path} is invalid:\n${issues}`);
  }
  return result.data;
}

export async function loadPolicyEngine(path: string): Promise<AllowlistPolicyEngine> {
  return new AllowlistPolicyEngine(await loadPolicy(path));
}

/**
 * A policy that permits nothing.
 *
 * Exported so tests and callers can be explicit about starting from zero, and
 * so that "what does an empty allowlist do" has an answer you can execute
 * rather than one you have to trust.
 */
export const DENY_ALL: PolicyDocument = policyDocument.parse({ version: '1.0.0' });
