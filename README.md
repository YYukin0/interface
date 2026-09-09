# Computer-Use Automation System

An AI agent decides *what* to do. This is how it reliably and safely *does* it, inside legacy bank software that offers no other way in.

```
  goal ──▶ DISCOVERY ──▶ CAPABILITY ──▶ REPLAY ──▶ result
           (LLM, once)    (typed        (no LLM,    success | outcome
                           artifact)     every       | failure | escalated
                                         time)              │
                                                            ▼
                                                        HANDOFF
                                              human takes the same live session
```

The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the agent invokes it in production.

---

## Status

Honest state of the build, so nothing here reads as more finished than it is.

| Piece | State |
|---|---|
| Contract layer (`packages/contracts`) | **Implemented** — 40 invariant tests |
| Example capability artifact | **Implemented** — parses, projects to a tool definition, resolves across two tenants |
| Legacy target app (`apps/legacy-app`) | **Implemented** — frameset, two tenants, six injectable faults, 14 tests |
| Policy engine + redactor | **Implemented** — 37 tests; the redactor's limits are asserted, not just documented |
| Surface driver (`packages/surface-web`) | **Implemented** — multi-locator harvest and agreement voting, 23 tests |
| Evidence writer | **Implemented** — one directory per run, redacted on the way to disk, 16 tests |
| Discovery loop | **Implemented** — 53 tests, plus a real model-driven run in [`evidence/`](evidence) |
| Compiler | **Implemented** — 27 tests; output in [`capabilities/`](capabilities) |
| Replay engine | **Implemented** — 36 tests against a real browser; five runs of one artifact produce one result digest |
| Handoff + operator console | **Implemented** — control lease, CDP screencast, signed console link, 32 tests; a real takeover in [`evidence/handoff-*`](evidence) |

Design write-up (the brief's seven headings): [REPORT.md](REPORT.md).
Committed runs, and what each one demonstrates: [evidence/README.md](evidence/README.md).
Design decisions and their rationale: [AGENTS.md](AGENTS.md) §2.

---

## Requirements

- Node ≥ 22
- A model API key, for discovery runs only. **Replay never needs one** — that is the point of the system, and it is enforced rather than merely intended.

Docker is optional; `npm run app` starts the target application directly.

## Setup

```bash
npm install
```

```bash
npm run build
```

## What you can run today

Typecheck everything:

```bash
npm run typecheck
```

Run the invariant test suite:

```bash
npm test
```

Validate the example capability and see it resolved for each tenant:

```bash
npm run validate
```

That last one prints each artifact's summary, its projection as an agent-callable tool, and the per-tenant drift score:

```
packages/contracts/examples/
✓ member.read_savings_balance.capability.json
    member.read_savings_balance@1.0.0  (legacy-web · cu-coreadmin)
    5 steps · 2 declared outcomes · approval=draft
    as a tool: readOnly=true destructive=false unattended=false
    outcomes: MEMBER_NOT_FOUND, PERMISSION_DENIED
    tenant tenant-b: 2/5 steps overridden (drift 0.40)  ⚠ exceeds drift threshold

capabilities/
✓ member.read_savings_balance.capability.json
    member.read_savings_balance@1.0.0  (legacy-web · northgate-core-admin)
    4 steps · 2 declared outcomes · approval=review
    as a tool: readOnly=true destructive=false unattended=false
    outcomes: MEMBER_NOT_FOUND, PERMISSION_DENIED
    tenant tenant-b: 1/4 steps overridden (drift 0.25)
```

Two artifacts, one id, and the difference matters. The first is a hand-written **schema fixture** — deliberately larger than anything the compiler emits, and what the contract tests are written against. The second is the **real compiled capability**, recorded by a model driving the application and then edited by a reviewer. Replay runs the second one.

## Demo path

Every command below runs today.

```bash
# 0. Start the legacy target application
npm run app
```

```bash
# 1. Discovery — the one step that genuinely needs a model
node scripts/discover.mjs jobs/read-savings-balance.json
```

```bash
# 1a. …or exercise everything except the model, on a machine with no key
node scripts/discover.mjs jobs/read-savings-balance.json --check
```

```bash
# 2. Compile the trace into a reviewable capability
node scripts/compile.mjs evidence/discovery-<id>
```

The compiler prints what it could not verify — the checked-in artifact carries one such warning, closed by a human edit recorded in `provenance.humanEdits`. Recompiling over an artifact somebody has edited **refuses** and says what it would have dropped, because a review loop where the next compile silently reverts the review is not a review loop. `--force` overrides it.

```bash
# 3. Replay it deterministically, with a different input and no model
node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"67890"}'
```

```bash
# 4. Replay against a member who does not exist — a business outcome, not a crash
node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"00000"}'
```

```bash
# 5. Replay the same capability as a second tenant running the same vendor product
node scripts/replay.mjs member.read_savings_balance --tenant tenant-b --params '{"memberId":"67890"}'
```

```bash
# 6. The determinism claim, as a number: five runs, one result digest
node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"12345"}' --repeat 5
```

```bash
# 7. Break the artifact the way a vendor release breaks it, and watch a human
#    take over the same live session
node scripts/drift.mjs
```

```bash
node scripts/replay.mjs member.read_savings_balance \
  --params '{"memberId":"12345"}' --capabilities /tmp/cua-drifted
```

`drift.mjs` renames one step's control and drops every locator candidate but the
one naming it — the failure no retry can fix. The run stops, prints a signed
console link, and waits. Open it: you get the screen the automation was looking
at, a brief explaining why you were called, and a **Take control** button. Click
`Member Search` by hand, write a note, and press **Hand back & resume**. The run
continues at `s2` — the first step whose checkpoint is not yet true — because the
session was never closed and the screen you left is the screen it inherits.

```
escalated  locator_unresolved
         intervention iv-replay-2026-09-09T13-52-48-383Z-1d2f61
  waiting for an operator… (ctrl-c to abandon the run)
  control returned to automation; resuming

success  {"savingsBalance":"$4,231.08"}
         3/4 steps · 0 recoveries · 0 llm calls · 0.3s
```

Note the two numbers that make this a handoff and not a restart: **3/4 steps**,
and **0 llm calls**. Nothing consulted a model to recover, and step 1 was not
performed twice. `--no-wait` raises the intervention without blocking, and
`--no-handoff` shows what the same run degrades to where there is nobody to call
(`failure LOCATOR_UNRESOLVED`).

What the person did is written down. [`evidence/handoff-*/handoff.json`](evidence)
records who held the lease, when, every input event they sent in normalised
coordinates, and the accessibility digest of the screen before and after — which
is the auditable answer to "what changed while a human had the keyboard", and the
one a screen recording cannot give without somebody watching it.

Step 3 prints the answer, where the evidence went, and how many times a model was consulted:

```
success  {"savingsBalance":"$18,904.55"}
         evidence evidence/replay-2026-09-09T14-02-31-592Z-27aeba
         4/4 steps · 0 recoveries · 0 llm calls · 0.3s
         digest ea7b7def38e646bb
```

The fixture application ships six injectable faults, reachable by member id, so each arm of the result contract can be produced on demand rather than described:

| `--params` | what the application does | result |
|---|---|---|
| `{"memberId":"12345"}` | nothing unusual | `success` |
| `{"memberId":"00000"}` | "No records matched your search" | `outcome MEMBER_NOT_FOUND` (retryable, **exit 0**) |
| `{"memberId":"99999"}` | "You are not authorized to view this record" | `outcome PERMISSION_DENIED` (not retryable, exit 0) |
| `{"memberId":"77777"}` | throws a `confirm()` dialog mid-flow | `success`, after the dialog is dismissed and the step retried |
| `{"memberId":"88888"}` | responds several seconds late | `success`, waited out on the checkpoint's budget |
| `{"memberId":"66666"}` | drops the session back to sign-on | `failure SESSION_UNRECOVERABLE`, after one re-authentication attempt |
| `{"memberId":"abc"}` | never reaches the application | `failure INPUT_INVALID`, before the browser moves |
| `--as-agent` | — | `failure POLICY_DENIED`: an unattended agent may not invoke a capability still in review |

A declared business outcome exits `0`. "No such member" is the answer the caller asked for, and a pipeline that treated it as a broken automation would page somebody at 3am over a mistyped id.

Only step 1 needs a model. It reads `CUA_LLM_API_KEY` (with optional `CUA_LLM_BASE_URL` and `CUA_LLM_MODEL`), deliberately *not* the ambient `ANTHROPIC_*` variables — on a developer machine those usually point at whatever tooling that developer runs, and a discovery run conducted by a model the evidence does not name has fictional provenance. Steps 3–5 need no key at all, and `packages/replay` is forbidden from depending on a model SDK so that this stays true.

A discovery job (`jobs/*.json`) is committable: it declares the goal, the entry point, the tenant, and which parameters exist. The values behind those parameters are not in it — the fixture job carries an inline `value` because member 12345 is a member of nobody, and a real deployment uses `valueFrom` to name an environment variable instead.

## Reading the code

Start at [`packages/contracts/src/index.ts`](packages/contracts/src/index.ts), which lists the modules in the order they make sense in. The three that carry the design:

- [`surface.ts`](packages/contracts/src/surface.ts) — the seam between perceiving a surface and the recorded flow. Nothing web-specific crosses it, which is what lets the same artifact format describe a desktop app.
- [`capability.ts`](packages/contracts/src/capability.ts) — the artifact. Simultaneously a tool contract, a reviewable document, and an executable plan.
- [`replay.ts`](packages/contracts/src/replay.ts) — the result contract. Business outcomes, failures, and escalations are different arms of a union, so a caller cannot confuse them.

## A note on secrets

Credentials come from the environment and are never written to an artifact, a log, or a prompt. The schema refuses to store a parameter classified `secret`, and refuses literals that look like account numbers, amounts, or credentials. `research/` is gitignored: it holds third-party clones under their own licences.

## License

[MIT](LICENSE). The reference clones under `research/` are not covered by it — they are not distributed here, and each carries its own licence.

