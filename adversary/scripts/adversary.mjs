#!/usr/bin/env node
/**
 * Adversary loop controller. Zero dependencies, Node >= 18.
 *
 * The LLM agents do the creative work (build, review, triage). This script owns
 * everything that must be deterministic: the iteration cap, stagnation
 * detection, the local validate gate, evidence-checking review findings
 * against real files, and the ship decision. State lives in <project>/.adversary/.
 *
 *   init --spec <file> [--max N] [--test-cmd "<cmd>"] [--force]
 *   checkpoint                 fingerprint tree + run validate gate  (phase: build)
 *   review --file <json>       verify reviewer findings              (phase: review)
 *   triage --file <json>       apply triage, decide ship/continue    (phase: triage)
 *   status | report | abort | stop-check
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SEVERITIES = ["nitpick", "low", "medium", "high", "critical"];
export const REJECT_REASONS = [
  "hallucination",
  "duplicate",
  "nitpick",
  "out_of_spec",
  "already_fixed",
  "malformed",
];
const BLOCKING = new Set(["high", "critical"]);
const MAX_VALIDATE_BOUNCES = 3;
const OUT_CAP = 8192;
const EVIDENCE_WINDOW = 5;
const STALE_MS = 2 * 60 * 60 * 1000;
const MAX_STOP_BLOCKS = 3;
const SELF = process.argv[1] ? path.resolve(process.argv[1]) : "adversary.mjs";
const CLI = `node "${SELF}"`;

// ---------- small helpers ----------
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rank = (sev) => SEVERITIES.indexOf(sev);
export const isBlocking = (sev) => BLOCKING.has(sev);

export function clip(s, n = OUT_CAP) {
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  return `${s.slice(0, half)}\n...[truncated]...\n${s.slice(-half)}`;
}

const dirs = (root) => {
  const dir = path.join(root, ".adversary");
  return {
    dir,
    run: path.join(dir, "run.json"),
    baseline: path.join(dir, "baseline.json"),
    spec: path.join(dir, "spec.md"),
    plan: path.join(dir, "patch-plan.md"),
    report: path.join(dir, "REPORT.md"),
    iter: (n) => path.join(dir, `iter-${n}`),
  };
};

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  let text = fs.readFileSync(file, "utf8").trim();
  // Tolerate a markdown fence the orchestrator may have copied along.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(text);
}

function loadRun(root) {
  const p = dirs(root).run;
  if (!fs.existsSync(p)) throw new Error("No active run. Start one with /adversary:loop <spec>.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveRun(root, run, { touch = true } = {}) {
  if (touch) {
    run.updated_at = new Date().toISOString();
    run.stop_blocks = 0;
  }
  writeJson(dirs(root).run, run);
}

// ---------- tree snapshot / stagnation ----------
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".adversary", "dist", "build", ".next", ".venv", "venv",
  "__pycache__", "target", ".turbo", "coverage",
]);

function walk(root, rel = "", out = []) {
  if (out.length > 20000) return out;
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, r, out);
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

function listFiles(root) {
  const g = spawnSync("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = g.status === 0 ? g.stdout.split("\0").filter(Boolean) : walk(root);
  return files.filter((f) => !f.replace(/\\/g, "/").startsWith(".adversary/"));
}

export function snapshot(root) {
  const snap = {};
  for (const rel of listFiles(root)) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // tracked but deleted
    }
    if (!st.isFile()) continue;
    snap[rel.replace(/\\/g, "/")] =
      st.size > 1_000_000 ? `big:${st.size}:${st.mtimeMs}` : sha(fs.readFileSync(abs));
  }
  return snap;
}

export function changedPaths(base, cur) {
  const keys = new Set([...Object.keys(base), ...Object.keys(cur)]);
  return [...keys].filter((k) => base[k] !== cur[k]).sort();
}

export function fingerprint(base, cur) {
  return sha(changedPaths(base, cur).map((p) => `${p}\0${cur[p] ?? "DELETED"}`).join("\n"));
}

// ---------- validate gate ----------
export function detectValidateCmds(root) {
  const cmds = [];
  const pkg = path.join(root, "package.json");
  if (fs.existsSync(pkg)) {
    try {
      const s = JSON.parse(fs.readFileSync(pkg, "utf8")).scripts ?? {};
      if (s.lint) cmds.push("npm run lint --silent");
      if (s.typecheck) cmds.push("npm run typecheck --silent");
      if (s.test && !/no test specified/i.test(s.test)) cmds.push("npm test --silent");
    } catch {
      /* ignore malformed package.json */
    }
  }
  const hasPy = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((f) =>
    fs.existsSync(path.join(root, f)),
  );
  if (hasPy) cmds.push("pytest -q");
  return cmds;
}

function runValidate(cmds, root) {
  if (!cmds.length) return { ok: true, skipped: true, results: [] };
  const results = [];
  for (const command of cmds) {
    const t0 = Date.now();
    const p = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", timeout: 300_000 });
    const r = {
      command,
      exit_code: p.status ?? -1,
      stdout: clip(p.stdout ?? ""),
      stderr: clip(p.stderr ?? (p.error ? String(p.error) : "")),
      duration_ms: Date.now() - t0,
    };
    results.push(r);
    if (r.exit_code !== 0) return { ok: false, results };
  }
  return { ok: true, results };
}

// ---------- review verification ----------
const norm = (s) => s.replace(/\s+/g, " ").trim();

export function checkEvidence(root, item) {
  const abs = path.resolve(root, item.file);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: "path escapes project" };
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, reason: "file does not exist" };
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  if (item.line > lines.length) return { ok: false, reason: `line ${item.line} beyond end of file (${lines.length} lines)` };
  const quote = norm(item.evidence.replace(/\.{3}|…/g, " "));
  if (quote.length < 4) return { ok: false, reason: "evidence too short to verify" };
  const lo = Math.max(0, item.line - 1 - EVIDENCE_WINDOW);
  const window = norm(lines.slice(lo, item.line + EVIDENCE_WINDOW).join("\n"));
  if (!window.includes(quote)) return { ok: false, reason: `quoted evidence not found within ${EVIDENCE_WINDOW} lines of ${item.file}:${item.line}` };
  return { ok: true };
}

export function validateItemShape(it, seen) {
  const errs = [];
  if (!it || typeof it !== "object") return ["not an object"];
  if (typeof it.id !== "string" || !it.id) errs.push("missing id");
  else if (seen.has(it.id)) errs.push("duplicate id");
  if (typeof it.title !== "string" || !it.title) errs.push("missing title");
  if (!SEVERITIES.includes(String(it.severity).toLowerCase())) errs.push("bad severity");
  if (typeof it.file !== "string" || !it.file) errs.push("missing file");
  if (!Number.isInteger(it.line) || it.line < 1) errs.push("bad line");
  if (typeof it.evidence !== "string" || !it.evidence.trim()) errs.push("missing evidence");
  if (typeof it.reproduction !== "string" || !it.reproduction.trim()) errs.push("missing reproduction");
  return errs;
}

// ---------- triage application ----------
/**
 * Pure: merge a model's TriageDecision with the verified items and return the
 * effective decision. The model's own `ship` flag is ignored on purpose.
 */
export function applyTriage(verified, decision) {
  const byId = new Map(verified.map((i) => [i.id, { ...i, severity: i.severity.toLowerCase() }]));
  const warnings = [];
  const accepted = new Set((decision.accepted ?? []).filter((id) => byId.has(id)));
  const rejected = [];
  const downgraded = [];

  for (const r of decision.rejected ?? []) {
    const item = byId.get(r?.id);
    if (!item) {
      warnings.push(`rejection of unknown id ${r?.id} ignored`);
      continue;
    }
    if (!REJECT_REASONS.includes(r.reason)) {
      warnings.push(`rejection of ${r.id} has invalid reason "${r.reason}"; item kept`);
      continue;
    }
    if (isBlocking(item.severity) && !(typeof r.evidence === "string" && r.evidence.trim().length >= 20)) {
      warnings.push(`rejection of ${item.severity} item ${r.id} lacks counter-evidence; item kept`);
      accepted.add(r.id);
      continue;
    }
    accepted.delete(r.id);
    rejected.push({ id: r.id, reason: r.reason, evidence: r.evidence ?? "" });
  }

  for (const d of decision.downgraded ?? []) {
    const item = byId.get(d?.id);
    const to = String(d?.to).toLowerCase();
    if (!item || !SEVERITIES.includes(to) || rank(to) >= rank(item.severity)) {
      warnings.push(`downgrade of ${d?.id} ignored (unknown id or not a downgrade)`);
      continue;
    }
    if (typeof d.reason !== "string" || !d.reason.trim()) {
      warnings.push(`downgrade of ${d.id} lacks a reason; ignored`);
      continue;
    }
    downgraded.push({ id: d.id, from: item.severity, to, reason: d.reason });
    item.severity = to;
  }

  // Fail safe: an unaccounted-for blocking finding can never be silently dropped.
  const rejectedIds = new Set(rejected.map((r) => r.id));
  for (const item of byId.values()) {
    if (isBlocking(item.severity) && !accepted.has(item.id) && !rejectedIds.has(item.id)) {
      warnings.push(`${item.severity} item ${item.id} was not addressed by triage; treated as accepted`);
      accepted.add(item.id);
    }
  }

  const acceptedItems = [...accepted].map((id) => byId.get(id));
  const blocking = acceptedItems.filter((i) => isBlocking(i.severity));
  return {
    accepted: acceptedItems.map((i) => i.id),
    acceptedItems,
    rejected,
    downgraded,
    blockingIds: blocking.map((i) => i.id),
    leftovers: acceptedItems.filter((i) => !isBlocking(i.severity)),
    ship: blocking.length === 0,
    patch_plan: Array.isArray(decision.patch_plan) ? decision.patch_plan.map(String) : [],
    notes: typeof decision.notes === "string" ? decision.notes : "",
    warnings,
  };
}

// ---------- instructions & report ----------
function instructionFor(run, root) {
  const d = dirs(root);
  const n = run.iteration;
  switch (run.phase) {
    case "build": {
      const lines = [];
      if (run.last_validation && run.validate_bounces > 0) {
        lines.push(
          `The local validate gate FAILED (bounce ${run.validate_bounces}/${MAX_VALIDATE_BOUNCES}). Treat this output as ground truth and fix it:`,
          "```",
          ...run.last_validation.results.slice(-1).map((r) => `$ ${r.command}\nexit ${r.exit_code}\n${r.stdout}\n${r.stderr}`),
          "```",
        );
      } else if (n === 0) {
        lines.push(`Implement the spec in ${d.spec} end to end, with honest tests (happy-path-only tests are a defect).`);
      } else {
        lines.push(
          `Apply the Triage patch plan in ${d.plan} in order. It is your spec for this iteration. If an item conflicts with the spec, the spec wins; note the conflict. Do not skip a Critical or High item. Do not read other files in .adversary/ (raw reviews are deliberately hidden from the Builder).`,
        );
      }
      lines.push(`When finished run: ${CLI} checkpoint`);
      return lines.join("\n");
    }
    case "review":
      return [
        `Dispatch the \`adversary-reviewer\` subagent. Its prompt must contain ONLY these three paths and nothing about what you built or why:`,
        `  spec: ${d.spec}`,
        `  changed files: ${path.join(d.iter(n), "changed.json")}`,
        `  project root: ${root}`,
        `Write its JSON reply VERBATIM (no edits) to ${path.join(d.iter(n), "review.raw.json")}, then run:`,
        `  ${CLI} review --file "${path.join(d.iter(n), "review.raw.json")}"`,
      ].join("\n");
    case "triage":
      return [
        `Dispatch the \`adversary-triage\` subagent. Its prompt must contain ONLY:`,
        `  spec: ${d.spec}`,
        `  verified findings: ${path.join(d.iter(n), "review.verified.json")}`,
        `  project root: ${root}`,
        `Write its JSON reply VERBATIM to ${path.join(d.iter(n), "triage.raw.json")}, then run:`,
        `  ${CLI} triage --file "${path.join(d.iter(n), "triage.raw.json")}"`,
      ].join("\n");
    default:
      return `The loop has halted (${run.halt_reason}). Show the user ${d.report} (summarize it; do not re-run anything).`;
  }
}

const HALT_TEXT = {
  clean_gate: "No accepted Critical or High findings remain. Shipped.",
  max_iterations: "Iteration cap reached with Critical/High findings still open.",
  stagnant_diff: "The working tree stopped changing or returned to an earlier state (no progress / ping-pong).",
  validate_exhausted: `The local validate gate failed ${MAX_VALIDATE_BOUNCES} times in a row.`,
  aborted: "Aborted by the user.",
};

export function buildReport(run) {
  const L = [];
  L.push(`# Adversary loop report`, "");
  L.push(`- Run: \`${run.run_id}\``);
  L.push(`- Outcome: **${run.halt_reason ?? "running"}**: ${HALT_TEXT[run.halt_reason] ?? "still in progress"}`);
  L.push(`- Iterations completed: ${run.iteration} of ${run.max_iterations}`);
  if (run.warnings.length) L.push(`- Warnings: ${run.warnings.length} (see below)`);
  L.push("", "## Iterations", "", "| # | findings | evidence-verified | auto-rejected | accepted | blocking | ship |", "|---|---|---|---|---|---|---|");
  for (const h of run.history) {
    L.push(`| ${h.iteration} | ${h.review_total} | ${h.verified} | ${h.auto_rejected} | ${h.accepted ?? "-"} | ${h.blocking?.length ?? "-"} | ${h.ship ?? "-"} |`);
  }
  const total = run.history.reduce((a, h) => a + h.review_total, 0);
  const bad = run.history.reduce((a, h) => a + h.auto_rejected, 0);
  if (total) L.push("", `Reviewer findings that failed evidence verification: ${bad}/${total} (${Math.round((100 * bad) / total)}%).`);
  const fmt = (i) => `- **${i.severity}** \`${i.file}:${i.line}\` ${i.title} (${i.id})`;
  if (run.unresolved.length) L.push("", "## Still open (Critical/High)", "", ...run.unresolved.map(fmt));
  if (run.leftovers.length) L.push("", "## Accepted but non-blocking (Medium and below)", "", ...run.leftovers.map(fmt));
  if (run.downgrades.length) {
    L.push("", "## Severity downgrades (review these)", "");
    for (const d of run.downgrades) L.push(`- ${d.id}: ${d.from} → ${d.to}: ${d.reason}`);
  }
  if (run.warnings.length) L.push("", "## Warnings", "", ...run.warnings.map((w) => `- ${w}`));
  L.push("");
  return L.join("\n");
}

function halt(root, run, reason) {
  run.status = reason === "aborted" ? "aborted" : "halted";
  run.phase = "halt";
  run.halt_reason = reason;
  saveRun(root, run);
  fs.writeFileSync(dirs(root).report, buildReport(run));
  return out(root, run, { halted: true, report: dirs(root).report });
}

function out(root, run, extra = {}) {
  return {
    ok: true,
    phase: run.phase,
    iteration: run.iteration,
    max_iterations: run.max_iterations,
    ...extra,
    instruction: instructionFor(run, root),
  };
}

// ---------- commands ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      a[k] = v;
    } else a._.push(argv[i]);
  }
  return a;
}

function assertPhase(run, phase) {
  if (run.status !== "running") throw new Error(`Run is ${run.status}. Nothing to do.`);
  if (run.phase !== phase) throw new Error(`Wrong step: run is in phase "${run.phase}", not "${phase}".\n${instructionFor(run, process.cwd())}`);
}

export function cmdInit(root, args) {
  const d = dirs(root);
  if (!args.spec || args.spec === true || !fs.existsSync(args.spec)) throw new Error(`--spec file not found: ${args.spec}`);
  if (fs.existsSync(d.run) && !args.force) {
    const prev = JSON.parse(fs.readFileSync(d.run, "utf8"));
    if (prev.status === "running" && Date.now() - Date.parse(prev.updated_at) < STALE_MS) {
      throw new Error("A run is already in progress. Use /adversary:abort first, or pass --force.");
    }
  }
  const max = Math.min(10, Math.max(1, parseInt(args.max ?? "5", 10) || 5));
  fs.rmSync(d.dir, { recursive: true, force: true });
  fs.mkdirSync(d.dir, { recursive: true });
  fs.copyFileSync(args.spec, d.spec);
  // Keep .adversary out of git status/diffs.
  const ex = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8" });
  if (ex.status === 0) {
    const f = path.resolve(root, ex.stdout.trim());
    try {
      const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      if (!/^\.adversary\/?$/m.test(cur)) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, `${cur.endsWith("\n") || !cur ? "" : "\n"}.adversary/\n`);
      }
    } catch {
      /* best effort */
    }
  }
  const base = snapshot(root);
  writeJson(d.baseline, base);
  const cmds = typeof args["test-cmd"] === "string" ? [args["test-cmd"]] : detectValidateCmds(root);
  const run = {
    version: 1,
    run_id: `${Date.now().toString(36)}-${sha(String(Math.random())).slice(0, 6)}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "running",
    phase: "build",
    iteration: 0,
    max_iterations: max,
    validate_cmds: cmds,
    validate_bounces: 0,
    fingerprints: [fingerprint(base, base)],
    halt_reason: null,
    stop_blocks: 0,
    last_validation: null,
    history: [],
    rejected_history: [],
    unresolved: [],
    leftovers: [],
    downgrades: [],
    warnings: [],
  };
  saveRun(root, run);
  const note = cmds.length
    ? `Validate gate: ${cmds.join(" && ")}`
    : "WARNING: no lint/test command detected. The Reviewer will run on unvalidated code. Re-init with --test-cmd to add a gate.";
  return out(root, run, { validate_gate: cmds, note });
}

export function cmdCheckpoint(root) {
  const run = loadRun(root);
  assertPhase(run, "build");
  const base = JSON.parse(fs.readFileSync(dirs(root).baseline, "utf8"));
  const snap = snapshot(root);
  const fp = fingerprint(base, snap);
  if (run.fingerprints.includes(fp)) {
    run.warnings.push(`iteration ${run.iteration}: working tree identical to an earlier checkpoint`);
    return halt(root, run, "stagnant_diff");
  }
  run.fingerprints.push(fp);
  const val = runValidate(run.validate_cmds, root);
  run.last_validation = val;
  if (!val.ok) {
    run.validate_bounces += 1;
    if (run.validate_bounces >= MAX_VALIDATE_BOUNCES) return halt(root, run, "validate_exhausted");
    saveRun(root, run);
    return out(root, run, { validate: "failed" });
  }
  run.validate_bounces = 0;
  const changed = changedPaths(base, snap);
  writeJson(path.join(dirs(root).iter(run.iteration), "changed.json"), { changed_files: changed });
  run.phase = "review";
  saveRun(root, run);
  return out(root, run, { validate: val.skipped ? "skipped (no gate)" : "passed", changed_files: changed.length });
}

export function cmdReview(root, args) {
  const run = loadRun(root);
  assertPhase(run, "review");
  const d = dirs(root);
  const payload = readJsonFile(args.file);
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) throw new Error('Reviewer JSON must be {"items": [...]}');
  const seen = new Set();
  const verified = [];
  const autoRejected = [];
  for (const it of items) {
    const errs = validateItemShape(it, seen);
    if (errs.length) {
      autoRejected.push({ id: it?.id ?? "?", reason: "malformed", detail: errs.join(", ") });
      continue;
    }
    seen.add(it.id);
    const ev = checkEvidence(root, it);
    if (!ev.ok) {
      autoRejected.push({ id: it.id, reason: "hallucination", detail: ev.reason });
      continue;
    }
    verified.push({ ...it, severity: it.severity.toLowerCase(), title: it.title.slice(0, 80) });
  }
  const entry = { iteration: run.iteration, review_total: items.length, verified: verified.length, auto_rejected: autoRejected.length };
  writeJson(path.join(d.iter(run.iteration), "review.verified.json"), {
    verified,
    auto_rejected: autoRejected,
    previously_rejected: run.rejected_history.slice(-50),
  });
  if (!verified.length) {
    run.history.push({ ...entry, accepted: 0, blocking: [], ship: true });
    run.iteration += 1;
    return halt(root, run, "clean_gate");
  }
  run.history.push(entry);
  run.phase = "triage";
  saveRun(root, run);
  return out(root, run, { findings: items.length, verified: verified.length, auto_rejected: autoRejected });
}

export function cmdTriage(root, args) {
  const run = loadRun(root);
  assertPhase(run, "triage");
  const d = dirs(root);
  const { verified } = JSON.parse(fs.readFileSync(path.join(d.iter(run.iteration), "review.verified.json"), "utf8"));
  const decision = readJsonFile(args.file);
  const eff = applyTriage(verified, decision);
  if (!eff.ship && !eff.patch_plan.length) {
    throw new Error("Triage accepted blocking findings but returned an empty patch_plan. Re-run the triage subagent and ask for a patch_plan.");
  }
  writeJson(path.join(d.iter(run.iteration), "triage.effective.json"), eff);
  const h = run.history[run.history.length - 1];
  Object.assign(h, { accepted: eff.accepted.length, blocking: eff.blockingIds, ship: eff.ship });
  for (const r of eff.rejected) {
    const it = verified.find((v) => v.id === r.id);
    run.rejected_history.push({ iteration: run.iteration, id: r.id, title: it?.title, file: it?.file, reason: r.reason });
  }
  run.downgrades.push(...eff.downgraded);
  run.warnings.push(...eff.warnings.map((w) => `iteration ${run.iteration}: ${w}`));
  run.unresolved = eff.acceptedItems.filter((i) => isBlocking(i.severity));
  run.leftovers = eff.leftovers;
  run.iteration += 1;
  if (eff.ship) return halt(root, run, "clean_gate");
  if (run.iteration >= run.max_iterations) return halt(root, run, "max_iterations");
  const plan = ["# Patch plan", "", ...eff.patch_plan.map((p, i) => `${i + 1}. ${p}`), ""].join("\n");
  fs.writeFileSync(d.plan, plan);
  run.phase = "build";
  saveRun(root, run);
  return out(root, run, { accepted: eff.accepted.length, blocking: eff.blockingIds.length, warnings: eff.warnings });
}

function cmdStatus(root) {
  const run = loadRun(root);
  return out(root, run, { status: run.status, halt_reason: run.halt_reason, validate_gate: run.validate_cmds, history: run.history });
}

function cmdAbort(root) {
  const run = loadRun(root);
  if (run.status !== "running") return { ok: true, note: `Run already ${run.status}.` };
  return halt(root, run, "aborted");
}

function cmdReport(root) {
  const run = loadRun(root);
  const text = buildReport(run);
  fs.writeFileSync(dirs(root).report, text);
  return { ok: true, report: dirs(root).report, text };
}

function cmdStopCheck(root, stdin) {
  let payload = {};
  try {
    payload = JSON.parse(stdin || "{}");
  } catch {
    /* ignore */
  }
  const cwd = payload.cwd || root;
  let run;
  try {
    run = loadRun(cwd);
  } catch {
    return null;
  }
  if (run.status !== "running") return null;
  if (Date.now() - Date.parse(run.updated_at) > STALE_MS) return null;
  if ((run.stop_blocks ?? 0) >= MAX_STOP_BLOCKS) return null; // no progress between stops: let the user out
  run.stop_blocks = (run.stop_blocks ?? 0) + 1;
  saveRun(cwd, run, { touch: false });
  return {
    decision: "block",
    reason: `The adversary loop is still running (phase "${run.phase}", iteration ${run.iteration}/${run.max_iterations}). Do not stop. Next step:\n${instructionFor(run, cwd)}\n(The user can run /adversary:abort to end it.)`,
  };
}

// ---------- entry ----------
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = path.resolve(typeof args.root === "string" ? args.root : process.cwd());
  try {
    let result;
    switch (cmd) {
      case "init": result = cmdInit(root, args); break;
      case "checkpoint": result = cmdCheckpoint(root); break;
      case "review": result = cmdReview(root, args); break;
      case "triage": result = cmdTriage(root, args); break;
      case "status": result = cmdStatus(root); break;
      case "report": result = cmdReport(root); break;
      case "abort": result = cmdAbort(root); break;
      case "stop-check": {
        const r = cmdStopCheck(root, await readStdin());
        if (r) console.log(JSON.stringify(r));
        return;
      }
      default:
        throw new Error("usage: adversary.mjs <init|checkpoint|review|triage|status|report|abort|stop-check>");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
