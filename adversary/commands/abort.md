---
name: abort
description: Stop the running adversary loop and write the report.
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/adversary.mjs" abort`, then show the user the path to `.adversary/REPORT.md` and one line on what was left open. Do not continue the loop.
