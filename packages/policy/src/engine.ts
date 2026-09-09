import type {
  PolicyDecision,
  PolicyDocument,
  PolicyEngine,
  PolicyRequest,
  RiskDisposition,
} from '@cua/contracts';

/**
 * =============================================================================
 * THE POLICY ENGINE
 * =============================================================================
 * Deterministic (D8). ~200 lines, one JSON document, no model, no Rego.
 *
 * Every decision is attributable to a named rule, because "the automation
 * refused" is only useful in a regulated environment if you can say which line
 * of configuration refused and why.
 */

/**
 * Rule identifiers, ordered as they are evaluated.
 *
 * The order is a design decision, not an implementation detail, and it is
 * arranged so that the *most structural* objection wins the attribution:
 *
 *   1. `deny-pattern`   an explicit deny always beats any allow. Non-negotiable
 *                       first, or an allowlist entry could widen a targeted ban.
 *   2. `origin`,
 *      `path-prefix`    we are not supposed to be on this screen at all. This
 *                       outranks risk because "wrong system" is a bigger
 *                       problem than "risky action", and reporting the risk
 *                       rule here would send a reviewer down the wrong path.
 *   3. `action-type`    the verb is not in this deployment's vocabulary.
 *   4. `step-budget`    the run has taken more steps than any sane flow needs;
 *                       usually the signature of a loop.
 *   5. `risk-class`     last, and the only rule that can return
 *                       `require_confirmation` rather than a flat allow/deny.
 *
 * Everything before `risk-class` is a denial. That asymmetry is the point: the
 * allowlist decides *whether we may act here at all*, and risk decides *whether
 * a human must watch*.
 */
export const RULES = {
  denyPattern: 'deny-pattern',
  origin: 'allowlist.origin',
  pathPrefix: 'allowlist.path-prefix',
  actionType: 'allowlist.action',
  stepBudget: 'budget.max-steps',
  riskClass: 'risk.class',
} as const;

const ALLOW: PolicyDecision = { kind: 'allow' };

/**
 * Splits a location into origin and path.
 *
 * Non-URL locations (a desktop window identity, say) have no origin, and get an
 * empty one rather than a thrown error — the allowlist then simply will not
 * match, which is the correct default-deny behaviour for a surface this policy
 * was not written for.
 */
function splitLocation(location: string): { origin: string; path: string } {
  try {
    const url = new URL(location);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { origin: '', path: location };
  }
}

/**
 * Compiles the document's deny patterns once.
 *
 * An unparseable pattern is not skipped: a policy file that cannot be compiled
 * is a broken guardrail, and a broken guardrail that silently permits traffic is
 * the worst failure mode available to us.
 */
function compileDenyPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p, i) => {
    try {
      return new RegExp(p);
    } catch (cause) {
      throw new Error(`policy denyPatterns[${i}] is not a valid regular expression: ${p}`, {
        cause,
      });
    }
  });
}

export class AllowlistPolicyEngine implements PolicyEngine {
  readonly #doc: PolicyDocument;
  readonly #denyPatterns: readonly RegExp[];

  constructor(doc: PolicyDocument) {
    this.#doc = doc;
    this.#denyPatterns = compileDenyPatterns(doc.denyPatterns);
  }

  /** The document this engine was built from, for evidence and for tests. */
  get document(): PolicyDocument {
    return this.#doc;
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const { origin, path } = splitLocation(request.location);

    for (const pattern of this.#denyPatterns) {
      if (pattern.test(request.location)) {
        return deny(RULES.denyPattern, `location matches deny pattern /${pattern.source}/`);
      }
    }

    if (!this.#doc.allowedOrigins.includes(origin)) {
      return deny(
        RULES.origin,
        `origin '${origin || '(none)'}' is not in the allowlist; policy is default-deny`,
      );
    }

    if (!this.#doc.allowedPathPrefixes.some((prefix) => path.startsWith(prefix))) {
      return deny(RULES.pathPrefix, `path '${path}' does not start with any allowed prefix`);
    }

    if (!this.#doc.allowedActions.includes(request.action)) {
      return deny(RULES.actionType, `action '${request.action}' is not permitted by this policy`);
    }

    // `>=` because stepIndex is zero-based: with a budget of 40, index 40 is the
    // forty-first step.
    if (request.stepIndex >= this.#doc.maxStepsPerRun) {
      return deny(
        RULES.stepBudget,
        `run has reached its ${this.#doc.maxStepsPerRun}-step budget; ` +
          `a flow this long is usually a loop, not a flow`,
      );
    }

    return this.#disposeRisk(request);
  }

  #disposeRisk(request: PolicyRequest): PolicyDecision {
    const disposition: RiskDisposition = this.#doc.risk[request.risk];

    switch (disposition) {
      case 'allow':
        return ALLOW;

      case 'confirm':
        return {
          kind: 'require_confirmation',
          rule: RULES.riskClass,
          reason:
            `'${request.risk}' actions require a human decision under this policy ` +
            `(action: ${request.action})`,
        };

      case 'deny':
        return deny(
          RULES.riskClass,
          request.risk === 'irreversible'
            ? // I8 in prose, for whoever reads the log rather than the schema.
              `irreversible actions are never taken unattended: this is regulated ` +
              `financial data with no undo, so '${request.action}' escalates to a human`
            : `'${request.risk}' actions are denied by this policy`,
        );
    }
  }
}

function deny(rule: string, reason: string): PolicyDecision {
  return { kind: 'deny', rule, reason };
}
