# Adversary: a spec goes in, reviewed code comes out

Adversary is a plugin for **Claude Code** (and Cursor) that builds code from a spec sheet and then **attacks its own work** before calling it done.

You give it a spec. One agent writes the code. A second agent, which has no idea how the first one thought, tries to find bugs. A third checks which of those bugs are real. The builder fixes only the real ones. This repeats up to a number of rounds you choose, and stops as soon as nothing serious is left.

You end up with working code, tests, and a short report that tells you what was found, what was fixed, and what (if anything) is still open.

## Contents

- [Is this for me?](#is-this-for-me)
- [How it works](#how-it-works)
- [Install](#install)
- [Your first run (5 minutes)](#your-first-run-5-minutes)
- [Commands](#commands)
- [Writing a spec that works well](#writing-a-spec-that-works-well)
- [What you'll see during a run](#what-youll-see-during-a-run)
- [Reading the report](#reading-the-report)
- [Options and tips](#options-and-tips)
- [Troubleshooting](#troubleshooting)
- [Limits (please read)](#limits-please-read)
- [Updating and uninstalling](#updating-and-uninstalling)
- [For contributors](#for-contributors)

## Is this for me?

Use it when you can describe what you want in writing and want a second opinion built into the process: a new function or module, an API endpoint, a bug fix with clear expected behavior, a feature with defined rules (money, dates, permissions, validation).

It is **not** a good fit for vague asks ("make the app nicer"), pure design work, or huge multi-service changes in one go. Break those into several specs.

## How it works

```
        ┌───────────────────────────────────────────────────────────────┐
        ▼                                                               │
 spec ─▶ 1. BUILD ─▶ 2. CHECK ─▶ 3. REVIEW ─▶ 4. TRIAGE ─▶ serious bugs left?
         write code   run your    independent  independent       │ yes: back to 1 with a fix list
         and tests    tests/lint  bug hunter   judge            │ no:  ──▶ DONE, write report
```

1. **Build.** Your normal Claude Code session writes the code and tests from the spec.
2. **Check.** The plugin runs your project's lint and tests. If they fail, the failure goes straight back to the builder. The reviewer is not bothered with code that doesn't even run.
3. **Review.** A separate, **read-only** agent reads the spec and the changed files and reports defects. It can't edit anything, and it never sees the builder's notes or reasoning, so it can't be talked into agreeing.
4. **Triage.** Another read-only agent opens each reported bug in the real code and decides whether it is real, over-rated, a duplicate, or nonsense. Only real, serious ones go back to the builder as a numbered fix list.

Then it loops, or stops.

**What keeps it honest.** The rules that matter are enforced by a small script, not left to the AI's judgment:

| Rule | What it prevents |
|---|---|
| Hard cap on rounds (default 5, max 10) | Endless loops and runaway cost |
| Tests/lint must pass before review | Wasting review effort on broken code |
| A reviewer's finding is thrown out automatically unless the code it quotes really exists near the line it cites | Invented bugs sending the builder to "fix" correct code |
| "Done" is calculated from the severity of what's left, never taken from an AI's say-so | A judge waving things through |
| The judge can lower a severity but never raise it, and can't dismiss a Critical or High bug without pointing to code that proves it wrong | Quiet downgrading of real problems |
| Stops if the code stops changing, or flips back to an earlier version | Two agents undoing each other forever |

It stops for one of four reasons, all shown in the report: **clean** (nothing serious left), **cap reached**, **no progress**, or **tests keep failing**.

## Install

### Before you start

- **Node.js 18 or newer** installed (check with `node --version`). Claude Code and Cursor users almost always have it already.
- **Claude Code** or **Cursor**, already signed in. No separate API keys are needed.
- **Access to this repo.** It is private, so your machine must be able to read it. The easiest way is [GitHub CLI](https://cli.github.com/): run `gh auth login` once.
- A **project folder** to work in, ideally a git repository.

### Claude Code

Inside Claude Code, run these two commands:

```
/plugin marketplace add AT80-1/adversary-loop
/plugin install adversary@outback-adversary
```

Restart Claude Code (or run `/reload-plugins`). Type `/adversary:` and you should see `loop`, `status` and `abort` in the list. If you do, you're set.

To try it **without installing**, clone this repo somewhere, then start Claude Code **from your own project folder** and point it at the plugin:

```
cd /path/to/your/project
claude --plugin-dir /path/to/adversary-loop/adversary
```

### Cursor

> Cursor support is included but **less tested** than Claude Code. See [Limits](#limits-please-read).

Cursor's documented plugin format is included in `adversary/.cursor-plugin/`. To try it in one project without publishing it, run this from a copy of this repo:

```
node adversary/scripts/install-cursor.mjs /path/to/your/project
```

This copies the commands, agents and script into `/path/to/your/project/.cursor/`. Then, in Cursor's agent chat, use `/loop` instead of `/adversary:loop`.

## Your first run (5 minutes)

**1. Save a spec.** In your project folder, create `spec.md`. Here's a small one to start with:

```markdown
# Split bill
Create `split.js` exporting `splitBill(totalCents, people)`.
- `totalCents` is a non-negative integer number of cents; `people` is a positive integer.
- Returns an array of `people` integers (cents) that sum EXACTLY to `totalCents`;
  shares differ by at most 1 cent, larger shares first.
- Throws a `RangeError` if `people` is not a positive integer or `totalCents`
  is not a non-negative integer.
- Include tests in `split.test.js` using `node:test`.
```

**2. Save your work.** The loop edits files in your project directly. Commit or stash what you have so you can see exactly what it changed (`git diff`) or throw it away.

**3. Start it.** In Claude Code, in that folder:

```
/adversary:loop spec.md --max 3
```

Using `--max 3` for a first try keeps it short and cheap.

**4. Let it run.** It works on its own and you don't need to answer questions. If Claude Code asks permission to edit files or run commands, approve. (To avoid repeated prompts, you can switch to "accept edits" mode first.)

**5. Read the result.** When it finishes, Claude summarizes the outcome and points to `.adversary/REPORT.md`. Review the code it wrote with `git diff`, and run your tests yourself as a final check.

## Commands

| Command (Claude Code) | What it does |
|---|---|
| `/adversary:loop <spec> [options]` | Start the loop on a spec file. |
| `/adversary:status` | Show which step it's on, which round, and what's been found so far. |
| `/adversary:abort` | Stop the loop now and write the report. |

(In Cursor, use `/loop`, `/status` and `/abort`.)

**Options for `/adversary:loop`:**

| Option | Meaning | Default |
|---|---|---|
| `--max N` | Maximum number of build → review rounds (1 to 10). | 5 |
| `--test-cmd "…"` | The command that proves the code works, e.g. `"npm test"` or `"pytest -q"`. | Auto-detected |

**Examples:**

```
/adversary:loop spec.md
/adversary:loop docs/payments-spec.md --max 3
/adversary:loop spec.md --test-cmd "pytest -q"
```

**No spec file?** You can paste the spec text into the command instead of a path. The plugin saves it to a file called `.adversary-incoming-spec.md` in your project for you.

**Auto-detected checks.** If you don't pass `--test-cmd`, the plugin looks for `lint`, `typecheck` and `test` scripts in `package.json`, and for a Python project (`pytest`). If it finds nothing, it tells you at the start. You can still go ahead, but see [Limits](#limits-please-read).

## Writing a spec that works well

The reviewer judges the code against your spec, so the spec is the most important input. A good spec makes the review sharper.

- **Say what must be true, not just what to build.** "Shares sum exactly to the total" gives the reviewer something to attack. "Split a bill fairly" does not.
- **List the error cases.** What should happen on bad input, missing data, duplicates, no permission?
- **Be precise about units and limits.** Cents or dollars, UTC or local time, maximum sizes, rounding rules.
- **Name the files and the tests** you expect, and the test framework.
- **State what is out of scope.** The reviewer is told not to report things your spec didn't ask for, so this saves noise.
- **One feature per spec.** Two or three small specs beat one big one.

A simple template:

```markdown
# <Feature name>
## Goal
One or two sentences.
## Behavior
- Rule 1 (inputs, outputs, exact values)
- Rule 2
## Errors
- When X happens, do Y
## Files and tests
- Create `path/file.ext`; tests in `path/file.test.ext` using <framework>
## Out of scope
- Z
```

## What you'll see during a run

Claude narrates each step briefly. A typical clean run looks like this:

1. It reads the spec and starts the run, mentioning which checks it will use (for example, `npm test --silent`).
2. It writes the code and tests, then runs the checks.
3. It hands the changed files to the reviewer (you'll see a subagent being used).
4. If the reviewer found nothing serious, it stops and summarizes. If it did, you'll see the triage step, then a second build round that applies the fix list, and so on.

Everything the loop records is kept in a folder called **`.adversary/`** in your project:

| File | Contents |
|---|---|
| `REPORT.md` | The final report. Start here. |
| `spec.md` | A copy of the spec this run used. |
| `patch-plan.md` | The current fix list for the builder (only present if a round needed fixes). |
| `iter-0/`, `iter-1/`, … | Per-round details: changed files, what the reviewer reported, what survived checking, and the triage decision. |
| `run.json` | Machine-readable run state. |

In a git repo the plugin hides `.adversary/` from `git status` automatically. Otherwise, add it to `.gitignore`.

## Reading the report

`.adversary/REPORT.md` starts with the outcome:

| Outcome | What it means | What to do |
|---|---|---|
| **clean_gate** | No serious (Critical or High) problems remain. | Review the diff and ship. |
| **max_iterations** | The round limit was reached with serious problems still open. They're listed. | Fix by hand, or run again with a higher `--max` or a sharper spec. |
| **stagnant_diff** | The code stopped changing, or went back to an earlier version. The agents were stuck. | Read the open items. The spec may be contradictory or unclear. |
| **validate_exhausted** | Your tests or lint failed three times in a row. | Run the tests yourself and read the failure. The spec or an existing test may conflict. |
| **aborted** | You stopped it. | n/a |

Below the outcome there's a table with one row per round (the numbers here are just an example):

```
| # | findings | evidence-verified | auto-rejected | accepted | blocking | ship |
|---|---|---|---|---|---|---|
| 0 | 3        | 2                 | 1             | 1        | 1        | false |
| 1 | 0        | 0                 | 0             | 0        | 0        | true  |
```

- **findings**: what the reviewer reported.
- **evidence-verified / auto-rejected**: how many cited real code, versus how many quoted code that doesn't exist (those are discarded before anyone acts on them).
- **accepted / blocking**: what the judge confirmed, and how many of those are Critical or High.
- **ship**: whether the loop was allowed to finish after that round.

The report also lists anything **still open**, **non-blocking** items (Medium or lower, which are noted but never hold up "done"), any **severity downgrades** (worth a quick look), and any **warnings**.

Severity levels: **Critical** (security hole, data loss, wrong money), **High** (broken rule, realistic race), **Medium** (real but narrow), **Low** (theoretical), **Nitpick** (style; ignored).

## Options and tips

- **Start small.** Use `--max 3` on a first run. Each round means one build and two review passes, so a larger cap costs more time and usage.
- **Be careful with existing code.** The loop edits real files. Work on a branch or with a clean working tree.
- **Add tests first.** A project with working tests gives the loop a much stronger safety net. With no tests, it can only rely on the reviewer.
- **For the best results**, run your main Claude Code session on a strong model (Opus). The reviewer and judge run on a different model tier (Sonnet) by design.
- **Stopping early.** Press Esc to interrupt, or run `/adversary:abort`.
- **Starting over.** `/adversary:loop` begins a fresh run and discards the previous `.adversary/` folder.

## Troubleshooting

| Problem | Fix |
|---|---|
| `/adversary:` commands don't appear | Run `/reload-plugins` or restart Claude Code. Check the plugin is listed under `/plugin`. |
| `Repository not found` when adding the marketplace | The repo is private. Run `gh auth login` on that machine, or ask for access to `AT80-1/adversary-loop`. |
| `node` is not recognized | Install Node.js 18 or newer and restart your terminal and Claude Code. |
| "A run is already in progress" | Run `/adversary:abort`, then start again. (Runs older than two hours are treated as stale.) |
| "No lint/test command detected" warning | Add a `test` script to `package.json`, or pass `--test-cmd "your command"`. |
| It stops with `stagnant_diff` on the first round | The builder made no change. The spec may already be satisfied, or may be too vague to act on. |
| The reviewer reports nothing on obviously weak code | Make the spec more specific about behavior and edge cases. A reviewer can only hold code to what the spec says. |
| It keeps asking for permission | Switch Claude Code to "accept edits" mode before starting. |
| It won't let Claude stop while a run is active | That's the safeguard that keeps the loop going. It releases after three attempts with no progress, or immediately on `/adversary:abort`. |
| Cursor stops partway through | Cursor has no keep-going safeguard yet. Tell it to run `status` and continue. |

## Limits (please read)

- **The reviewer is a different agent, not a different company's model.** It starts with a clean slate and its own instructions, which removes the "marking your own homework" problem, but it shares a model family with the builder and can share blind spots. Swapping in a reviewer from another vendor is a possible future upgrade.
- **Without tests, the loop is weaker.** Passing tests are the only automatic proof the code works. Always give it a check command.
- **It stops at "no serious bugs found", not "no bugs".** Medium and lower findings are reported but don't block. It is a strong extra pair of eyes, not a replacement for human review of anything critical (payments, security, safety).
- **Hitting the cap means unfinished.** The last fix list is not applied. The open problems are in the report.
- **Prototype.** The controlling script has automated tests, and a full run has been verified end to end on a simple spec. Runs where the reviewer finds real bugs and the loop has to fix them are covered by tests but have had less live use. Prompts will be tuned as real specs come in.
- **Cursor is less tested than Claude Code.** It works from the same files, but loading a plugin locally isn't something Cursor documents, so the installer above is a best-effort fallback.

## Updating and uninstalling

**Update** to the latest version:

```
/plugin marketplace update outback-adversary
```

See [CHANGELOG.md](CHANGELOG.md) for what changed. Each version is also tagged in git (`v0.1.0`, …).

**Uninstall:**

```
/plugin uninstall adversary@outback-adversary
/plugin marketplace remove outback-adversary
```

For Cursor, delete `.cursor/commands/{loop,status,abort}.md`, `.cursor/agents/adversary-*.md` and `.cursor/adversary/` from your project.

Run data lives only in each project's `.adversary/` folder. Delete it any time.

## For contributors

```
.claude-plugin/marketplace.json      marketplace entry (name: outback-adversary)
adversary/
  .claude-plugin/plugin.json         Claude Code manifest (version lives here)
  .cursor-plugin/plugin.json         Cursor manifest (keep version in step)
  commands/{loop,status,abort}.md    the slash commands
  agents/adversary-reviewer.md       read-only reviewer prompt
  agents/adversary-triage.md         read-only triage prompt
  hooks/hooks.json                   Stop hook that keeps a run going
  scripts/adversary.mjs              the controller (plain Node, no dependencies)
  scripts/adversary.test.mjs         tests for the controller
  scripts/install-cursor.mjs         project-level Cursor installer
```

Run the tests:

```
node --test adversary/scripts/adversary.test.mjs
```

Validate the manifests: `claude plugin validate .` and `claude plugin validate ./adversary`.

**Releasing a change:** edit, run the tests, bump `version` in both `plugin.json` files, add a line to `CHANGELOG.md`, commit, push, and tag (`git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`). Claude Code only offers an update when the version number changes.

**Design in one paragraph.** The AI agents do the creative work (build, review, judge). `scripts/adversary.mjs` owns everything that must be deterministic: the round counter, the test gate, stagnation detection, checking reviewer quotes against real files, and the ship decision. Every script call prints JSON with an `instruction` field, and the commands tell the main session to do exactly what it says. That is why the loop behaves the same regardless of how the model feels on a given day.
