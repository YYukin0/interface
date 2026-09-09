# AGENTS.md

Instructions for any AI coding agent (or human) working in this repository.
Read this before touching code. It encodes decisions that are already made — do not relitigate them.

---

## 1. What this system is

A **computer-use automation system** for back-office banking applications that expose no API.

```
  goal (natural language)          "read member 12345's savings balance"
        │
        ▼
  ┌─────────────────┐
  │ DISCOVERY       │   LLM in the loop: observe → decide → act
  │ (expensive,     │   Drives a real UI. Runs once.
  │  non-deterministic)
  └────────┬────────┘
           │ compile
           ▼
  ┌─────────────────┐
  │ CAPABILITY      │   Typed, versioned, reviewable artifact.
  │ (the product)   │   Inputs, outputs, steps, checkpoints, business outcomes.
  └────────┬────────┘
           │ invoke with params
           ▼
  ┌─────────────────┐
  │ REPLAY          │   NO LLM. Deterministic. Cheap. This is the production path.
  │ (the hot path)  │   Returns success | outcome | failure | escalated.
  └────────┬────────┘
           │ stuck?
           ▼
  ┌─────────────────┐
  │ HANDOFF         │   Human takes control of the SAME live session, then hands back.
  └─────────────────┘
```

**The one sentence to keep in your head:**
> The model discovers. The artifact is the reusable capability. Deterministic replay is how the AI agent invokes it in production.

Three things live beside this repository rather than inside it, and are gitignored
for the reasons in `.gitignore`: the assignment brief
(`Assignment A — Computer-Use Automation System.pdf`), the working implementation
plan (`PLAN.md`), and the reference clones and papers under `research/`.

---

## 2. Decisions already made (do not relitigate)

The brief left these open on purpose (§4 "Explicitly your call"). They are now decided.
Each has a one-line rationale that must survive into `REPORT.md`.

| # | Decision | Rationale |
|---|---|---|
| D1 | **TypeScript, Node ≥ 22, npm workspaces** | The artifact schema is the graded centrepiece; one zod definition gives runtime validation *and* the JSON Schema the calling agent needs. No second language, no codegen step. |
| D2 | **Playwright, driven over CDP** | We need three things from one stack: `ariaSnapshot({ mode: 'ai' })` refs, trace files for evidence, and raw CDP for screencast-based handoff. Playwright is the only one that gives all three. |
| D3 | **Hybrid perception: a11y tree primary, screenshot + coordinates fallback** | Pure a11y goes blind on table-layout legacy apps; pure vision is expensive and imprecise. Both major vendors converged on hybrid in 2026. |
| D4 | **Claude (Opus/Sonnet 5) with strict tool-calling** in discovery only | Structured action output, never free text. Replay must never import an LLM client (see I1). |
| D5 | **Self-built Dockerized legacy target app** (`apps/legacy-app`) | The brief grades runtime-error handling third-highest. Public demo sites cannot be made to return "record not found" or expire a session on demand. Self-hosting also gives us the two tenant variants needed for cross-tenant reuse. |
| D6 | **Artifact = JSON, envelope validated by zod, `inputs`/`outputs` stored as literal JSON Schema** | The artifact must be readable by a calling agent as a tool contract. Storing JSON Schema *as data* keeps the artifact independent of our validation library. |
| D7 | **Multi-locator candidate bundles, ordered, with agreement checking** | Independently supported by research (Leotta et al., ICST'15) and by production code (workflow-use demoted `cssSelector`/`xpath` to `[LEGACY]` in favour of an ordered `selectorStrategies` list). |
| D8 | **Deterministic policy engine, not an LLM guardrail** | An LLM judge cannot reason about "irreversible" as a structural fact, and is itself prompt-injectable. Policy is a YAML allowlist plus ~200 lines of evaluation. No OPA/Rego dependency — the brief explicitly penalises framework name-dropping. |
| D9 | **Handoff via CDP screencast + input injection, with a `ControlLease`** | Reference implementation read in `research/steel-browser/api/src/plugins/browser-socket/casting.handler.ts` (MIT). The lease is our addition: Steel's live view lets anyone interfere at any time and has no notion of *who holds control*. Auditable control transfer is the graded requirement. |
| D10 | **Single process, file-backed storage** | The brief penalises premature queues/clusters. Capabilities are files on disk; runs are directories. |
| D11 | **One stretch goal only: cross-tenant reuse via sparse overrides** | It satisfies a core evaluation criterion (§3.7 generalization) and a stretch goal at once. |

---

## 3. Invariants (violating these is a bug, not a style preference)

**I1 — Replay must not be able to call an LLM.**
Not "should not". *Cannot*. `packages/replay` must not depend on any model SDK, and CI enforces this with a dependency check. Determinism guaranteed by discipline is not guaranteed.

**I2 — A business outcome is never an error.**
"No such member" is a successful invocation that returns `{ kind: 'outcome', code: 'MEMBER_NOT_FOUND' }`. Conflating this with failure is, per the brief's glossary, the single most common design mistake in this problem. Never `throw` for a declared outcome.

**I3 — Secrets and raw PII never reach disk or the model.**
Every write to an artifact, a log, or a prompt passes through `Redactor`. Credentials come from env only. Detection is logged; values are not (`"found FINANCIAL_ACCOUNT at step 3, confidence 0.9"` — never the number).

**I4 — Every action is policy-checked before execution, in both discovery and replay.**
No bypass path. A denial in discovery is fed back to the model as an observation so it re-plans; a denial in replay is a hard failure.

**I5 — The artifact is decoupled from the transcript.**
`Capability` references evidence by path (`provenance.traceRef`). Raw model transcripts are never inlined, and the artifact schema is strict — unknown keys are rejected, so recorder internals cannot leak in.

**I6 — Nothing web-specific crosses the `SurfaceDriver` seam.**
No `Page`, no `Locator`, no CSS string types in `packages/contracts` outside the declared locator strategy enum. If a desktop driver could not implement it, it does not belong in the interface.

**I7 — Resume is by checkpoint, never by step index.**
A human who took over may have advanced the UI several steps. Recovering "the next step" would double-apply actions. Always re-verify a checkpoint and continue from there.

**I8 — Irreversible actions are blocked, always.**
Never auto-confirmed, not even with a flag. They escalate to a human. This is regulated financial data with no undo. The policy schema makes `irreversible: 'allow'` unrepresentable, so this is not merely a default.

**I9 — Consistency rules live in the schema, not in a linter.**
If a rule describes a way an artifact can be internally inconsistent — a step reading an undeclared input, a success condition naming a checkpoint nobody emits, a declared output no step produces — it belongs in `capability.superRefine`, where it runs for every caller. A rule that only fires when someone remembers to run a script is documentation. We already shipped one such check that was silently broken for its entire life; that is the failure mode this invariant exists to prevent.

### Which invariants are machine-enforced

Claims are cheap. Current status:

| Invariant | Enforced by | Status |
|---|---|---|
| I1 no LLM in replay | `ReplayStats.llmCalls: z.literal(0)` + planned CI dependency check | schema ✅ · CI check pending |
| I2 outcome ≠ failure | four-arm `replayResult` union; `failure` arm has no `outputs` | ✅ tested |
| I3 no secrets/PII persisted | `looksSensitive` literal check, mandatory classification, `secret` barred as a parameter | ✅ tested (schema-level; runtime redactor pending) |
| I4 every action policy-checked | `PolicyEngine` interface; no bypass path exists in the contracts | interface ✅ · engine pending |
| I5 artifact ≠ transcript | `.strict()` everywhere + `provenance.traceRef` | ✅ tested |
| I6 nothing web-specific crosses the seam | review; no `Page`/`Locator`/CSS types in `contracts` | ✅ by construction |
| I7 resume by checkpoint | `InterventionRequest.resumeFrom` is a `CheckpointId`, not a `StepId` | ✅ by construction |
| I8 irreversible blocked | `risk.irreversible: z.enum(['confirm','deny'])` | ✅ tested |
| I9 rules in schema | `capability.superRefine` | ✅ tested |

`npm test` currently runs 38 invariant tests over the contract layer.

---

## 4. Repository layout

```
apps/
  legacy-app/        Hostile target: framesets, table layout, no test IDs, fault injection
  operator/          Minimal human-takeover console (screencast canvas + input relay)
packages/
  contracts/         ← ALL shared types live here. Start reading here.  [IMPLEMENTED]
  surface-web/       SurfaceDriver implementation for Playwright
  discovery/         LLM agent loop (observe → decide → act). Only package that may import a model SDK.
  compiler/          trace.jsonl → Capability
  replay/            Deterministic executor. MUST NOT depend on an LLM SDK.
  policy/            Allowlist + risk classification
  redact/            Detection/redaction split
  evidence/          Structured run logs, traces, screenshots
  store/             Capability persistence + tenant override resolution
  catalog/           MCP-shaped surface so an agent can list and invoke capabilities
evidence/            Committed demo runs (discovery, replay, replay-with-error, handoff)
research/            Reference material. GIT-IGNORED — do not commit (200MB+ of clones).
```

**`packages/contracts` is the load-bearing package.** Every other package depends on it and nothing else shared. If you are adding a type that two packages need, it goes there.

Its modules, in reading order:

| Module | Holds |
|---|---|
| `common.ts` | identifiers, data classification, `stuckReason`, drift threshold, `looksSensitive` |
| `surface.ts` | **the seam** — locator strategies, `A11yNode`, `Action`, `Checkpoint`, `SurfaceDriver` |
| `capability.ts` | **the artifact** — steps, business outcomes, tenant overrides, cross-field rules |
| `discovery.ts` | the model's `ref`-addressed action vocabulary, and `trace → Capability` compilation |
| `replay.ts` | the four-arm result union and the failure taxonomy |
| `policy.ts` | allowlist, principals, risk dispositions |
| `handoff.ts` | `ControlLease`, intervention requests, operator audit records |
| `store.ts` | persistence + `applyTenantOverride` and the drift score |
| `catalog.ts` | `toToolDefinition` — the artifact projected as a callable tool |
| `evidence.ts` | trace event union, `Redactor`, `EvidenceWriter` |

Two boundaries inside it are easy to get wrong and worth stating:

- **`AgentAction` (discovery) is not `Action` (capability).** The model addresses elements by ephemeral `ref`; the artifact addresses them by locator bundle and parameter reference. The compiler translates. Fusing them would drag refs into the persisted artifact and let the model invent selectors.
- **`Checkpoint` lives in `surface.ts`, not `capability.ts`.** It asserts surface state, so a desktop driver must be able to evaluate one. Putting it with the artifact would have created an import cycle and, worse, implied it was web-shaped.

---

## 5. Conventions

- **Types before implementation.** This project is graded on schema quality. Write the contract, get it reviewed, then implement against it.
- **Discriminated unions over booleans and optional fields.** `{ kind: 'success', outputs }` not `{ ok: true, outputs?, error? }`. Illegal states must be unrepresentable.
- **Enumerate error taxonomies exhaustively; `switch` over them without a `default`.** Adding a new failure class should break the build everywhere it must be handled.
- **`readonly` everywhere in contracts.** Artifacts are values, not mutable state.
- **No `any`. No non-null `!`.** Use zod parsing at boundaries and narrow properly inside.
- **Tests where they carry weight, not everywhere.** Non-negotiable coverage: schema validation round-trips, the error-classification decision table, policy allow/deny, redaction, and the five-identical-runs determinism test. UI polish is untested by design.
- **Every mock is deliberate and documented.** If you stub something, add it to the Cuts list in `REPORT.md` in the same commit. An undocumented stub is worse than a missing feature.
- Comments explain *why*, never *what*. Match surrounding density.

---

## 6. Deliverable contract (the brief dictates these paths exactly)

- `/README.md` — setup, config/keys, how to run without live services, and the exact demo commands (run agent on a goal → replay the artifact).
- `/REPORT.md` — **exactly these seven headings**: Architecture · Artifact schema · Determinism & error handling · Heterogeneity & multi-tenant · Escalation & handoff · Safety · Cuts.
- `/evidence/` — a saved artifact plus logs from a discovery run and a replay run, **including one replay that hits an error or exceptional state**.

**The discovery run must be real.** At least one genuine LLM-driven run against the live surface, with evidence in `/evidence/` proving it happened. This is the one thing the brief refuses to let us stub.

---

## 7. Working agreements for agents

- Read `packages/contracts` before proposing any change. Most questions are answered by the types.
- Do not add dependencies without a line in `REPORT.md` justifying them. Framework breadth is explicitly not rewarded.
- Do not build scaling infrastructure (queues, workers, multi-tenant plumbing). Designing abstractions that *could* scale is rewarded; building the plumbing is penalised.
- Prefer a thin-but-real version of every capability over a polished subset.
- When researching prior art, clone the repo and read the source. Blog posts and READMEs omit the load-bearing details — the two most useful findings in this project both came from reading source that no summary mentioned.
