# Design Report

A computer-use automation system for back-office banking software that has no API.

> The model discovers a flow once. The result is a typed artifact. Deterministic
> replay is how an agent invokes it in production, and a human takes over the
> same live session when replay cannot continue.

Everything here is running code or a declared cut. `npm test` runs **282 tests
across ten workspaces**; the numbers come from that suite and from the runs in
[`evidence/`](evidence). Each section is the short form of the same section in
**[DESIGN-NOTES.md](DESIGN-NOTES.md)**, where the arguments, the measurements and
the bugs behind them are written out in full.

---

## 1. Architecture

```
  goal ──▶ DISCOVERY ──▶ compile ──▶ CAPABILITY ──▶ REPLAY ──▶ success | outcome | failure
           LLM, once                 typed          no LLM,                        │
           25-step budget            artifact       every time                escalated
                                                                                   │
                                                                                   ▼
                                                                              HANDOFF
                                                                   a person takes the same
                                                                   live session, then hands
                                                                   it back mid-flow
```

Ten packages, one shared contract layer, no framework. TypeScript on Node ≥ 22,
because one zod definition is both the runtime validator and the JSON Schema an
agent needs. Playwright over CDP, because one stack gives accessibility snapshots,
a real browser, and the raw protocol the handoff screencast needs. Perception is
hybrid — a11y tree first, coordinates last — since pure a11y goes blind on a
table-layout app from 2003 and pure vision is expensive and imprecise.

`packages/contracts` is load-bearing; every other package depends on it and on
nothing else shared. Three seams inside it do the work:

- **`SurfaceDriver`** — perceive, resolve, act, check. No `Page`, no `Locator`, no
  CSS type crosses it, which is what lets the same artifact describe a Win32 form (§4).
- **`Capability`** — the artifact (§2).
- **`ReplayResult`** — a four-arm union, so a caller cannot confuse "no such
  member" with "the automation is broken" (§3).

Two boundaries are enforced by types rather than by prose: the model's ephemeral
element `ref` never reaches the artifact (the compiler translates it into a locator
bundle, so the model cannot invent selectors), and nothing in the evidence writer
can produce a `Capability` — the trace is the compiler's input, not the product.

The trade-off taken deliberately is **single process, files on disk**: no queue, no
worker pool. The runtime dependency list is `playwright`, `zod`,
`@anthropic-ai/sdk` (in `discovery` only, so "replay never calls a model" is a
property of the dependency graph) and `express` (fixture only). No web framework,
no state-machine library, no OPA — each would have made the interesting 200 lines
harder to find.

## 2. Artifact schema

`packages/contracts/src/capability.ts`; a compiled artifact is in
[`capabilities/`](capabilities). It is three documents at once, and the tension is
that all three must be true of one file: **a tool contract** (`inputs`/`outputs`
are literal JSON Schema — data, not zod — projected by `toToolDefinition()` with
`readOnly`/`destructive`/`unattended` derived from the steps), **a reviewable
document** (every step carries the model's prose `intent`; a reviewer reads
intents, not selectors), and **an executable plan**.

```jsonc
{
  "id": "member.read_savings_balance", "version": "1.0.0",
  "surface": { "kind": "legacy-web", "application": "northgate-core-admin",
               "entryPoint": "/admin/index.htm" },
  "inputs": { /* JSON Schema */ }, "outputs": { /* JSON Schema */ },
  "classification": { "memberId": "identifier" },      // drives redaction, per §6
  "steps": [{
    "id": "s1",
    "intent": "Member Search is the natural starting point to look up a member…",
    "action": { "type": "click" },
    "target": {
      "expectedRole": "link", "expectedName": "Member Search",
      "candidates": [                                  // ordered, independent
        { "strategy": "role-name",       "value": "link:Member Search", "confidence": 0.9 },
        { "strategy": "css",             "value": "a[href=\"/admin/search.htm\"]" },
        { "strategy": "robula-xpath",    "value": "//a[@href=\"/admin/search.htm\"]" },
        { "strategy": "structural-path", "value": "table[2]/row[1]/cell[1]/link[1]" },
        { "strategy": "viewport-coords", "value": "0.2738,0.0381" }]},
    "checkpoint": { "assert": "role-name-present", "value": "textbox:Member ID",
                    "timeoutMs": 10000 },
    "recover": [{ "on": "transient_load", "do": "wait_retry", "maxAttempts": 2 }]
  }],
  "businessOutcomes": [{ "code": "MEMBER_NOT_FOUND", "retryable": true, … }],
  "tenantOverrides": { "tenant-b": { /* sparse */ } },
  "provenance": { "discoveredBy": "k3", "traceRef": "evidence/discovery-…/trace.jsonl",
                  "humanEdits": [ … ] },
  "approval": { "state": "review" }
}
```

- **The candidate bundle.** Nine strategies, most to least durable, harvested
  *before* the action, because one click can replace the document and with it every
  fact about the element clicked. At replay all resolve and their answers are
  compared: disagreement is a *harder* failure than resolving nothing, because
  acting on the plurality winner means acting on the wrong control.
- **`checkpoint`** is the definition of "did this step happen", not a test
  assertion — which is what makes resumption possible. The screen is the authority
  on where we are; the step cursor is only a memory of where we were.
- **`businessOutcomes`** are declared in the contract, with the surface condition
  that recognises them, so §3's central rule is enforceable rather than aspirational.
- **`classification`** per input lets the redactor delete this run's actual values
  by exact match instead of regex-guessing them out of a log (§6).

Cross-field consistency lives in `superRefine`, not a linter: a step reading an
undeclared input, a success condition naming a checkpoint nobody emits, an output
no step produces — all rejected by `capability.parse()`, for every caller. Approval
state (`draft → review → approved`) rides in the artifact, so an unattended agent
may only invoke `approved`; `--as-agent` against the checked-in artifact returns
`POLICY_DENIED`.

## 3. Determinism & error handling

**Determinism** is enforced three ways rather than intended one way:
`packages/replay` has no model SDK in its dependency graph, so a replay that tried
to consult one would fail to resolve; a test greps that package's manifest for
`/anthropic|openai|langchain|@ai-sdk/i`; and `ReplayStats.llmCalls` is typed
`z.literal(0)`. Then it is measured, not asserted — `--repeat 5` reports **5 runs,
1 distinct result digest**. The digest covers the result arm, outputs, step ids and
their resolutions, and the failure class, and deliberately excludes timings and run
ids.

```ts
type ReplayResult =
  | { kind: 'success';   outputs }
  | { kind: 'outcome';   code; retryable; message }   // declared, expected, exit 0
  | { kind: 'failure';   failure: { class; stepId; expected; observed; detail } }
  | { kind: 'escalated'; interventionId; reason; resumeFrom }
```

"No such member" is a *successful invocation that returned a different answer* and
exits `0`; a pipeline treating `MEMBER_NOT_FOUND` as a broken automation pages
somebody at 3am over a mistyped id. The type is the prevention — the `failure` arm
has no `outputs` field. Failure is classified into eleven mutually exclusive
classes, `switch`ed without a `default`, so adding one breaks the build everywhere
it must be handled.

**Recovery uses no model.** Recoverable conditions map to per-step actions with a
bounded attempt count, and a recovery goes through the policy engine like any other
action — which is why an unexpected dialog is *dismissed* and never accepted.
Session death is probed for by looking for a control rather than an error string (an
Operator ID field on screen means signed-out in any language), and re-authentication
is attempted **exactly once**, because retrying a sign-on in a loop is how a lockout
happens.

**UI drift is detected, not repaired.** A renamed control makes the durable
candidates disagree or resolve nothing, surfacing as `LOCATOR_DISAGREEMENT` or
`LOCATOR_UNRESOLVED` naming the step and what it expected, rather than as a click
somewhere plausible. `scripts/drift.mjs` reproduces that against the real artifact;
the repair path is §5, a person, because a model repairing locators at replay time
puts non-determinism back on the production path exactly when it matters most.

The fixture ships six faults injectable by member id, so every arm is produced on
demand rather than described. An excerpt; the full matrix runs end to end in
[README.md](README.md#demo-path) and is committed under [`evidence/`](evidence):

| input | what the application does | result |
|---|---|---|
| `00000` | "No records matched your search" | `outcome MEMBER_NOT_FOUND` (retryable, exit 0) |
| `77777` | throws a `confirm()` dialog mid-flow | `success`, dialog dismissed, step retried |
| `66666` | drops the session back to sign-on | `failure SESSION_UNRECOVERABLE` after one re-auth |
| `abc` | never reaches the application | `failure INPUT_INVALID`, before the browser moves |
| drifted artifact | control renamed | `escalated`, then `success` after a human takeover |

## 4. Heterogeneity & multi-tenant

**Across applications** — the `SurfaceDriver` seam. Nothing in `packages/contracts`
outside the locator-strategy enum knows what a DOM is; a desktop driver would
implement `observe`, `resolve`, `perform`, `check` against UI Automation and the
same artifact would describe a Win32 form. Designed, not built (§7).

**Across deployments of one product** — sparse `tenantOverrides`. The realistic
case in a bank is one vendor product deployed twice, where an institution re-skinned
the CSS, moved a button and renamed a field. Copying the capability per tenant is
the obvious move and the wrong one: five copies means five places to fix the next
vendor upgrade and no way to tell which differences are real. An override is
therefore a patch over the base — entry point, and per step id a replacement target
or action — with everything unstated inherited.

The **drift score**, the fraction of steps a tenant overrides, is not decoration: a
tenant at 0.25 has a deployment quirk, a tenant at 0.8 is running a different
application and should have its own capability, and the number says so before
somebody discovers it during an incident. `apps/legacy-app` serves a second
deployment at `/tenant-b`, and `--tenant tenant-b` runs the *same* checked-in
artifact against it with one overridden step out of four.

## 5. Escalation & handoff

"Stuck" is not a heuristic here: it is the `escalated` arm of §3's union, raised by
a named failure class the artifact could not recover from.

Live-view browser tooling exists and is good. What none of it has is a notion of
*who holds control* — the socket is open, and anyone attached can type into the
session at any moment, including mid-step. The contribution is the **`ControlLease`**:

```
automation ──cede──▶ none ──claim──▶ operator ──handBack──▶ automation
                      ▲                   │
                      └────── expiry ─────┘
```

Control always passes through `none`, so there is never an instant when both
automation and a person could act. A lease is never stolen: there is no
`takeControl`, and the registry's method list is asserted in a test. An expired
operator lease lands on `none`, **never back on `automation`** — an operator who
shut their laptop mid-takeover left the session in a state nobody has looked at.
Nothing in the handoff package closes a session: `pause()` sets a flag and makes no
browser call, so the page, its cookies and its half-filled form stay as they are.

The console is one page with no build step — frames out over SSE, input back over
POST, deliberately not a WebSocket, because input is a request that can *fail* and a
409 with a reason beats a message dropped into a socket. Its link is a
**credential**: a signed, short-lived HMAC token naming the session and the
intervention, checked once for everything under `/api/`. Every operator input is
checked against the lease before dispatch, because a click on a live back-office
session is an action and does not skip the check just because a person made it.

Input arrives as CDP `Input.dispatch*` on the same session rather than as a screen
share, which is what makes the takeover recordable as **structured events** instead
of pixels. `handoff.json` records who held the lease, every input event in
normalised coordinates, the note they left, and the accessibility digest of the
screen **before and after** — the auditable answer to "what changed while a human had
the keyboard". Keystroke content is redacted on the way in: we record *that* an
operator typed into a field, never what.

A real end-to-end takeover is committed under [`evidence/handoff-*/`](evidence):

```
escalated  locator_unresolved
  waiting for an operator…
  control returned to automation; resuming

success  {"savingsBalance":"$4,231.08"}
         3/4 steps · 0 recoveries · 0 llm calls · 0.3s
```

**3/4 steps** and **0 llm calls** are what make this a handoff and not a restart:
the step the human performed was not performed again, because resumption walks
checkpoints rather than counting steps. `--no-handoff` degrades the same run to
`failure LOCATOR_UNRESOLVED` for a deployment with nobody to call.

## 6. Safety

Three layers, all deterministic. No LLM is used as a guardrail anywhere: an LLM
judge is itself prompt-injectable and cannot reason about "irreversible" as a
structural fact about an action.

**Allowlist, default-deny.** `policy.json` declares allowed origins and path
prefixes, the permitted action vocabulary, a per-run step ceiling and deny patterns.
Every action is evaluated before execution — `evaluate(principal, action, context) →
allow | deny | require_confirmation` — **in discovery and in replay, with no bypass
path**. In discovery a denial becomes the next turn's observation so the model
re-plans; in replay it is a hard failure. The shape is borrowed from OPA's `input +
policy → decision`; OPA itself is not, because a JSON document and ~200 lines is the
whole requirement.

**Risk tiers.** `safe` is allowed; `mutating` requires confirmation in discovery and
is governed by the artifact's approval state in replay; `irreversible` (transfer,
delete, send) is **always blocked** and escalated — enforced by the type, since the
schema is `z.enum(['confirm','deny'])` for that tier, so `irreversible: "allow"` is
*unrepresentable*. Regulated financial data has no undo, and one extra human is
cheaper than one wrong transfer.

**Redaction at three sinks.** Detection is separated from redaction, so the audit
log records "found `FINANCIAL_ACCOUNT`, confidence 0.9, 4 occurrences, sink
`screenshot`" without recording the number. The strong mechanism is the one usually
missing: **known values**, exact-match removal of the parameter values this run was
handed plus credentials from the environment — free only because the artifact
declares its parameters and classifications (§2). **Recognizers** are a regex
backstop for what we were not told about, not the design. The trace scrub walks
every string in an event rather than a per-field list, which would leak the first
time somebody adds an event type, and screenshots are blacked out before they reach
disk using accessibility bounding boxes rather than OCR. A successful run therefore
returns the balance to its caller and writes `[REDACTED:MONEY]` into `result.json`:
the answer is the product, the evidence directory is a permanent record on
somebody's disk.

**Limits.** `PERSON_NAME` has a measured false positive on `Verdana, Arial` in a CSS
font stack and does not detect a name in free prose at all — a test asserts that
rather than hiding it. An allowlist does not stop a permitted-but-wrong action:
clicking the right kind of button on the wrong member is inside the policy, and
checkpoints and approval are the mitigations. Screenshot blackout covers nothing
baked into an image, and the console link is a bearer token in a URL — signed and
short-lived, which bounds the exposure without eliminating it.

## 7. Cuts

**Stretch goals taken — two, and they are one mechanism seen twice.**
`capabilities/.stability.json` accumulates runs/successes per capability version,
and that counter is both the **multi-run stability** signal (`--repeat N` reports
distinct result digests) and the evidence a **confidence & approval** decision rests
on (`requireApproved` gates unattended invocation on `draft → approved`). Thirty
lines together, and each closes a hole the core would otherwise have: without them
"reviewable artifact" means a human read it once and nothing enforced that, and
"deterministic" stays an adjective instead of a number. Cross-tenant reuse appears
in §8's list too, but §3.7 is a core requirement, and answering it in prose and then
not running it seemed like the weaker version of the same work.

**Not built, by design.** A **desktop `SurfaceDriver`** — two drivers would have
proved the seam; one plus an interface that could not express a `Page` if it tried
is what the time allowed. **Scaling plumbing** — `raise()` writes a file and prints
a URL, and in a real deployment it becomes an enqueue into whatever operations
already lives in. **Operator authentication** — the console authenticates a *link*,
not a person. **A durable lease store** — `LeaseRegistry` is in-memory and
single-process. **`scroll_into_view` and `reload_and_resume`** — declared in the
schema, unimplemented, `switch` kept total so the compiler names them;
`reload_and_resume` means re-POSTing whatever got us here, an idempotency decision
this system has no basis to make. **LLM-assisted recovery** — rejected, because it
puts a model back on the production path. **An MCP server** — `toToolDefinition()`
exists and is tested, so the projection is done; the server is not.

**Simplified, with the cost named.** The operator console is one HTML file, one CSS
file and one script — the brief permits mocking it, and the mechanism underneath is
not mocked. Six real bugs were found by *using* it, one not cosmetic:
`POST /api/input` checked that *an* operator held the lease, never *which* one, so a
second person with the forwarded link could type into a session they had not
claimed. Compiled recovery rules are priors from the action type rather than
observations, because one discovery run does not observe a flaky load.

**What I would build next**, in order:

1. **A second `SurfaceDriver`, on a desktop application** — the only item here that
   can falsify a design claim rather than extend one. Everything §4 asserts about the
   seam is untested until a driver exists that has never heard of a DOM.
2. **A durable, compare-and-set lease store**, so two console processes cannot both
   believe they granted control — the one piece of §5 that does not survive a second
   replica.
3. **SSO in front of the console**, taking `operatorId` from the identity provider
   rather than a text field. Nothing in the lease design changes.
4. **Re-discovery on drift** — re-run discovery for the single failed step off-line,
   diff it against the artifact, and hand a reviewer a proposed patch. Model
   assistance in the review loop, where it is auditable, rather than on the
   production path, where it is not.
5. **The MCP server**, so another agent can invoke a capability by name without any
   of this repository's code.
