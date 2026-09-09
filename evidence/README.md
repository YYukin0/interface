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
