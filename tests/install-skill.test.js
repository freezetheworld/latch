import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SKILL_TARGETS, skillTargets } from "../scripts/install-skill.js";

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

test("installing replaces a symlink left over from an old checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-skill-"));
  try {
    const destination = path.join(root, "latch");
    // A link to a checkout that has since moved: it exists, but resolves to
    // nothing, which is exactly the case a plain existsSync check misses.
    fs.symlinkSync(path.join(root, "gone"), destination, "dir");
    assert.equal(fs.existsSync(destination), false, "a broken link should look absent");
    assert.ok(fs.lstatSync(destination).isSymbolicLink(), "but it is still there");

    fs.rmSync(destination, { recursive: true, force: true });
    fs.symlinkSync(path.resolve("skills/latch"), destination, "dir");
    assert.ok(fs.existsSync(path.join(destination, "SKILL.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
