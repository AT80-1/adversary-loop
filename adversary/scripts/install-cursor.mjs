#!/usr/bin/env node
/**
 * Installs the adversary loop into a project's .cursor/ folder (project-level
 * fallback for Cursor builds where you can't load a plugin folder directly).
 *
 *   node install-cursor.mjs [target-project-dir]
 *
 * Copies commands/ and agents/ to <project>/.cursor/, the controller script to
 * <project>/.cursor/adversary/, and rewrites ${CLAUDE_PLUGIN_ROOT} to that path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] ?? process.cwd());
const dest = path.join(target, ".cursor");
const scriptRel = ".cursor/adversary";  // -> .cursor/adversary/scripts/adversary.mjs

const rewrite = (text) => text.replaceAll("${CLAUDE_PLUGIN_ROOT}", scriptRel);

for (const kind of ["commands", "agents"]) {
  fs.mkdirSync(path.join(dest, kind), { recursive: true });
  for (const f of fs.readdirSync(path.join(pluginRoot, kind))) {
    const body = rewrite(fs.readFileSync(path.join(pluginRoot, kind, f), "utf8"));
    fs.writeFileSync(path.join(dest, kind, f), body);
  }
}
fs.mkdirSync(path.join(dest, "adversary", "scripts"), { recursive: true });
fs.copyFileSync(
  path.join(pluginRoot, "scripts", "adversary.mjs"),
  path.join(dest, "adversary", "scripts", "adversary.mjs"),
);
console.log(`Installed into ${dest}\nIn Cursor's agent chat run: /loop path/to/spec.md  (or /status, /abort)`);
