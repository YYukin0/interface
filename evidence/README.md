# Evidence

One directory per run. Every file in here was written by the system, not by
hand, and everything reaching disk passed through the redactor first (I3) —
including the screenshots, which are blacked out using accessibility bounding
boxes before the PNG is handed to the writer.

```
manifest.json     what was run, against what, by which model (null for replay)
trace.jsonl       append-only structured events
result.json       the ReplayResult / DiscoveryResult
redactions.json   what redaction caught: entity, count, confidence, sink — never a value
screenshots/      redacted PNGs
snapshots/        redacted accessibility trees
recording.jsonl   discovery only: the compiler's input (I5 — this is not the artifact)
```

## What is here and what each run demonstrates

### The real discovery run

| Directory | |
|---|---|
| `discovery-2026-09-09T00-18-28-162Z-6998d7` | A genuine model-driven run against the live application: 6 model decisions, 4 actions, 5 policy evaluations, 10 redactions. `capabilities/member.read_savings_balance.capability.json` was compiled from this directory and points back at it via `provenance.traceRef`. |

### The same procedure, discovered by a different vendor's model

The system's central claim is that discovery is model-dependent and replay is
not. That is cheap to assert with one model and one run, so here it is with two
vendors.

| Directory | |
|---|---|
| `discovery-2026-09-09T20-50-27-008Z-c44469` | The same job, driven by **kimi-k2.7-code-highspeed** instead of Claude: 4 steps, 7 model calls, 6852 in / 1714 out, 19s. `manifest.json` names the model, which is the point of naming it. The artifact the compiler produced from this run is checked in beside its recording. |
| `replay-2026-09-09T20-57-44-453Z-6380af` | That artifact replayed with no model credentials in the environment at all: `success`, `0 llm calls`, digest **`ea7b7def38e646bb`** — byte-identical to the digest the Claude-discovered artifact produces for the same input. |

The two artifacts are not identical, and the ways they differ are the argument:

- The **prose differs**, as it should. Claude wrote "Member Search is the natural
  starting point to look up a member by their member number"; Kimi wrote "Open
  Member Search to look up the member by ID". Two models describing one screen.
- The **procedure is the same** — four steps, same order — and that is what
  survives compilation into something executable, which is why the digests match.
- Kimi's artifact declares **zero business outcomes** and sits at `draft`; the
  checked-in one declares two and sits at `review`. Neither model saw an error
  state, so the compiler raised `no_business_outcomes_declared` on both. On the
  checked-in artifact a human closed it. That gap *is* the review loop, and this
  pair is what it looks like before and after.

One caveat, because the run does not reproduce without it: Kimi enables extended
thinking unconditionally and its API rejects thinking alongside a required tool
choice, so this run needed `CUA_LLM_TOOL_CHOICE=auto`. With the default `any` it
returns HTTP 400 and discovery stops at step 0. Reproduce with:

```bash
CUA_LLM_API_KEY=… CUA_LLM_BASE_URL=https://api.moonshot.ai/anthropic \
CUA_LLM_MODEL=kimi-k2.7-code-highspeed CUA_LLM_TOOL_CHOICE=auto \
  node scripts/discover.mjs jobs/read-savings-balance.json
```

### Human takeover, end to end

| Directory | |
|---|---|
| `replay-2026-09-09T13-52-48-383Z-1d2f61` | `escalated locator_unresolved` — one step of the artifact was drifted (`scripts/drift.mjs`) so no locator candidate resolves. The session was **not** closed. |
| `handoff-iv-replay-…-1d2f61` | `intervention.json` (why a person was called) and `handoff.json` (who took it, every input event in normalised coordinates, the accessibility digest before and after, the note they left). |
| `replay-2026-09-09T13-54-32-342Z-6805a8` | The continuation after hand-back: `success`, **3/4 steps**, **0 llm calls**. The step the human performed by hand was not performed again — resumption walks checkpoints, not step indices (I7). |

### The result contract, one directory per arm

| Directory | Input | Result |
|---|---|---|
| `…14-02-31-592Z-27aeba` | `67890` | `success` |
| `…14-02-32-322Z-60f8c3` | `00000` | `outcome MEMBER_NOT_FOUND` (retryable) — a **successful invocation**, exit 0 |
| `…14-02-32-963Z-885725` | `99999` | `outcome PERMISSION_DENIED` — exit 0 |
| `…14-02-33-614Z-8f328a` | `77777` | `success` after an unexpected `confirm()` dialog was dismissed and the step retried |
| `…14-02-34-673Z-fea420` | `88888` | `success` after a deliberately slow response, waited out on the checkpoint's budget |
| `…14-02-41-653Z-8ca8d1` | `66666` | `failure SESSION_UNRECOVERABLE` — the app dropped us to sign-on; re-authentication is attempted exactly once |
| `…14-03-02-679Z-533728` | `67890`, `--tenant tenant-b` | `success` — the *same* artifact against a second deployment, via one sparse override |

### The determinism claim

| Directories | |
|---|---|
| `…14-02-02-923Z-786d9b` … `…14-02-04-236Z-2fad73` | Five runs of one artifact with one input. `--repeat 5` reports **1 distinct result digest** (`76b253d0312756f9`) across all five. |

### Not represented here, on purpose

`INPUT_INVALID` and `POLICY_DENIED` are rejected *before* a run directory is
opened, and the result says so rather than pretending otherwise:

```
failure  INPUT_INVALID
         observed  'memberId' does not match ^[0-9]{5}$
         evidence (no run directory: rejected before execution)
```

Nothing was executed, so there is nothing to file. Reproduce either with:

```bash
node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"abc"}'
node scripts/replay.mjs member.read_savings_balance --params '{"memberId":"12345"}' --as-agent
```
