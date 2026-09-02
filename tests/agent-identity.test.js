import assert from "node:assert/strict";
import test from "node:test";
import {
  colorForAgent,
  detectAgentName,
  DEFAULT_AGENT_NAME,
  GROUP_COLORS,
  MAX_AGENT_NAME_LENGTH,
  normalizeAgentName,
  resolveAgentName,
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
