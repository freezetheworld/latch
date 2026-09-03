import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

/**
 * background.js runs in Chrome, not in Node, so it cannot be imported. It is a
 * plain script under the hood, so the whole file is evaluated here against a
 * stub `chrome` and the internals are handed back through a global. That gives
 * the name-collision logic real coverage rather than a reimplementation of it.
 */
function loadBackground(stored = {}) {
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

  const listener = () => ({ addListener() {} });
  const chrome = {
    debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
    tabs: { onCreated: listener(), onRemoved: listener(), onUpdated: listener(), query: async () => [], get: async () => ({}), group: async () => 1 },
    tabGroups: { onCreated: listener(), onUpdated: listener(), onRemoved: listener(), query: async () => [], get: async () => ({}), update: async () => ({}) },
    runtime: {
      onMessage: listener(),
      onInstalled: listener(),
      onStartup: listener(),
      id: "test-extension",
      sendMessage: async () => {},
      connectNative() {
        return { onMessage: listener(), onDisconnect: listener(), postMessage() {}, disconnect() {} };
      },
    },
    storage: {
      session: {
        async get(key) { return key in stored ? { [key]: stored[key] } : {}; },
        async set(values) { Object.assign(stored, values); },
      },
    },
  };

  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout, Date, URL });
  const exposed = [
    "claimAgentName",
    "agentSessions",
    "tabAgents",
    "attachedTabs",
    "knownAgents",
    "hydrateAgentSessions",
    "callsignName",
    "colorForAgent",
    "AGENT_CALLSIGNS",
    "SESSION_IDLE_MS",
  ];
  vm.runInContext(`${source}\nglobalThis.__latch = { ${exposed.join(", ")} };`, context);
  return context.__latch;
}

test("the first session to ask for a name keeps it", () => {
  const latch = loadBackground();
  assert.equal(latch.claimAgentName("Claude Code", "session-a"), "Claude Code");
  // Repeat calls from the same session are stable.
  assert.equal(latch.claimAgentName("Claude Code", "session-a"), "Claude Code");
});

test("a second session asking for the same name gets a callsign", () => {
  const latch = loadBackground();
  const first = latch.claimAgentName("Claude Code", "session-a");
  const second = latch.claimAgentName("Claude Code", "session-b");

  assert.equal(first, "Claude Code");
  assert.notEqual(second, first);
  // The brand is kept and a callsign replaces the rest: "Claude Nova".
  assert.match(second, /^Claude (?<call>\w+)$/);
  assert.ok(latch.AGENT_CALLSIGNS.includes(second.split(" ")[1]));
  // And it is stable for that session.
  assert.equal(latch.claimAgentName("Claude Code", "session-b"), second);
});

test("this applies to every agent type, not just Claude", () => {
  for (const base of ["Codex", "Gemini", "Cursor", "DeepSeek", "Hermes", "Agent"]) {
    const latch = loadBackground();
    const first = latch.claimAgentName(base, "one");
    const second = latch.claimAgentName(base, "two");
    assert.equal(first, base);
    assert.notEqual(second, base);
    assert.equal(second.split(" ")[0], base.split(" ")[0]);
    assert.ok(latch.AGENT_CALLSIGNS.includes(second.split(" ")[1]), `${base} -> ${second}`);
  }
});

test("a variant takes a different tab group colour where one is free", () => {
  const latch = loadBackground();
  const first = latch.claimAgentName("Claude Code", "one");
  const second = latch.claimAgentName("Claude Code", "two");
  const third = latch.claimAgentName("Claude Code", "three");

  // Colour is the other half of telling two sessions apart at a glance.
  const colors = [first, second, third].map(latch.colorForAgent);
  assert.equal(new Set(colors).size, 3, `expected three colours, got ${colors.join(", ")}`);
});

test("many sessions of one agent all get distinct names", () => {
  const latch = loadBackground();
  const names = new Set();
  for (let i = 0; i < 30; i++) names.add(latch.claimAgentName("Codex", `session-${i}`));
  // 24 callsigns plus numbered overflow, all unique.
  assert.equal(names.size, 30);
  for (const name of names) assert.ok(name.length <= 24, `${name} is too long for a group title`);
});

test("a name is released once its session goes quiet and holds no tabs", () => {
  const latch = loadBackground();
  assert.equal(latch.claimAgentName("Codex", "old"), "Codex");

  // Age the first session past the idle window.
  for (const entry of latch.agentSessions.values()) entry.lastSeen = Date.now() - latch.SESSION_IDLE_MS - 1;
  assert.equal(latch.claimAgentName("Codex", "new"), "Codex", "an abandoned name should be reusable");
});

test("a quiet session keeps its name while its tabs are still attached", () => {
  const latch = loadBackground();
  assert.equal(latch.claimAgentName("Codex", "old"), "Codex");
  latch.tabAgents.set(7, "Codex");
  latch.attachedTabs.add(7);

  for (const entry of latch.agentSessions.values()) entry.lastSeen = Date.now() - latch.SESSION_IDLE_MS - 1;
  const next = latch.claimAgentName("Codex", "new");
  assert.notEqual(next, "Codex", "tabs are still grouped under the old name");
});

test("a session that renames itself does not disturb the other sessions", () => {
  const latch = loadBackground();
  assert.equal(latch.claimAgentName("Codex", "a"), "Codex");
  assert.equal(latch.claimAgentName("Research", "a"), "Research");
  // The original name is still held by that same session, so b gets a variant.
  assert.notEqual(latch.claimAgentName("Codex", "b"), "Codex");
});

test("resolved names are registered so their tab groups can be adopted", () => {
  const latch = loadBackground();
  latch.claimAgentName("Gemini", "first");
  const variant = latch.claimAgentName("Gemini", "second");
  assert.notEqual(variant, "Gemini");
  // Group adoption only touches groups titled after a name seen this session.
  assert.ok(latch.knownAgents.has("Gemini"));
  assert.ok(latch.knownAgents.has(variant), `${variant} was not registered`);
});

test("the session table survives a service-worker restart", async () => {
  // The one thing a service-worker restart does not wipe: chrome.storage.session.
  const stored = {};
  const latch = loadBackground(stored);
  await latch.hydrateAgentSessions();
  latch.claimAgentName("Codex", "long-lived");
  const variant = latch.claimAgentName("Codex", "other");
  assert.notEqual(variant, "Codex");
  assert.ok(Object.keys(stored).length > 0, "nothing was persisted");

  // After the restart only the second session comes back. Without the stored
  // table it would take the plain "Codex" name, colliding with the tab group
  // the first session is still using.
  const revived = loadBackground(stored);
  await revived.hydrateAgentSessions();
  assert.equal(revived.claimAgentName("Codex", "other"), variant, "variant was not remembered");
});
