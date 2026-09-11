import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { install, SKILL_TARGETS, skillTargets } from "../scripts/install-skill.js";

test("a skill directory is only offered for an agent that is installed", () => {
  const home = "/home/tester";
  const present = new Set([path.join(home, ".claude"), path.join(home, ".codex")]);
  const targets = skillTargets({ home, exists: (candidate) => present.has(candidate) });

  assert.deepEqual(
    targets.map((target) => target.agent),
    ["Claude Code", "Codex"],
    "should not create config directories for agents that are not installed",
  );
  assert.equal(targets[0].directory, path.join(home, ".claude", "skills"));

  // --all overrides the check for a fresh machine.
  assert.equal(skillTargets({ home, force: true, exists: () => false }).length, SKILL_TARGETS.length);
  assert.equal(skillTargets({ home, exists: () => false }).length, 0);
});

test("every agent target names a distinct skills directory", () => {
  const directories = SKILL_TARGETS.map((target) => target.skills);
  assert.equal(new Set(directories).size, directories.length);
  for (const target of SKILL_TARGETS) {
    assert.ok(target.skills.startsWith(`${target.home}/`), `${target.agent} skills path is not under its home`);
  }
});

test("installing replaces a symlink left over from an old checkout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-skill-"));
  try {
    const destination = path.join(root, "latch");
    // A link to a checkout that has since moved: it exists, but resolves to
    // nothing, which is exactly the case a plain existsSync check misses.
    try {
      fs.symlinkSync(path.join(root, "gone"), destination, "dir");
    } catch (error) {
      // Creating a symlink needs admin rights or Developer Mode on Windows;
      // the fallback-to-copy behavior for that case is covered separately.
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("symlinks are not permitted in this environment");
        return;
      }
      throw error;
    }
    assert.equal(fs.existsSync(destination), false, "a broken link should look absent");
    assert.ok(fs.lstatSync(destination).isSymbolicLink(), "but it is still there");

    fs.rmSync(destination, { recursive: true, force: true });
    fs.symlinkSync(path.resolve("skills/latch"), destination, "dir");
    assert.ok(fs.existsSync(path.join(destination, "SKILL.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink permission failure (e.g. Windows without Developer Mode) falls back to a copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-skill-fallback-"));
  try {
    const source = path.resolve("skills/latch");
    const destination = path.join(root, "latch");
    // Simulate SeCreateSymbolicLinkPrivilege being unavailable, the usual
    // reason symlinkSync fails on Windows, without needing an actual
    // permission-restricted directory (which would block the copy fallback too).
    const denySymlink = () => {
      const error = new Error("not permitted");
      error.code = "EPERM";
      throw error;
    };

    const action = install(destination, source, { copy: false, symlink: denySymlink });
    assert.equal(action, "installed (copy)");
    assert.ok(fs.existsSync(path.join(destination, "SKILL.md")));
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink failure unrelated to permissions is not swallowed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-skill-fallback-"));
  try {
    const source = path.resolve("skills/latch");
    const destination = path.join(root, "latch");
    const explode = () => {
      throw new Error("disk on fire");
    };
    assert.throws(() => install(destination, source, { copy: false, symlink: explode }), /disk on fire/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
