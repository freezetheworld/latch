import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  agentFromGroupTitle,
  AGENT_STATUSES,
  colorForAgent,
  detectAgentName,
  DEFAULT_AGENT_NAME,
  GROUP_COLORS,
  MAX_AGENT_NAME_LENGTH,
  groupTitleFor,
  normalizeAgentName,
  resolveAgentName,
  STATUS_ALIASES,
  statusInfo,
  statusKey,
} from "../server/agent-identity.js";

test("agent names are normalized into safe tab group titles", () => {
  assert.equal(normalizeAgentName("  Claude   Code  "), "Claude Code");
  assert.equal(normalizeAgentName("Codex\n"), "Codex");
  assert.equal(normalizeAgentName("   "), null);
  assert.equal(normalizeAgentName(""), null);
  assert.equal(normalizeAgentName(undefined), null);
  assert.equal(normalizeAgentName(42), null);
  // Long names are capped so the group title stays readable.
  const long = "x".repeat(MAX_AGENT_NAME_LENGTH + 20);
  assert.equal(normalizeAgentName(long).length, MAX_AGENT_NAME_LENGTH);
});

test("an explicit agent name wins over the environment", () => {
  const env = { LATCH_AGENT: "FromEnv", CLAUDECODE: "1" };
  assert.equal(resolveAgentName("Explicit", env), "Explicit");
  assert.equal(resolveAgentName(undefined, env), "FromEnv");
  assert.equal(resolveAgentName("   ", env), "FromEnv");
});

test("agents are detected from their environment signatures", () => {
  assert.equal(detectAgentName({ CLAUDECODE: "1" }), "Claude Code");
  assert.equal(detectAgentName({ CODEX_HOME: "/x" }), "Codex");
  assert.equal(detectAgentName({ CURSOR_AGENT: "1" }), "Cursor");
  assert.equal(detectAgentName({ DEEPSEEK_HARNESS: "1" }), "DeepSeek");
  assert.equal(detectAgentName({ HERMES_AGENT: "1" }), "Hermes");
  assert.equal(detectAgentName({}), DEFAULT_AGENT_NAME);
});

test("each agent gets a stable tab group color", () => {
  // Known agents keep a fixed color so they look the same across sessions.
  assert.equal(colorForAgent("Claude Code"), "purple");
  assert.equal(colorForAgent("claude code"), "purple");
  assert.equal(colorForAgent("Codex"), "cyan");
  assert.equal(colorForAgent("Hermes"), "yellow");

  // Unknown agents hash deterministically into the palette Chrome accepts.
  const mystery = colorForAgent("Some Other Agent");
  assert.ok(GROUP_COLORS.includes(mystery));
  assert.equal(mystery, colorForAgent("Some Other Agent"));
});

test("different agents are kept apart by name", () => {
  assert.notEqual(resolveAgentName("Codex"), resolveAgentName("Claude Code"));
});

test("every status has an emoji and a single word", () => {
  for (const [name, info] of Object.entries(AGENT_STATUSES)) {
    assert.ok(info.glyph.length > 0, `${name} has no glyph`);
    assert.match(info.word, /^[A-Z][a-z]+$/, `${name} word should be one capitalized word`);
  }
  assert.deepEqual(statusInfo("done"), { glyph: "✅", word: "Done" });
  assert.equal(statusInfo("working").glyph, "⏳");
});

test("unknown and verb-shaped statuses resolve to a real status", () => {
  // Aliases keep the older on-page cursor call sites working.
  assert.equal(statusKey("click"), "clicking");
  assert.equal(statusKey("NAVIGATE"), "navigating");
  assert.equal(statusKey("key"), "typing");
  // Anything unrecognized is treated as generic busy work.
  assert.equal(statusKey("nonsense"), "working");
  assert.equal(statusKey(undefined), "working");
  assert.equal(statusKey(null), "working");
});

test("a group title carries the status and gives the agent name back", () => {
  assert.equal(groupTitleFor("Codex", "working"), "Codex · ⏳ Working");
  assert.equal(groupTitleFor("Claude Code", "done"), "Claude Code · ✅ Done");

  // Round-trip: whatever we write, we can read the agent back out of.
  for (const agent of ["Codex", "Claude Code", "Me", "Agent"]) {
    for (const status of Object.keys(AGENT_STATUSES)) {
      assert.equal(agentFromGroupTitle(groupTitleFor(agent, status)), agent);
    }
  }

  // Groups titled before this change, and stray input, still resolve sanely.
  assert.equal(agentFromGroupTitle("Codex"), "Codex");
  assert.equal(agentFromGroupTitle("  Codex  "), "Codex");
  assert.equal(agentFromGroupTitle(""), null);
  assert.equal(agentFromGroupTitle(undefined), null);
  assert.equal(agentFromGroupTitle(42), null);
});

test("the extension's copy of the status vocabulary matches the server's", () => {
  // background.js cannot import from server/, so the tables are duplicated.
  // This is the guard that keeps the two from drifting apart.
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

  const literal = (name) => {
    const marker = `const ${name} = {`;
    const open = source.indexOf(marker);
    assert.ok(open !== -1, `${name} not found in extension/background.js`);
    const close = source.indexOf("\n};", open);
    assert.ok(close !== -1, `${name} is not a closed object literal`);
    const body = source.slice(open + marker.length - 1, close + 2);
    return new Function(`return ${body}`)();
  };

  assert.deepEqual(literal("AGENT_STATUSES"), AGENT_STATUSES);
  assert.deepEqual(literal("STATUS_ALIASES"), STATUS_ALIASES);
  assert.ok(
    source.includes('const STATUS_SEPARATOR = " \\u00B7 "'),
    "extension STATUS_SEPARATOR differs from the server's",
  );
});
