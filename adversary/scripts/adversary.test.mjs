// NOTE: strings like "eval(userInput)" / "dangerouslySetInnerHTML" below are inert fixtures
// used to prove that invented reviewer evidence is rejected. Nothing here executes or renders them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTriage,
  checkEvidence,
  cmdCheckpoint,
  cmdInit,
  cmdReview,
  cmdTriage,
  validateItemShape,
} from "./adversary.mjs";

function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  fs.writeFileSync(path.join(root, "spec.md"), "# spec\nadd(a,b) returns a+b\n");
  return root;
}
const write = (root, f, c) => fs.writeFileSync(path.join(root, f), c);
const json = (root, f, data) => {
  const p = path.join(root, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
};
const init = (root, extra = {}) => cmdInit(root, { spec: path.join(root, "spec.md"), "test-cmd": "node -e \"process.exit(0)\"", ...extra });
const item = (o = {}) => ({
  id: "R1", title: "t", severity: "high", file: "a.js", line: 1,
  evidence: "return a - b", reproduction: "add(1,2) is -1", ...o,
});

test("evidence check accepts a real quote and rejects invented ones", () => {
  const root = project({ "a.js": "function add(a, b) {\n  return a - b;\n}\n" });
  assert.equal(checkEvidence(root, item({ line: 2 })).ok, true);
  assert.equal(checkEvidence(root, item({ evidence: "eval(userInput)" })).ok, false);
  assert.equal(checkEvidence(root, item({ file: "nope.js" })).ok, false);
  assert.equal(checkEvidence(root, item({ file: "../../etc/passwd" })).ok, false);
  assert.equal(checkEvidence(root, item({ line: 99 })).ok, false);
});

test("item shape validation", () => {
  assert.deepEqual(validateItemShape(item(), new Set()), []);
  assert.ok(validateItemShape(item({ severity: "scary" }), new Set()).length);
  assert.ok(validateItemShape(item(), new Set(["R1"])).includes("duplicate id"));
  assert.ok(validateItemShape(item({ line: 0 }), new Set()).length);
});

test("triage: ship is computed from severity, never trusted from the model", () => {
  const v = [item({ id: "A", severity: "critical" }), item({ id: "B", severity: "medium" })];
  const eff = applyTriage(v, { accepted: ["B"], rejected: [], patch_plan: ["x"], ship: true });
  assert.equal(eff.ship, false, "unaddressed critical must block");
  assert.ok(eff.accepted.includes("A"));
});

test("triage: rejecting a blocking item needs counter-evidence", () => {
  const v = [item({ id: "A", severity: "high" })];
  const weak = applyTriage(v, { accepted: [], rejected: [{ id: "A", reason: "hallucination", evidence: "" }] });
  assert.equal(weak.ship, false);
  const strong = applyTriage(v, {
    accepted: [],
    rejected: [{ id: "A", reason: "out_of_spec", evidence: "spec.md line 3 says subtraction is intended here" }],
  });
  assert.equal(strong.ship, true);
});

test("triage: downgrades only go down and need a reason; medium does not block", () => {
  const v = [item({ id: "A", severity: "high" }), item({ id: "B", severity: "low" })];
  const eff = applyTriage(v, {
    accepted: ["A", "B"],
    downgraded: [
      { id: "A", to: "medium", reason: "needs uncommon input" },
      { id: "B", to: "critical", reason: "upgrade attempt" },
    ],
    patch_plan: ["p"],
  });
  assert.equal(eff.ship, true);
  assert.equal(eff.downgraded.length, 1);
  assert.equal(eff.leftovers.length, 2);
  assert.ok(eff.warnings.some((w) => w.includes("B")));
});

test("loop: clean reviewer result halts with clean_gate", () => {
  const root = project({ "a.js": "export const add = (a, b) => a + b;\n" });
  init(root);
  write(root, "a.js", "export const add = (a, b) => a + b; // v1\n");
  assert.equal(cmdCheckpoint(root).phase, "review");
  const f = json(root, ".adversary/iter-0/review.raw.json", { items: [] });
  const r = cmdReview(root, { file: f });
  assert.equal(r.halted, true);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".adversary/run.json"), "utf8"));
  assert.equal(run.halt_reason, "clean_gate");
  assert.ok(fs.existsSync(path.join(root, ".adversary/REPORT.md")));
});

test("loop: hallucinated finding is auto-rejected before triage; real one goes through to ship", () => {
  const root = project({ "a.js": "export const add = (a, b) => a - b;\n" });
  init(root);
  write(root, "a.js", "export const add = (a, b) => a - b; // v1\n");
  cmdCheckpoint(root);
  const f = json(root, ".adversary/iter-0/review.raw.json", {
    items: [
      item({ id: "REAL", file: "a.js", evidence: "(a, b) => a - b" }),
      item({ id: "GHOST", file: "a.js", evidence: "dangerouslySetInnerHTML" }),
    ],
  });
  const r = cmdReview(root, { file: f });
  assert.equal(r.phase, "triage");
  assert.equal(r.verified, 1);
  assert.equal(r.auto_rejected[0].id, "GHOST");
  const t = json(root, ".adversary/iter-0/triage.raw.json", { accepted: ["REAL"], rejected: [], patch_plan: ["fix add"] });
  const out = cmdTriage(root, { file: t });
  assert.equal(out.phase, "build");
  assert.ok(fs.readFileSync(path.join(root, ".adversary/patch-plan.md"), "utf8").includes("fix add"));

  // iteration 1: fix, then reviewer finds nothing
  write(root, "a.js", "export const add = (a, b) => a + b;\n");
  cmdCheckpoint(root);
  cmdReview(root, { file: json(root, ".adversary/iter-1/review.raw.json", { items: [] }) });
  const run = JSON.parse(fs.readFileSync(path.join(root, ".adversary/run.json"), "utf8"));
  assert.equal(run.halt_reason, "clean_gate");
  assert.equal(run.iteration, 2);
});

test("loop: iteration cap halts with max_iterations and lists open findings", () => {
  const root = project({ "a.js": "const x = 1;\n" });
  init(root, { max: "1" });
  write(root, "a.js", "const x = 1; // v1\n");
  cmdCheckpoint(root);
  cmdReview(root, { file: json(root, ".adversary/iter-0/review.raw.json", { items: [item({ file: "a.js", evidence: "const x = 1" })] }) });
  const out = cmdTriage(root, {
    file: json(root, ".adversary/iter-0/triage.raw.json", { accepted: ["R1"], rejected: [], patch_plan: ["p"] }),
  });
  assert.equal(out.halted, true);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".adversary/run.json"), "utf8"));
  assert.equal(run.halt_reason, "max_iterations");
  assert.equal(run.unresolved.length, 1);
});

test("loop: no-op build halts as stagnant_diff", () => {
  const root = project({ "a.js": "const x = 1;\n" });
  init(root);
  const out = cmdCheckpoint(root);
  assert.equal(out.halted, true);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".adversary/run.json"), "utf8"));
  assert.equal(run.halt_reason, "stagnant_diff");
});

test("loop: reverting to an earlier state halts as stagnant_diff (ping-pong)", () => {
  const root = project({ "a.js": "const x = 1;\n" });
  init(root);
  write(root, "a.js", "const x = 2;\n");
  cmdCheckpoint(root);
  cmdReview(root, { file: json(root, ".adversary/iter-0/review.raw.json", { items: [item({ file: "a.js", evidence: "const x = 2" })] }) });
  cmdTriage(root, { file: json(root, ".adversary/iter-0/triage.raw.json", { accepted: ["R1"], patch_plan: ["p"] }) });
  write(root, "a.js", "const x = 1;\n"); // back to baseline
  assert.equal(cmdCheckpoint(root).halted, true);
});

test("loop: validate gate bounces to builder, then exhausts after 3", () => {
  const root = project({ "a.js": "const x = 1;\n" });
  init(root, { "test-cmd": "node -e \"console.error('boom');process.exit(1)\"" });
  let out;
  for (let i = 1; i <= 3; i++) {
    write(root, "a.js", `const x = ${i + 1};\n`);
    out = cmdCheckpoint(root);
    if (i < 3) {
      assert.equal(out.phase, "build");
      assert.match(out.instruction, /boom/);
    }
  }
  assert.equal(out.halted, true);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".adversary/run.json"), "utf8"));
  assert.equal(run.halt_reason, "validate_exhausted");
});

test("steps are enforced in order", () => {
  const root = project({ "a.js": "const x = 1;\n" });
  init(root);
  assert.throws(() => cmdReview(root, { file: "x" }), /Wrong step/);
  assert.throws(() => cmdTriage(root, { file: "x" }), /Wrong step/);
});
