---
name: loop
description: Run the adversarial build/review loop on a spec sheet. Usage - /adversary:loop <spec-file> [--max N] [--test-cmd "cmd"]
argument-hint: <spec-file> [--max 5] [--test-cmd "npm test"]
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Grep, Agent, Task
---

You are the **Builder** and the **orchestrator** of an adversarial loop. A spec goes in. You implement it. An independent read-only Reviewer attacks the result. An independent Triage judge decides which findings are real. You fix only what Triage accepts, and repeat until nothing Critical or High is left or the iteration cap is hit.

A controller script owns the rules: iteration cap, stagnation detection, the local validate gate, evidence-checking of reviewer findings, and the ship decision. **You do not decide when to stop. The script does.** Every script call prints JSON with an `instruction` field. Do exactly what it says.

Arguments: `$ARGUMENTS`

## Start

1. Find the spec file in the arguments. If the user pasted spec text instead of a path, save it with Write to `.adversary-incoming-spec.md` in the project root and use that. Read the spec once so you understand it.
2. Initialize (add `--max N` and/or `--test-cmd "..."` if the arguments contain them; default max is 5):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/adversary.mjs" init --spec <spec-file>
   ```

3. If the output has a `note` warning that no validate gate was detected, tell the user in one line and continue.

## Then loop by following each `instruction`

- **build**: implement the spec, or apply the patch plan, then run `checkpoint`. If validation fails, the instruction contains the raw tool output. Fix it and checkpoint again.
- **review**: dispatch the `adversary-reviewer` subagent. Give it **only** the three paths in the instruction. Never include a summary of your work, your reasoning, or what you think is fine. Its independence is the whole point. Write its JSON reply to the named file **verbatim**, then run the `review` command.
- **triage**: same, with `adversary-triage`.
- **halt**: the loop is over. Read `.adversary/REPORT.md` and give the user a short summary: outcome, iterations used, what is still open, anything the script flagged as a warning or downgrade.

## Rules

- Never read `.adversary/iter-*/review.*` or `triage.*` yourself, and never argue with Triage about a Critical or High item. Patch plan items are your instructions.
- Never edit `.adversary/` files by hand, except writing the reply files you are told to write.
- If a script call returns `"ok": false`, read the error and do what it says. For malformed subagent JSON, re-dispatch the same subagent once with the same three paths plus "reply with valid JSON only".
- Do not stop to ask the user questions between steps. The loop is autonomous.
