# Adversary: spec in, reviewed code out

A plugin for Claude Code (and Cursor) that turns a spec sheet into code through a bounded adversarial loop:

```
spec ─▶ BUILD ─▶ VALIDATE (lint/tests, no LLM) ─▶ REVIEW (independent, read-only) ─▶ TRIAGE (independent judge)
          ▲                                                                              │
          └────────── patch plan (only accepted findings) ◀── not shippable ─────────────┘
                                                              ship / cap / stagnation ─▶ REPORT
```

| Role | Who | Can do |
|---|---|---|
| Builder + orchestrator | your main session | everything it normally can |
| Reviewer | `adversary-reviewer` subagent | read files only. Never sees how the Builder worked |
| Triage | `adversary-triage` subagent | read files only. Verifies each finding against the code, writes the patch plan |
| Controller | `scripts/adversary.mjs` (plain Node, no dependencies) | owns every rule that must not be left to a model |

**What the controller enforces in code, not in prompts:**
- hard iteration cap (`--max`, default 5, max 10)
- validate gate (lint/typecheck/tests auto-detected, or `--test-cmd`). Failures go straight back to the Builder and the Reviewer is never called on broken code. 3 bounces halt the run
- stagnation: if the working tree is unchanged, or returns to an earlier state (ping-pong), the run halts
- reviewer findings are rejected automatically unless the quoted evidence really appears within 5 lines of `file:line`, so hallucinated bugs never reach the Builder
- the **ship decision is computed from severities**, not taken from a model. Triage may downgrade but never upgrade, and cannot drop a Critical/High without citing counter-evidence
- a Stop hook keeps Claude Code from quitting mid-loop (it releases after 3 stops with no progress, or on `/adversary:abort`)

Halt reasons: `clean_gate` (no accepted Critical/High left), `max_iterations`, `stagnant_diff`, `validate_exhausted`. Everything ends in `.adversary/REPORT.md`.

## Requirements
Node 18+ on the PATH (Claude Code and Cursor users almost always have it) and a project folder, ideally a git repo. No API keys beyond whatever Claude Code / Cursor already use.

## Install: Claude Code

From GitHub (the repo is private, so the machine needs git access to it, e.g. `gh auth login`):

```
/plugin marketplace add AT80-1/adversary-loop
/plugin install adversary@outback-adversary
```

To pick up a new version later: `/plugin marketplace update outback-adversary`. Or from a local clone: `/plugin marketplace add C:\path\to\clone`. Quick try without installing: `claude --plugin-dir C:\path\to\plugin\adversary`.

## Install: Cursor

Cursor's plugin format (`.cursor-plugin/plugin.json`, `agents/`, `commands/`) is included in `adversary/`, and Cursor documents it for marketplace publishing. For trying it in one project without publishing, run:

```
node adversary/scripts/install-cursor.mjs C:\path\to\your\project
```

This copies the commands, agents and controller into `<project>/.cursor/`. Then use `/loop spec.md` in Cursor's agent chat. The Stop-hook "keep going" safeguard is Claude Code only for now. In Cursor the orchestrator follows the same `instruction` output but nothing stops it from ending early.

## Use

```
/adversary:loop path\to\spec.md
/adversary:loop spec.md --max 3 --test-cmd "pytest -q"
/adversary:status
/adversary:abort
```

You can also paste the spec text instead of a path. Add `.adversary/` to `.gitignore` if the project isn't a git repo. In a git repo the plugin adds it to `.git/info/exclude` for you.

## Know the limits

- **Model diversity.** The Reviewer is a separate agent with a clean context and different instructions, on `model: sonnet`. That removes self-review bias, but not shared-family blind spots. For the strongest setup run your main session on Opus (Builder) and keep the Reviewer on a different tier. A foreign-family reviewer (Codex/Gemini CLI) is the natural next step. The controller already treats review output as untrusted JSON, so the swap is local to the `review` step.
- **No validate gate, weaker loop.** If no lint/test command is detected, the controller says so. Pass `--test-cmd`.
- **Cap reached = unfinished.** On `max_iterations` the last patch plan is not applied; open Critical/High items are listed in the report.
- Prototype status: the controller is covered by `node --test adversary/scripts/adversary.test.mjs`. The command and agent prompts need tuning on real customer specs.

## Files

```
.claude-plugin/marketplace.json
adversary/
  .claude-plugin/plugin.json   .cursor-plugin/plugin.json
  commands/{loop,status,abort}.md
  agents/{adversary-reviewer,adversary-triage}.md
  hooks/hooks.json             (Claude Code Stop hook)
  scripts/adversary.mjs        controller + stop-check
  scripts/adversary.test.mjs   scripts/install-cursor.mjs
```
