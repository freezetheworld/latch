import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

/**
 * Two sessions of one agent get different names, but names alone did not keep
 * them apart: attached tabs were global, so whoever asked next got "the active
 * attached tab" and regrouped it under itself. Agents are now locked to their
 * own tab group — a tab is workable only from inside the group named after you.
 * These tests drive the real background.js against a fake Chrome tab world to
 * prove the lock holds at every place a tab changes hands.
 */
function loadBackground() {
  const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const listener = () => ({ addListener() {}, removeListener() {} });

  const tabs = new Map();
  const groups = new Map();
  let nextTabId = 100;
  let nextGroupId = 900;

  function addTab({ windowId = 1, url = "https://example.com/", active = false } = {}) {
    const id = nextTabId++;
    // Created tabs are already loaded, so waitForControllableTab settles at once.
    tabs.set(id, { id, windowId, url, title: url, active, groupId: -1, status: "complete" });
    return id;
  }

  const chrome = {
    debugger: {
      onEvent: listener(),
      onDetach: listener(),
      attach: async () => {},
      detach: async () => {},
      // Every page-side call is a no-op; the cursor overlay swallows failures.
      sendCommand: async () => ({ result: { value: null } }),
    },
    tabs: {
      onCreated: listener(),
      onRemoved: listener(),
      onUpdated: listener(),
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id ${id}`);
        return { ...tab };
      },
      async query(filter = {}) {
        return [...tabs.values()]
          .filter((tab) => (filter.active === undefined ? true : tab.active === filter.active))
          .filter((tab) => (filter.windowId === undefined ? true : tab.windowId === filter.windowId))
          .map((tab) => ({ ...tab }));
      },
      async group({ tabIds, groupId }) {
        const [tabId] = tabIds;
        const tab = tabs.get(tabId);
        let target = groupId;
        if (target === undefined) {
          target = nextGroupId++;
          groups.set(target, { id: target, windowId: tab.windowId, title: "", color: "grey" });
        }
        tab.groupId = target;
        return target;
      },
      async ungroup(tabId) {
        tabs.get(tabId).groupId = -1;
      },
      async create({ url, active = false }) {
        return { ...tabs.get(addTab({ url, active })) };
      },
      async update(id, props) {
        Object.assign(tabs.get(id), props);
        return { ...tabs.get(id) };
      },
      async remove(id) {
        tabs.delete(id);
      },
    },
    tabGroups: {
      onCreated: listener(),
      onUpdated: listener(),
      onRemoved: listener(),
      async get(id) {
        const group = groups.get(id);
        if (!group) throw new Error(`No group with id ${id}`);
        return { ...group };
      },
      async query({ windowId } = {}) {
        return [...groups.values()]
          .filter((group) => windowId === undefined || group.windowId === windowId)
          .map((group) => ({ ...group }));
      },
      async update(id, props) {
        Object.assign(groups.get(id), props);
        return { ...groups.get(id) };
      },
    },
    windows: { update: async () => ({}) },
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
    storage: { session: { async get() { return {}; }, async set() {} } },
  };

  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout, Date, URL });
  const exposed = [
    "claimAgentName",
    "attachTab",
    "detachTab",
    "resolveAttachedTabId",
    "blockingOwner",
    "agentIsLive",
    "ownerOfTab",
    "reconcileTabGroup",
    "browserOpen",
    "functionExpression",
    "tabAgents",
    "attachedTabs",
    "agentSessions",
  ];
  vm.runInContext(`${source}\nglobalThis.__latch = { ${exposed.join(", ")} };`, context);

  return {
    ...context.__latch,
    addTab,
    tabs,
    groups,
    groupTitleOf: (tabId) => groups.get(tabs.get(tabId).groupId)?.title ?? null,
    setActive(tabId) {
      for (const tab of tabs.values()) tab.active = tab.id === tabId;
    },
    /** Move a tab the way a user dragging it in Chrome would. */
    moveToGroup(tabId, groupId) {
      tabs.get(tabId).groupId = groupId;
    },
    /** The group a named agent owns, as the extension titled it. */
    groupOf(agent) {
      return [...groups.values()].find((group) => group.title.startsWith(agent)) ?? null;
    },
    addUserGroup(windowId = 1) {
      const id = nextGroupId++;
      groups.set(id, { id, windowId, title: "Reading list", color: "grey" });
      return id;
    },
  };
}

test("page expressions cross open shadow roots but ignore Latch's cursor root", () => {
  const latch = loadBackground();
  const target = { id: "shadow-target", shadowRoot: null };
  const cursorTarget = { id: "cursor-target", shadowRoot: null };
  const shadowRoot = {
    children: [{ tagName: "DIV", innerText: "Shadow copy" }],
    querySelectorAll(selector) {
      if (selector === "*") return [target];
      if (selector === ".target") return [target];
      return [];
    },
  };
  const cursorRoot = {
    children: [{ tagName: "DIV", innerText: "Latch cursor copy" }],
    querySelectorAll(selector) {
      if (selector === "*") return [cursorTarget];
      if (selector === ".target") return [cursorTarget];
      return [];
    },
  };
  const host = { dataset: {}, shadowRoot };
  const cursorHost = { dataset: { latchCursor: "true" }, shadowRoot: cursorRoot };
  const document = {
    body: { innerText: "Light copy" },
    querySelectorAll(selector) {
      if (selector === "*") return [host, cursorHost];
      return [];
    },
  };

  const expression = latch.functionExpression(function inspectDeepPage() {
    return {
      first: querySelectorDeep(".target")?.id,
      all: querySelectorAllDeep(".target").map((element) => element.id),
      text: innerTextDeep(),
    };
  });
  const result = vm.runInNewContext(expression, { document });

  assert.equal(result.first, "shadow-target");
  assert.deepEqual([...result.all], ["shadow-target"]);
  assert.match(result.text, /Light copy/);
  assert.match(result.text, /Shadow copy/);
  assert.doesNotMatch(result.text, /Latch cursor copy/);
});

/** Two live sessions of one agent type, as the extension names them. */
function twoSessions(latch) {
  return [
    latch.claimAgentName("Claude Code", "session-a"),
    latch.claimAgentName("Claude Code", "session-b"),
  ];
}

test("an agent cannot resolve to the tab another agent is driving", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab({ url: "https://a.example/" });

  await latch.attachTab(tabId, a);
  latch.setActive(tabId);

  // The active tab is attached, which is all the old code checked.
  assert.equal(await latch.resolveAttachedTabId(undefined, a), tabId);
  await assert.rejects(
    () => latch.resolveAttachedTabId(undefined, b),
    /no attached tab/,
  );
});

test("the lone attached tab is not handed to whoever asks", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab();

  await latch.attachTab(tabId, a);
  // Nothing is active, so the old code fell through to "the only attached tab".
  latch.setActive(-1);

  assert.equal(await latch.resolveAttachedTabId(undefined, a), tabId);
  await assert.rejects(() => latch.resolveAttachedTabId(undefined, b), /no attached tab/);
});

test("naming another agent's tab explicitly is refused, and names the owner", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab();
  await latch.attachTab(tabId, a);

  await assert.rejects(() => latch.resolveAttachedTabId(tabId, b), new RegExp(`is in the .${a}. tab group`));
});

test("attaching does not pull another agent's tab into your group", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab();

  await latch.attachTab(tabId, a);
  const groupBefore = latch.tabs.get(tabId).groupId;
  assert.match(latch.groupTitleOf(tabId), new RegExp(`^${a}`));

  await assert.rejects(() => latch.attachTab(tabId, b), /not in your tab group|is in the/);
  // The tab stayed in its owner's group rather than being retitled.
  assert.equal(latch.tabs.get(tabId).groupId, groupBefore);
  assert.match(latch.groupTitleOf(tabId), new RegExp(`^${a}`));
  assert.equal(latch.tabAgents.get(tabId), a);
});

test("a second agent racing the same attach does not join it", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab();

  // Deliberately not awaited: b arrives while a's attach is still in flight.
  const first = latch.attachTab(tabId, a);
  await assert.rejects(() => latch.attachTab(tabId, b), /not in your tab group|is in the/);
  await first;
  assert.equal(latch.tabAgents.get(tabId), a);
});

test("browser_open does not reuse a tab another agent owns", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab({ url: "https://shared.example/" });
  await latch.attachTab(tabId, a);

  const result = await latch.browserOpen({ url: "https://shared.example/" }, b);

  assert.equal(result.opened, true, "b should get its own tab, not a's");
  assert.notEqual(result.tabId, tabId);
  assert.equal(latch.tabAgents.get(tabId), a);
  assert.equal(latch.tabAgents.get(result.tabId), b);
});

test("browser_open still reuses the agent's own tab", async () => {
  const latch = loadBackground();
  const [a] = twoSessions(latch);
  const tabId = latch.addTab({ url: "https://shared.example/" });
  await latch.attachTab(tabId, a);

  const result = await latch.browserOpen({ url: "https://shared.example/" }, a);
  assert.equal(result.reused, true);
  assert.equal(result.tabId, tabId);
});

test("one agent cannot detach another agent's tab", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab();
  await latch.attachTab(tabId, a);

  await assert.rejects(() => latch.detachTab(tabId, "Detached by agent", b), /not in your tab group|is in the/);
  assert.ok(latch.attachedTabs.has(tabId));
});

test("the popup, being a person, may take a tab over", async () => {
  const latch = loadBackground();
  const [a] = twoSessions(latch);
  const tabId = latch.addTab();
  await latch.attachTab(tabId, a);

  const me = latch.claimAgentName("Me", "ui:popup");
  await latch.attachTab(tabId, me, { takeover: true });
  assert.equal(latch.tabAgents.get(tabId), me);
  assert.match(latch.groupTitleOf(tabId), new RegExp(`^${me}`));
});

test("a tab is only reachable from inside the agent's own group", async () => {
  const latch = loadBackground();
  const [, b] = twoSessions(latch);
  const tabId = latch.addTab();
  // Attached but in nobody's group: not a shared tab, just an unclaimed one.
  latch.attachedTabs.add(tabId);
  latch.setActive(tabId);

  await assert.rejects(() => latch.resolveAttachedTabId(undefined, b), /no attached tab/);
  await assert.rejects(() => latch.resolveAttachedTabId(tabId, b), /not in your tab group/);
});

test("a quiet session's tab can be adopted, but never silently used", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabId = latch.addTab();
  await latch.attachTab(tabId, a);

  // Age a's session past the idle window without touching b's.
  for (const [key, entry] of latch.agentSessions.entries()) {
    if (entry.name === a) latch.agentSessions.set(key, { ...entry, lastSeen: 0 });
  }
  assert.equal(latch.agentIsLive(a), false);

  // It is still a's tab, so b cannot just start driving it...
  await assert.rejects(() => latch.resolveAttachedTabId(tabId, b), /is in the/);
  // ...but b may take it over explicitly, which moves it into b's group.
  await latch.attachTab(tabId, b);
  assert.equal(await latch.ownerOfTab(tabId), b);
  assert.match(latch.groupTitleOf(tabId), new RegExp(`^${b}`));
});

test("dragging a tab into another agent's group hands it over", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabA = latch.addTab();
  const tabB = latch.addTab();
  await latch.attachTab(tabA, a);
  await latch.attachTab(tabB, b);

  latch.moveToGroup(tabA, latch.groupOf(b).id);
  await latch.reconcileTabGroup(tabA);

  // The group is the lock, so the old owner keeps no stale claim on it.
  assert.equal(await latch.ownerOfTab(tabA), b);
  assert.equal(await latch.resolveAttachedTabId(tabA, b), tabA);
  await assert.rejects(() => latch.resolveAttachedTabId(tabA, a), /is in the/);
});

test("dragging a tab out of every agent group stops it being driven", async () => {
  const latch = loadBackground();
  const [a] = twoSessions(latch);
  const tabId = latch.addTab();
  await latch.attachTab(tabId, a);

  latch.moveToGroup(tabId, latch.addUserGroup());
  await latch.reconcileTabGroup(tabId);

  assert.equal(latch.attachedTabs.has(tabId), false);
  await assert.rejects(() => latch.resolveAttachedTabId(tabId, a), /not attached/);
});

test("browser_open opens its own tab rather than taking one of the user's", async () => {
  const latch = loadBackground();
  const [a] = twoSessions(latch);
  // A tab the user already has open on that exact URL, in no agent group.
  const userTab = latch.addTab({ url: "https://news.example/" });

  const result = await latch.browserOpen({ url: "https://news.example/" }, a);

  assert.equal(result.opened, true);
  assert.notEqual(result.tabId, userTab);
  assert.equal(latch.tabs.get(userTab).groupId, -1, "the user's tab was left alone");
  assert.match(latch.groupTitleOf(result.tabId), new RegExp(`^${a}`));
});

test("the group outranks a stale cached owner, with no event needed", async () => {
  const latch = loadBackground();
  const [a, b] = twoSessions(latch);
  const tabA = latch.addTab();
  const tabB = latch.addTab();
  await latch.attachTab(tabA, a);
  await latch.attachTab(tabB, b);

  // A drag whose event was missed, or that happened while the service worker
  // was asleep: tabAgents still says a, but the tab sits in b's group.
  latch.moveToGroup(tabA, latch.groupOf(b).id);
  assert.equal(latch.tabAgents.get(tabA), a, "the cache is deliberately stale here");

  assert.equal(await latch.ownerOfTab(tabA), b);
  await assert.rejects(() => latch.resolveAttachedTabId(tabA, a), /is in the/);
});
