# Changelog

Versions follow `adversary/.claude-plugin/plugin.json` (keep `.cursor-plugin/plugin.json` in step).
Bump the version on every change you want installed users to receive: Claude Code only updates a plugin when its version changes.

## Unreleased
- Docs: README rewritten for first-time users (install, first run, spec writing, reading the report, troubleshooting, limits).

## 0.1.0 (prototype)
- `/adversary:loop`, `/adversary:status`, `/adversary:abort`.
- Builder (main session) + read-only `adversary-reviewer` and `adversary-triage` subagents.
- Node controller: iteration cap, validate gate, stagnation halt, evidence-checked findings, computed ship decision, Stop hook, report.
- Cursor manifest and `install-cursor.mjs` (untested inside Cursor).
- Verified: 12 unit tests; one live clean-path run. Not yet verified live: the findings, triage and patch-plan branch.

## Next (ideas, unscheduled)
- Foreign-family reviewer (Codex/Gemini CLI) behind the `review` step.
- Live run on a harder spec to exercise triage and patch plans.
- Confirm Cursor install path; add a Cursor-side keep-going hook.
