#!/usr/bin/env node

/**
 * Installs the Latch agent skill into every agent on this machine.
 *
 * The skill is symlinked rather than copied, so editing skills/latch/SKILL.md in
 * the checkout updates every agent at once. Pass --copy for agents that will not
 * follow a symlink.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = path.join(projectRoot, "skills", "latch");
const cliSource = path.join(projectRoot, "cli", "latch.js");

/**
 * Where each agent looks for skills, relative to the home directory. `home` is
 * the agent's own configuration directory: a skills folder is only created when
 * that already exists, so this does not litter the home directory with
 * directories for agents that are not installed.
 */
export const SKILL_TARGETS = [
  { agent: "Claude Code", home: ".claude", skills: ".claude/skills" },
  { agent: "Codex", home: ".codex", skills: ".codex/skills" },
  { agent: "Gemini", home: ".gemini", skills: ".gemini/skills" },
  { agent: "Cursor", home: ".cursor", skills: ".cursor/skills" },
  // Shared location read by DeepSeek's harness and other agents that follow the
  // generic convention.
  { agent: "Shared (~/.agents)", home: ".agents", skills: ".agents/skills" },
];

export function skillTargets({ home = os.homedir(), force = false, exists = fs.existsSync } = {}) {
  return SKILL_TARGETS.filter((target) => force || exists(path.join(home, target.home))).map(
    (target) => ({ ...target, directory: path.join(home, target.skills) }),
  );
}

function removeExisting(destination) {
  // lstat, not stat: a symlink pointing at a since-moved checkout must be
  // replaced, and existsSync follows the link and reports false for it.
  let stats = null;
  try {
    stats = fs.lstatSync(destination);
  } catch {
    return false;
  }
  fs.rmSync(destination, { recursive: true, force: true });
  return stats.isSymbolicLink() ? "link" : "copy";
}

function install(destination, source, { copy }) {
  const replaced = removeExisting(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (copy) {
    fs.cpSync(source, destination, { recursive: true });
  } else {
    fs.symlinkSync(source, destination, fs.statSync(source).isDirectory() ? "dir" : "file");
  }
  return replaced ? "replaced" : "installed";
}

function main() {
  const args = process.argv.slice(2);
  const copy = args.includes("--copy");
  const force = args.includes("--all");
  const uninstall = args.includes("--uninstall");
  const targets = skillTargets({ force });

  if (targets.length === 0) {
    process.stdout.write("No agent configuration directories found. Pass --all to install anyway.\n");
    return;
  }

  for (const target of targets) {
    const destination = path.join(target.directory, "latch");
    if (uninstall) {
      const removed = removeExisting(destination);
      process.stdout.write(`  ${removed ? "removed  " : "absent   "} ${target.agent}: ${destination}\n`);
      continue;
    }
    const action = install(destination, skillSource, { copy });
    process.stdout.write(`  ${action.padEnd(9)} ${target.agent}: ${destination}\n`);
  }

  // The skill tells agents to fall back to the `latch` command when MCP is not
  // registered, so it needs to be on PATH for that advice to work.
  const binDirectory = path.join(os.homedir(), ".local", "bin");
  const binPath = path.join(binDirectory, "latch");
  if (uninstall) {
    const removed = removeExisting(binPath);
    process.stdout.write(`  ${removed ? "removed  " : "absent   "} CLI: ${binPath}\n`);
  } else if (fs.existsSync(binDirectory) || force) {
    fs.mkdirSync(binDirectory, { recursive: true });
    const action = install(binPath, cliSource, { copy: false });
    fs.chmodSync(cliSource, 0o755);
    process.stdout.write(`  ${action.padEnd(9)} CLI: ${binPath}\n`);
    if (!(process.env.PATH ?? "").split(path.delimiter).includes(binDirectory)) {
      process.stdout.write(`\n  Note: ${binDirectory} is not on your PATH.\n`);
    }
  }

  if (!uninstall) {
    process.stdout.write(
      copy
        ? "\nSkill copied. Re-run this after editing SKILL.md.\n"
        : "\nSkill symlinked, so edits to skills/latch/SKILL.md apply everywhere at once.\n",
    );
    process.stdout.write("Restart your agent sessions to pick it up.\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
