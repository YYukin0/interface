# Design Report

A computer-use automation system for back-office banking software that has no API.
The claim it is built around is one sentence:

> The model discovers a flow once. The result is a typed artifact. Deterministic
> replay is how an agent invokes it in production, and a human takes over the
> same live session when replay cannot continue.

Everything below is either running code or an explicitly declared cut. `npm test`
runs **274 tests across ten workspaces**; the numbers quoted in each section are
from that suite and from the runs committed under [`evidence/`](evidence).

---

## Architecture

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

Ten packages, one shared contract layer, no framework.

| Package | Holds | Tests |
|---|---|---|
| `contracts` | every shared type; zod schemas that are simultaneously runtime validators and the JSON Schema an agent needs | 40 |
| `surface-web` | the only Playwright/CDP code in the system | 23 |
| `discovery` | the agent loop; the **only** package permitted a model SDK | 53 |
| `compiler` | `trace.jsonl` → `Capability` | 27 |
| `replay` | the deterministic executor | 36 |
| `policy` | allowlist and risk disposition | 14 |
| `redact` | detection/redaction split, including PNG blackout | 23 |
| `evidence` | one directory per run, redacted on the way to disk | 14 |
| `handoff` | control lease, console server, audit record | 30 |
| `apps/legacy-app` | the hostile target: framesets, table layout, no test ids, six injectable faults | 14 |

**`packages/contracts` is load-bearing.** Every other package depends on it and on
nothing else shared. Three seams inside it do the real work:

- **`SurfaceDriver`** (`surface.ts`) — perceive, resolve, act, check. No `Page`,
  no `Locator`, no CSS type crosses it. That is what lets the same artifact
  format describe a Win32 application; it is also why `Checkpoint` lives beside
  the driver rather than beside the artifact, since a desktop driver has to be
  able to evaluate one.
- **`Capability`** (`capability.ts`) — the product. See §2.
- **`ReplayResult`** (`replay.ts`) — a four-arm union, so a caller cannot confuse
  "no such member" with "the automation is broken". See §3.

Two boundaries inside the contracts are easy to get wrong and were worth stating
in code:

**`AgentAction` is not `Action`.** The model addresses elements by an ephemeral
`ref` valid only within the observation that produced it. The artifact addresses
them by a locator bundle and a parameter reference. The compiler translates
between them. Fusing the two would drag refs into the persisted artifact and let
the model invent selectors — the artifact would then be a transcript wearing a
schema.

**The trace is not the artifact (I5).** Nothing in the evidence writer can
produce a `Capability`. The compiler reads a run directory and emits one; the
artifact references that directory by path and inlines none of it. The schema is
`.strict()` throughout, so recorder internals cannot leak in even by accident.

### Choices worth defending

| # | Decision | Why |
|---|---|---|
| D1 | TypeScript, Node ≥ 22, npm workspaces | One zod definition gives runtime validation *and* the tool schema. No second language, no codegen. |
| D2 | Playwright driven over CDP | Three things from one stack: accessibility snapshots, a real browser, and raw CDP for the handoff screencast. |
| D3 | Hybrid perception — a11y tree primary, coordinates last | Pure a11y goes blind on a table-layout app from 2003; pure vision is expensive and imprecise. |
| D7 | Multi-locator candidate bundles with agreement voting | One selector is a single point of failure and the failure is silent. See §3. |
| D8 | Deterministic policy engine, not an LLM guardrail | An LLM judge cannot reason about "irreversible" as a structural fact and is itself injectable. ~200 lines and a JSON document instead of a Rego dependency. |
| D9 | Handoff via CDP screencast + input injection + a `ControlLease` | Live-view tooling exists; none of it has a notion of *who holds control*. That notion is the contribution. See §5. |
| D10 | Single process, files on disk | Capabilities are files, runs are directories. No queue, no worker pool, no cluster. |

The entire runtime dependency list is four packages: `playwright`, `zod`,
`@anthropic-ai/sdk` (in `discovery` only, so that I1 is a property of the
dependency graph), and `express` (in the fixture application only). There is no
web framework, no state-machine library, no WebSocket library, and no OPA. Each
was considered; each would have been a way to make the interesting 200 lines
harder to find.

---

## Artifact schema

The artifact is `packages/contracts/src/capability.ts`; a compiled one is in
[`capabilities/`](capabilities). It is three documents at once, and the design
tension is that all three have to be true of the same file:

1. **A tool contract** an agent can call. `inputs` and `outputs` are stored as
   literal JSON Schema — as *data*, not as zod — so the artifact does not depend
   on our validation library to be understood. `toToolDefinition()` projects it
   into the shape a model expects, carrying `readOnly`, `destructive` and
   `unattended` hints derived from the steps rather than asserted by hand.
2. **A reviewable document.** Every step carries the `intent` the model gave for
   it, in prose. A reviewer reads intents, not selectors.
3. **An executable plan.** Steps, checkpoints, recovery rules, business outcomes.

```jsonc
{
  "id": "member.read_savings_balance",
  "version": "1.0.0",
  "surface":  { "kind": "legacy-web", "application": "northgate-core-admin",
                "entryPoint": "/admin/index.htm" },
  "inputs":   { /* JSON Schema */ },
  "outputs":  { /* JSON Schema */ },
  "classification": { "memberId": "identifier" },     // drives redaction, per §6
  "steps": [{
    "id": "s1",
    "intent": "Member Search is the natural starting point to look up a member…",
    "action": { "type": "click" },
    "target": {
      "expectedRole": "link",
      "expectedName": "Member Search",
      "candidates": [                                  // ordered, independent
        { "strategy": "role-name",       "value": "link:Member Search",     "confidence": 0.9 },
        { "strategy": "css",             "value": "a[href=\"/admin/search.htm\"]" },
        { "strategy": "robula-xpath",    "value": "//a[@href=\"/admin/search.htm\"]" },
        { "strategy": "structural-path", "value": "table[2]/row[1]/cell[1]/link[1]" },
        { "strategy": "viewport-coords", "value": "0.2738,0.0381" }
      ]
    },
    "checkpoint": { "assert": "role-name-present", "value": "textbox:Member ID",
                    "timeoutMs": 10000 },
    "recover": [{ "on": "transient_load", "do": "wait_retry", "maxAttempts": 2 }]
  }],
  "businessOutcomes": [{ "code": "MEMBER_NOT_FOUND", "retryable": true, … }],
  "tenantOverrides":  { "tenant-b": { /* sparse */ } },
  "provenance": { "discoveredBy": "k3", "traceRef": "evidence/discovery-…/trace.jsonl",
                  "humanEdits": [ … ] },
  "approval":   { "state": "review" }
}
```

### The parts that carry weight

**The candidate bundle (D7).** Nine strategies, ordered from most to least
durable — `automation-id`, `role-name`, `label-text`, `container-scoped-text`,
`text`, `robula-xpath`, `css`, `structural-path`, `viewport-coords`. They are
harvested *before* the action, because one click can replace the whole document
and with it every fact about the element that was clicked. At replay time all of
them are resolved and their answers compared: agreement is a number, and a bundle
whose members disagree is a **harder** failure than one that resolves nothing,
because acting on the plurality winner means acting on the wrong control. The
system never guesses which selector was right.

**`checkpoint` is not an assertion for tests.** It is the definition of "did this
step actually happen", and it is what makes resumption possible at all: after a
takeover or a re-authentication, the system does not resume at the step index it
stopped on, it walks the checkpoints and resumes at the first one that is not yet
true (I7). The screen is the authority on where we are; the cursor is only a
memory of where we were.

**`businessOutcomes` are part of the contract, not error handling.** They are
declared, with a code, a retryable flag, and the surface condition that
recognises them. This is what makes I2 enforceable rather than aspirational.

**`classification` per input.** Declaring that `memberId` is an `identifier` is
what lets the redactor do exact-match removal of the actual value this run was
handed, rather than relying on a regex to guess it back out of a log. Most of the
strength of §6 comes from this one field.

**Cross-field consistency lives in `superRefine`, not in a linter (I9).** A step
reading an undeclared input, a success condition naming a checkpoint nobody
emits, a declared output no step produces — all rejected by `capability.parse()`,
for every caller. We had shipped one such rule as a script, and it had been
silently broken for its entire life. Rules that only fire when somebody remembers
to run them are documentation.

**Approval state is in the artifact.** `draft → review → approved`. An unattended
agent may only invoke `approved`; a human testing a capability passes
`requireApproved: false`. That is a policy decision the artifact carries with it
rather than a deployment convention, and it is why `--as-agent` on the
checked-in artifact returns `POLICY_DENIED`.

---

## Determinism & error handling

### Determinism

Replay calls no model. This is enforced three ways rather than intended one way:

- `packages/replay` has no model SDK in its dependency graph, so a replay that
  tried to consult one would fail to resolve rather than merely break a rule (I1).
- A test in `packages/replay/test/replay.test.mjs` greps that package's own
  manifest for `/anthropic|openai|langchain|@ai-sdk/i` and fails if one appears.
- `ReplayStats.llmCalls` is typed `z.literal(0)`. A run that counted one could
  not be serialised.

The claim is checked as a number, not asserted:

```
$ node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"12345"}' --repeat 5
deterministic: 5 runs produced 1 distinct result digest (76b253d0312756f9)
```

The digest covers the result arm, the outputs, the step ids and their
resolutions, and the failure class if there is one. It deliberately excludes
timings and run ids — a determinism check that compared wall-clock durations
would be a flake generator wearing an invariant's clothes.

### The result contract

```ts
type ReplayResult =
  | { kind: 'success';   outputs }
  | { kind: 'outcome';   code; retryable; message }   // declared, expected, exit 0
  | { kind: 'failure';   failure: { class; stepId; expected; observed; detail } }
  | { kind: 'escalated'; interventionId; reason; resumeFrom }
```

**I2 is the point of the union.** "No such member" is a *successful invocation
that returned a different answer*. It exits `0`. A pipeline that treated
`MEMBER_NOT_FOUND` as a broken automation would page somebody at 3am because a
member id was mistyped. This is, per the brief's own glossary, the most common
design mistake in this problem, and the shape of the type is what prevents it —
the `failure` arm has no `outputs` field, so the two cannot be conflated by a
careless caller.

Failure is classified into eleven mutually exclusive classes
(`CHECKPOINT_FAILED`, `LOCATOR_UNRESOLVED`, `LOCATOR_DISAGREEMENT`,
`LOCATOR_AMBIGUOUS`, `POLICY_DENIED`, `STEP_TIMEOUT`, `SURFACE_ERROR`,
`INPUT_INVALID`, `OUTPUT_EXTRACTION_FAILED`, `SESSION_UNRECOVERABLE`,
`INTERNAL_ERROR`). The taxonomy is `switch`ed without a `default`, so adding a
class breaks the build everywhere it must be handled.

### Recovery, without a model

Five recoverable conditions (`transient_load`, `unexpected_dialog`,
`stale_element`, `session_expired`, `navigation_lost`) map to recovery actions
declared per step in the artifact, with a bounded attempt count. Two are
implemented: `wait_retry` and `dismiss_dialog`. A recovery is an action like any
other and goes through the policy engine (I4) — which is why the dialog is
*dismissed* and never accepted: accepting means answering "yes" to a question
nobody read.

Session death is handled outside the per-step rules, by a configurable probe that
looks for a control rather than an error message — "Your session has ended" is
prose a localised build changes, an Operator ID field on screen means signed-out
in any language. Re-authentication is attempted **exactly once**, on the same
live session, and then the run fails. Retrying a sign-on in a loop is how a
lockout happens.

### Verified against the live application

The fixture ships six injectable faults so every arm can be produced on demand
rather than described:

| input | what the application does | result |
|---|---|---|
| `12345` | nothing unusual | `success` |
| `00000` | "No records matched your search" | `outcome MEMBER_NOT_FOUND` (retryable, exit 0) |
| `99999` | "You are not authorized to view this record" | `outcome PERMISSION_DENIED` (exit 0) |
| `77777` | throws a `confirm()` dialog mid-flow | `success`, dialog dismissed, step retried |
| `88888` | responds seconds late | `success`, waited out on the checkpoint budget |
| `66666` | drops the session back to sign-on | `failure SESSION_UNRECOVERABLE` after one re-auth |
| `abc` | never reaches the application | `failure INPUT_INVALID`, before the browser moves |
| `--as-agent` | — | `failure POLICY_DENIED` — the artifact is still in review |
| drifted artifact | control renamed | `escalated`, then `success` after a human takeover |

One of these was a real bug found by writing the test. The `wait_retry` recovery
never fired, and the reason was a `waitForLoadState` in the driver that had
inherited Playwright's 30-second default. A slow response was being absorbed
*inside* the action, which sounds harmless and is not: it put a half-minute wait
on a code path no checkpoint budget governed, and it made the engine's own
recovery unreachable because the slow load had already finished by the time
anything asked about it. Bounding it to 300ms fixed both; the run against member
77777 went from 30.4s to 0.7s. A fixed wait in a driver should never be allowed
to decide how patient a run is.

---

## Heterogeneity & multi-tenant

Two axes of variation, handled differently on purpose.

**Across applications** — the `SurfaceDriver` seam (I6). The artifact names a
`surface.kind`; nothing in `packages/contracts` outside the locator strategy enum
knows what a DOM is. A desktop driver would implement `observe`, `resolve`,
`perform`, `check` against UI Automation and the same artifact format would
describe a Win32 form. This is designed and not built — see §7.

**Across deployments of the same product** — `tenantOverrides`, sparse.

The realistic case in a bank is not two different applications; it is the same
vendor product deployed twice, where one tenant re-skinned the CSS, moved a
button and renamed a field. Copying the capability per tenant would be the
obvious move and is the wrong one: five copies means five places to fix the next
vendor upgrade, and no way to tell which differences are real.

So an override is a *sparse patch* over the base artifact — entry point, and per
step id, a replacement target or action — and everything unstated is inherited.
`applyTenantOverride` is a pure function; resolving happens identically in the
CLI and inside the engine, and reading the file twice is cheaper than a seam that
lets the two disagree about which application they are talking to.

The system also reports a **drift score**: the fraction of steps a tenant
overrides. It is not decoration. A tenant at 0.25 has a deployment quirk; a
tenant at 0.8 is running a different application and should have its own
capability, and the number says so before somebody discovers it during an
incident. `npm run validate` prints it per tenant with a threshold warning.

Demonstrated, not asserted: `apps/legacy-app` serves a second deployment at
`/tenant-b` with a different skin, a moved control and a renamed field, and

```bash
node scripts/replay.mjs member.read_savings_balance --tenant tenant-b --params '{"memberId":"67890"}'
```

runs the *same* checked-in artifact against it, with one overridden step out of
four (drift 0.25).

---

## Escalation & handoff

The brief's hardest requirement, and the one most easily reduced to a TODO: when
automation gets stuck, a human takes over — **the same live session, not a fresh
one** — and then hands it back mid-flow.

### The control lease

Live-view browser tooling exists and is good; the reference implementation read
for this (`steel-browser`, MIT) is about 200 lines of CDP. What none of it has is
a notion of *who holds control*: the socket is open, and anyone attached can type
into the session at any moment, including while automation is mid-step.

The contribution here is the `ControlLease`, and its rules are the interesting
part:

```
automation ──cede──▶ none ──claim──▶ operator ──handBack──▶ automation
                      ▲                   │
                      └────── expiry ─────┘
```

- **Control always passes through `none`.** There is never an instant when both
  automation and a person could act. That gap is the whole difference between
  this and a live-view debugger.
- **A lease is never stolen.** There is no `takeControl`. The registry's method
  list is asserted in a test, so a `takeControl` added later fails the build.
- **An expired operator lease lands on `none`, never back on `automation`.** This
  is the single most important rule in the file. An operator who shut their laptop
  mid-takeover left the session in a state nobody has looked at, and resuming
  automation into it is exactly how an unattended irreversible action happens.
  The run is abandoned and a person is told.
- **Expiry is evaluated on read, not on a timer.** A timer is a second answer to
  "who holds this", and it can be missed, paused by a debugger, or fire after the
  process has moved on.
- **Nothing in the handoff package closes a session.** `pause()` on the driver
  sets a flag and makes no browser call at all. The page, its cookies and its
  half-filled form stay exactly as they are (I7).

### The console

`GET /` serves one page with no build step. Frames go out over **Server-Sent
Events**, input comes back over **POST** — deliberately not a WebSocket. The
traffic is not symmetric: frames are a one-way stream, which is what SSE is for
and is built into `node:http`; and input is a request that can *fail* — refused
by the lease, expired token, session gone — and a 409 with a reason is a better
shape for that than a message dropped into a socket with no notion of a reply.
The side effect is that the console has no npm dependency and is drivable by
`fetch`, which is why its lease enforcement is tested without a browser at all.

The link in the escalation message is a **credential**: a signed, short-lived
HMAC token naming the session and the intervention. It is checked once for
everything under `/api/`, so a new endpoint cannot forget it. A token minted for
another session returns 410, not 200 — an unguessable string would stop guessing
but would not stop reuse.

**Every operator input is checked against the lease before dispatch**, which is
I4 and not a different rule: a click on a live back-office session is an action,
and it does not skip the check because a person made it. What the lease adds
beyond the policy engine is *exclusivity*.

### Why CDP input events rather than a video

A screen share would let a person watch. Injecting `Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent` into the same CDP session lets them *act*, on the exact
page automation was looking at, with no second browser, no VNC server and no
copy of the session's cookies anywhere else. It also makes the takeover
**recordable as structured events** rather than as pixels — which is what makes
the audit record below possible at all. Coordinates cross the wire normalised to
`[0,1]`, because the operator's window is not the session's viewport and pixels
from one mean nothing in the other.

### What is written down

An end-to-end takeover is committed under
[`evidence/handoff-*/`](evidence) — produced by drifting one step of the real
artifact, running it, opening the console in a browser, clicking the renamed
control by hand, and pressing *Hand back & resume*:

```jsonc
// handoff.json
{ "operatorId": "operator-1",
  "startedAt": "…", "endedAt": "…",
  "inputEvents": [ { "at": "…", "kind": "mouse", "detail": "down",
                     "x": 0.038, "y": 0.038, "text": null }, … ],
  "observationBefore": "dee4fa4e97f5f9ad",
  "observationAfter":  "2d8d32f53b7d078d",
  "disposition": "resume",
  "note": "the nav item is called Member Search, not Member Lookup — clicked it by hand" }
```

The before/after accessibility digests are the auditable answer to "what changed
while a human had the keyboard" — the question an auditor actually asks, and the
one a screen recording cannot answer without somebody sitting and watching it.

Keystroke *content* goes through the redactor on the way in (§6). An operator
taking over a stuck sign-on will type a password, and this is precisely the sink
I3 exists for: we record **that** they typed into a field, never what.

Then the run continues:

```
escalated  locator_unresolved
  waiting for an operator…
  control returned to automation; resuming

success  {"savingsBalance":"$4,231.08"}
         3/4 steps · 0 recoveries · 0 llm calls · 0.3s
```

Three of four steps, and zero model calls. The step the human performed was not
performed again, because resumption walks checkpoints rather than counting steps
(I7) — and nothing consulted a model to recover, because the recovery was a
person.

A deployment with nowhere to escalate to still gets a usable answer: the same run
with `--no-handoff` degrades to `failure LOCATOR_UNRESOLVED`, with the escalation
reason mapped into the failure class rather than flattened into a generic error.

---

## Safety

Three layers, all deterministic. No LLM is used as a guardrail anywhere: an LLM
judge is itself prompt-injectable, and it cannot reason about "irreversible" as a
structural fact about an action.

### 1. Allowlist, default-deny (I4)

`policy.json` declares allowed origins, allowed path prefixes, the permitted
action vocabulary, a per-run step ceiling, and deny patterns. Every action is
evaluated before execution — `evaluate(principal, action, context) → allow | deny
| require_confirmation` — **in discovery and in replay, with no bypass path**. In
discovery a denial is fed back to the model as the next turn's observation so it
re-plans; in replay a denial is a hard failure.

The shape is borrowed from OPA's `input + policy → decision`. OPA itself is not:
a JSON document and ~200 lines of evaluation is the whole requirement, and Rego
would be a dependency carried to look like rigour.

That this is real rather than decorative has a small proof: the first version of
the replay test suite loaded the shipped policy unchanged, and all 13 browser
tests came back `POLICY_DENIED` — because the tests run on `127.0.0.1:8202` and
the allowlist names `localhost:8080`. That was the allowlist working.

### 2. Risk tiers

- `safe` (read, navigate, fill without submitting) — allowed.
- `mutating` (submit, change state) — requires confirmation in discovery;
  in replay it is governed by the artifact's approval state.
- `irreversible` (transfer, delete, send) — **always blocked**, escalated to a
  person.

**I8 is enforced by the type, not by a default.** The policy schema is
`z.enum(['confirm', 'deny'])` for the irreversible tier, so `irreversible:
"allow"` is *unrepresentable* — there is no configuration, flag or environment
variable that turns it on. This is regulated financial data with no undo; one
extra human is cheaper than one wrong transfer.

### 3. Redaction at three sinks (I3)

Design borrowed from Presidio: **detection is separated from redaction**, so the
audit log can record "found `FINANCIAL_ACCOUNT`, confidence 0.9, 4 occurrences,
sink `screenshot`" without recording the number. Every write to an artifact, a
log, a prompt, or a screenshot passes through it.

Two mechanisms, with very different reliability, and the strong one is the one
usually missing:

1. **Known values** — exact-match removal of the parameter values this run was
   actually handed, plus credentials read from the environment. We know `memberId`
   is `12345` because the caller said so; no pattern has to guess. This is free
   only because the artifact declares its parameters and their classifications
   (§2).
2. **Recognizers** — regexes for what we were not told about (`CREDENTIAL`,
   `BEARER_TOKEN`, `US_SSN`, `PAYMENT_CARD` with Luhn, `FINANCIAL_ACCOUNT`,
   `MONEY`, `EMAIL`, `PHONE`, `PERSON_NAME`, `MEMBER_ID`). A backstop, not the
   design.

The trace scrub is a **structure-agnostic walk** over every string in a parsed
event, not a per-field list. A per-field list passes a test that feeds it the
fields it knows about, and leaks the first time somebody adds an event type —
an omission invisible until it is an incident. Events are parsed *after*
scrubbing, so the redactor cannot quietly produce something that no longer
satisfies the trace schema.

**Screenshots are blacked out before they reach disk**, using accessibility
bounding boxes rather than OCR: we already know which node holds a balance, so
classifying the *text* and painting its *box* is both cheaper and exact.

```jsonc
// evidence/replay-…/redactions.json — from the committed run
[ { "entity": "SCREEN_FINANCIAL", "classification": "financial",
    "confidence": 0.85, "sink": "screenshot", "count": 4 },
  { "entity": "SCREEN_PII", "classification": "pii",
    "confidence": 0.6, "sink": "screenshot", "count": 1 } ]
```

That file was empty until late in the build, and the emptiness was a genuine
defect rather than a cosmetic one: the driver was painting five black boxes and
telling nobody, so the run's safety summary read `[]` while its evidence was
covered in redactions. An audit summary that under-reports its most visible sink
is worse than having none. The screenshot sink now reports what it painted, in
the same value-free shape as the text sinks.

Credentials are read from the environment only, and the schema refuses to store a
parameter classified `secret` at all.

One consequence is worth stating because it looks like a bug the first time you
see it. A successful run returns the balance to its caller and writes
`{"savingsBalance": "[REDACTED:MONEY]"}` into `result.json`. That asymmetry is
the design: the answer is the product and belongs in the caller's hands; the
evidence directory is a permanent record on somebody's disk and has no reason to
keep a member's money in it.

### Known limits

Stated because the failure modes matter more than the feature list:

- **Regex redaction misses.** `PERSON_NAME` recognises the vendor's record format
  (`Surname, Given`) and has a measured false positive on `Verdana, Arial` in a
  CSS font stack; a name in free prose is not detected at all, and there is a test
  that asserts this limitation rather than hiding it. The known-value path is the
  one to trust.
- **An allowlist does not stop a permitted-but-wrong action.** Clicking the right
  kind of button on the wrong member is inside the policy. Checkpoints and the
  approval workflow are the mitigations, not the policy engine.
- **Screenshot blackout depends on box accuracy** and covers nothing baked into
  an image. There is no OCR pass.
- **The console link is a bearer token in a URL.** It is signed and short-lived,
  which bounds the exposure without eliminating it. Real deployment puts operator
  identity behind SSO — see §7.

---

## Cuts

Every deliberate omission, with the reason. An undocumented stub is worse than a
missing feature.

**Stretch goals taken**

The brief says pick at most one or two. Three are here, and they are grouped
rather than counted separately because they are one idea — *an artifact you can
trust unattended* — approached from three sides. None of them is a feature bolted
on for credit; each closes a hole the core would otherwise have.

- **Confidence & approval.** `capabilities/.stability.json` accumulates
  runs/successes per capability version, and `ReplayRequest.requireApproved`
  gates unattended invocation on `draft → approved`. The CLI defaults it *off*
  because its caller is a person testing before approving; `--as-agent` restores
  the agent's rules and shows the refusal (`POLICY_DENIED`, no run directory).
  Without this, "reviewable artifact" means a human read it once and nothing
  enforced that.
- **Multi-run stability.** `--repeat N` reports the number of distinct result
  digests across N runs. Five runs, one digest, is the determinism claim stated
  as a measurement rather than as an adjective. It shares the counters above.
- **Cross-tenant reuse.** One artifact, a sparse per-tenant override, and a
  second deployment of the same vendor product: `--tenant tenant-b` against the
  checked-in capability, evidenced. This is §4's argument executed rather than
  described, which is the difference between a design story and a claim.

**Not built, by design**

- **Desktop `SurfaceDriver`.** The seam is real and the contracts are free of
  web types, but only the Playwright implementation exists. Two drivers would
  have proved the seam; one driver plus an interface that could not express a
  `Page` if it tried is what the time allowed.
- **A queue, workers, or any scaling plumbing.** `raise()` writes a file and
  prints a URL. In a real deployment that method becomes an enqueue to whatever
  the operations team already lives in. Naming the seam is more useful than
  building a worse ServiceNow.
- **Operator authentication, multi-operator scheduling, ticketing.** The console
  authenticates a *link*, not a person. `operatorId` is typed in by the operator
  and believed. Real deployment puts SSO in front and takes the identity from
  there; nothing in the lease design changes when it does.
- **A durable lease store.** `LeaseRegistry` is in-memory and single-process,
  which is correct for D10 and wrong for a real deployment, where it needs a
  compare-and-set against the run store so two console processes cannot both
  believe they granted control.
- **`scroll_into_view` and `reload_and_resume` recovery actions.** Declared in
  the schema and left unimplemented, with the `switch` kept total so the compiler
  names them. `scroll_into_view` addresses a *resolution* problem and would have
  to run before the element is found rather than after; `reload_and_resume` on a
  legacy application means re-POSTing whatever got us here, which is a decision
  about idempotency that this system has no basis to make.
- **LLM-assisted recovery.** Considered and rejected: it would put a model back
  on the production path and make replay non-deterministic exactly when it
  matters most. A human is the fallback.
- **OCR redaction.** Bounding-box blackout only.

**Simplified**

- **The operator console UI.** One HTML file, one CSS file, one script, no
  framework. The brief permits mocking it; the mechanism underneath is not
  mocked. Five real bugs in it were found by *using* it, which is the argument
  for having built it rather than stubbed it — hidden controls that CSS was
  un-hiding, a five-second poll that blanked the canvas by reassigning
  `canvas.width`, an operator locked out of their own session by pressing F5, a
  reconnecting console that got a permanently blank rectangle because a 2003
  frameset never repaints, and a lease badge that went on claiming the operator
  held a session they had already handed back. The last two are covered by
  tests.

  The sixth was not cosmetic and was not in the console: `POST /api/input`
  checked that *an* operator held the lease, never *which* one. The console URL
  is a bearer credential and gets forwarded, so a second person with the link
  could type into a session they had not claimed — and their inputs were filed
  under the holder's name in the audit trail. The lease's whole claim is that
  control has one holder; an input path that asks only whether somebody holds it
  assumes that claim instead of enforcing it. Fixed, with two regression tests.
  It is the clearest example of the general hazard in this design: the state
  machine is only as real as its least careful entry point.
- **The audit record keeps every mouse move.** 423 of the 440 recorded events in
  the committed takeover are `mousemove`. They are coalesced to one per animation
  frame already; dropping or sampling them would make the record readable at the
  cost of the trajectory. Kept, because completeness is the property being
  claimed, but the volume is a real cost.
- **`positionHint` and `viewport-coords` are recorded but never parsed at
  runtime.** They are the last-resort tier of the candidate bundle and would need
  a viewport-relative resolver the driver does not have. They are in the artifact
  because throwing away the information at harvest time is irreversible; using
  them is not implemented.
- **`NAV_GRACE_MS = 300`.** A perception ceiling on how long the driver will hold
  the door open for a navigation an action started. It is not a wait budget —
  those belong to checkpoints — but it is still a constant chosen by measurement
  rather than derived.
- **The discovery prompt is not a conversation.** Each turn sends the goal, the
  parameters, a prose history and the *current* tree only. Replaying old trees
  would show the model a dozen plausible refs, all but one dead, and invite it to
  act on the wrong one — a failure that looks like a hallucination but is the
  harness's fault. The cost is prompt caching across turns, which for a 25-step
  run is a few cents in exchange for making a class of error unrepresentable.
- **Compiled recovery rules are priors, not observations.** The compiler attaches
  `wait_retry` and `dismiss_dialog` rules based on action type, because a single
  discovery run does not observe a flaky load. They are a starting point for the
  reviewer, and the artifact records that a human edited them.
- **The I1 dependency check is a test, not a CI job.** It greps the replay
  package's own manifest for model SDKs. In CI it should also be a
  `npm ls`-based gate on the transitive graph.

**Known rough edges**

- `AGENTS.md` §4 lists `packages/store` and `packages/catalog` as separate
  packages; both ended up inside `contracts` (`store.ts`, `catalog.ts`) because
  neither had a dependency the contract layer did not already have. The document
  predates the code.
- The MCP-server stretch goal (exposing the capability catalog as
  `tools/list` + `tools/call`) was not attempted. `toToolDefinition()` exists and
  is tested, so the projection is done; the server is not.
