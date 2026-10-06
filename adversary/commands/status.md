---
name: status
description: Show the current adversary loop phase, iteration and next step.
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/adversary.mjs" status` and summarize the result in two or three lines: phase, iteration out of max, validate gate, and findings per iteration so far. If a run is still active, offer to continue by following its `instruction`.
