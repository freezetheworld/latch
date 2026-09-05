const NATIVE_HOST_NAME = "com.local.latch";
const REF_ATTRIBUTE = "data-latch-ref";
const MAX_ACTIVITY = 80;
const MAX_CONSOLE_MESSAGES = 500;
const MAX_NETWORK_ENTRIES = 500;
const LATCH_CURSOR_ELEMENT_ID = "__latch_cursor__";

// --- Agent identity -------------------------------------------------------
// Every request carries the name of the agent that issued it. That name is the
// title of the Chrome tab group the agent's tabs live in, so any number of
// agents can share one Chrome profile and stay visually separated.
// These helpers mirror server/agent-identity.js, which this file cannot import.
const DEFAULT_AGENT_NAME = "Agent";
const MAX_AGENT_NAME_LENGTH = 24;
const GROUP_COLORS = ["blue", "cyan", "green", "grey", "orange", "pink", "purple", "red", "yellow"];
const KNOWN_AGENT_COLORS = {
  "claude code": "purple",
  codex: "cyan",
  gemini: "blue",
  cursor: "orange",
  deepseek: "green",
  hermes: "yellow",
};

// When two sessions want the same name, the second one takes the base name
// plus a callsign: "Claude Code" becomes "Claude Nova". Mirrors
// server/agent-identity.js.
const AGENT_CALLSIGNS = [
  "Nova", "Orion", "Vega", "Atlas", "Echo", "Zephyr", "Onyx", "Quasar",
  "Lynx", "Kodiak", "Falcon", "Cobalt", "Ember", "Sable", "Vertex", "Halo",
  "Rogue", "Titan", "Drift", "Prism", "Comet", "Saber", "Aurora", "Flint",
];

function hashString(value) {
  const key = String(value ?? "");
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash;
}

/** The nth callsign variant of a name, keeping the first word as the brand. */
function callsignName(baseName, index) {
  const root = String(baseName ?? "").trim().split(/\s+/)[0] || DEFAULT_AGENT_NAME;
  const size = AGENT_CALLSIGNS.length;
  const callsign = AGENT_CALLSIGNS[((Math.trunc(index) % size) + size) % size];
  const roomForRoot = MAX_AGENT_NAME_LENGTH - callsign.length - 1;
  return `${root.slice(0, Math.max(1, roomForRoot))} ${callsign}`;
}

/** Session ids are opaque; keep them short and single-line. */
function normalizeSessionId(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 64) : null;
}

function normalizeAgentName(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_AGENT_NAME_LENGTH);
}

function colorForAgent(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (KNOWN_AGENT_COLORS[key]) return KNOWN_AGENT_COLORS[key];
  return GROUP_COLORS[hashString(key) % GROUP_COLORS.length];
}

// The on-page overlay is tinted with the same colour as the agent's Chrome tab
// group, so the glow, pointer and footer all agree with the group tab strip.
// Values are the RGB triples of Chrome's own tab-group palette, kept as bare
// components so the injected CSS can build rgba() at any alpha it needs.
const GROUP_COLOR_RGB = {
  blue: "26,115,232",
  cyan: "0,123,131",
  green: "24,128,56",
  grey: "95,99,104",
  orange: "232,113,10",
  pink: "208,24,132",
  purple: "161,66,244",
  red: "217,48,37",
  yellow: "249,171,0",
};

function accentRgbForAgent(name) {
  return GROUP_COLOR_RGB[colorForAgent(name)] ?? GROUP_COLOR_RGB.grey;
}

// What an agent is doing right now, as an emoji plus one word. The pair is shown
// in two places: appended to the agent's Chrome tab group title, so the tab strip
// reports live progress, and on the on-page cursor badge.
const AGENT_STATUSES = {
  idle: { glyph: "\u{1F4A4}", word: "Idle" },
  connected: { glyph: "\u{1F517}", word: "Connected" },
  working: { glyph: "\u23F3", word: "Working" },
  navigating: { glyph: "\u{1F9ED}", word: "Navigating" },
  reading: { glyph: "\u{1F441}\uFE0F", word: "Reading" },
  scrolling: { glyph: "\u{1F4DC}", word: "Scrolling" },
  clicking: { glyph: "\u{1F446}", word: "Clicking" },
  typing: { glyph: "\u2328\uFE0F", word: "Typing" },
  waiting: { glyph: "\u23F1\uFE0F", word: "Waiting" },
  done: { glyph: "\u2705", word: "Done" },
  error: { glyph: "\u26A0\uFE0F", word: "Error" },
};

// Older, verb-shaped names used by the on-page cursor call sites.
const STATUS_ALIASES = {
  click: "clicking",
  type: "typing",
  key: "typing",
  navigate: "navigating",
  read: "reading",
  scroll: "scrolling",
  wait: "waiting",
};

function statusKey(status) {
  const raw = String(status ?? "").toLowerCase();
  const resolved = STATUS_ALIASES[raw] ?? raw;
  return AGENT_STATUSES[resolved] ? resolved : "working";
}

function statusInfo(status) {
  return AGENT_STATUSES[statusKey(status)];
}

// --- Tab group titles -----------------------------------------------------
// A Latch group is titled "<agent> \u00B7 <emoji> <word>". The agent name is
// always the part before the separator, so every place that used to compare a
// group title to an agent name parses it back out instead.
const STATUS_SEPARATOR = " \u00B7 ";

function groupTitleFor(agent, status) {
  const info = statusInfo(status);
  return `${agent}${STATUS_SEPARATOR}${info.glyph} ${info.word}`;
}

/** The agent named by a group title, whether or not it carries a status suffix. */
function agentFromGroupTitle(title) {
  if (typeof title !== "string") return null;
  const index = title.indexOf(STATUS_SEPARATOR);
  const name = (index === -1 ? title : title.slice(0, index)).trim();
  return name || null;
}

/** The agent named by a group title, but only if we have seen it this session. */
function knownAgentFromGroupTitle(title) {
  const agent = agentFromGroupTitle(title);
  return agent && knownAgents.has(agent) ? agent : null;
}

const attachedTabs = new Set();
const attachingTabs = new Map();
// `${windowId}::${agent}` -> groupId for the group that agent owns in that window.
const agentGroupsByKey = new Map();
// Grouping is serialized per window so two agents cannot race on the same window.
const agentGroupQueuesByWindow = new Map();
const tabAgents = new Map();
// Agents seen this session. Only groups titled after one of these are adopted,
// so the user's own tab groups are never hijacked.
const knownAgents = new Set();
// agent -> status key, the second half of that agent's tab group title.
const agentStatuses = new Map();
// Session id -> { name, requested, lastSeen }. Two agents that ask for the same
// name are separated here: the first keeps it, the next gets a callsign.
const agentSessions = new Map();
const cursorPositions = new Map();
const requestedDetachReasons = new Map();
const consoleMessages = new Map();
const networkEntries = new Map();
const activity = [];
let nativePort = null;
let reconnectTimer = null;
function recordActivity(kind, message, details = {}) {
  activity.unshift({
    kind,
    message,
    details,
    timestamp: new Date().toISOString(),
  });
  activity.splice(MAX_ACTIVITY);
  chrome.runtime.sendMessage({ type: "activity_updated" }).catch(() => {});
}

/** Nudge the popup to re-read state; it is closed most of the time, so failures are normal. */
function broadcastStateUpdate() {
  chrome.runtime.sendMessage({ type: "state_updated" }).catch(() => {});
}

function setConnectionBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#10a37f" }).catch(() => {});
}

function connectNativeHost() {
  if (nativePort) {
    return;
  }
  clearTimeout(reconnectTimer);

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? "Native host disconnected";
      nativePort = null;
      setConnectionBadge(false);
      recordActivity("connection", message);
      broadcastStateUpdate();
      reconnectTimer = setTimeout(connectNativeHost, 2_000);
    });
  } catch (error) {
    nativePort = null;
    setConnectionBadge(false);
    recordActivity("error", `Could not connect to native host: ${error.message}`);
    reconnectTimer = setTimeout(connectNativeHost, 2_000);
  }
}

function handleNativeMessage(message) {
  if (message?.type === "host_ready") {
    setConnectionBadge(true);
    recordActivity("connection", "Browser bridge connected");
    broadcastStateUpdate();
    return;
  }

  if (message?.type !== "bridge_request" || typeof message.id !== "string") {
    return;
  }

  dispatchBrowserCommand(message.method, message.params ?? {})
    .then((result) => {
      nativePort?.postMessage({ type: "bridge_response", id: message.id, result });
    })
    .catch((error) => {
      nativePort?.postMessage({
        type: "bridge_response",
        id: message.id,
        error: {
          code: error.code ?? "BROWSER_ERROR",
          message: error.message ?? String(error),
          details: error.details,
        },
      });
    });
}

function browserError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function originForUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
    if (parsed.protocol === "file:") {
      return "file://";
    }
  } catch {
    return null;
  }
  return null;
}

function isControllableUrl(url) {
  return originForUrl(url) !== null;
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

function groupKey(windowId, agent) {
  return `${windowId}::${agent}`;
}

function rememberAgent(agent) {
  if (agent) knownAgents.add(agent);
}

// --- Session names --------------------------------------------------------
// A session is considered live while it is being used, or for as long as it
// still holds attached tabs. Once it is neither, its name is released so the
// next agent of that type can take the plain name back.
const SESSION_IDLE_MS = 30 * 60 * 1_000;
const SESSION_STORAGE_KEY = "latchAgentSessions";
let sessionsHydrated = null;

/** Reload the session table after a service-worker restart. */
function hydrateAgentSessions() {
  sessionsHydrated ??= chrome.storage.session
    .get(SESSION_STORAGE_KEY)
    .then((stored) => {
      for (const [id, entry] of Object.entries(stored?.[SESSION_STORAGE_KEY] ?? {})) {
        if (!entry?.name || agentSessions.has(id)) continue;
        agentSessions.set(id, entry);
        // Restoring these also lets group adoption work again after a restart.
        knownAgents.add(entry.name);
      }
    })
    .catch(() => {
      // Storage is unavailable; names are still resolved, just not remembered.
    });
  return sessionsHydrated;
}

// lastSeen changes on every command, so the table is flushed on a timer rather
// than on each write. Claiming a name always flushes immediately.
const SESSION_PERSIST_INTERVAL_MS = 30 * 1_000;
let sessionsPersistedAt = 0;

function persistAgentSessions({ force = false } = {}) {
  if (!force && Date.now() - sessionsPersistedAt < SESSION_PERSIST_INTERVAL_MS) return;
  sessionsPersistedAt = Date.now();
  chrome.storage.session
    .set({ [SESSION_STORAGE_KEY]: Object.fromEntries(agentSessions) })
    .catch(() => {});
}

function agentHoldsAttachedTab(name) {
  for (const [tabId, owner] of tabAgents.entries()) {
    if (owner === name && attachedTabs.has(tabId)) return true;
  }
  return false;
}

/**
 * Whether `name` is available to `session`. A name held by a session that has
 * gone quiet and owns no tabs is reclaimed rather than blocking forever.
 */
function nameIsAvailable(name, session) {
  for (const [id, entry] of agentSessions.entries()) {
    if (id === session || entry.name !== name) continue;
    if (Date.now() - (entry.lastSeen ?? 0) < SESSION_IDLE_MS || agentHoldsAttachedTab(name)) {
      return false;
    }
    agentSessions.delete(id);
  }
  return true;
}

/**
 * The first free callsign variant of `requested`, seeded by the session id.
 * Prefers a variant whose tab group colour is not already on screen, so two
 * sessions of one agent are told apart by colour as well as by name. With more
 * live agents than Chrome has colours, some reuse is unavoidable.
 */
function availableVariant(requested, session) {
  const start = hashString(session);
  const takenColors = new Set([colorForAgent(requested)]);
  for (const [id, entry] of agentSessions.entries()) {
    if (id !== session) takenColors.add(colorForAgent(entry.name));
  }

  const fallbacks = [];
  for (let offset = 0; offset < AGENT_CALLSIGNS.length; offset++) {
    const candidate = callsignName(requested, start + offset);
    if (!nameIsAvailable(candidate, session)) continue;
    if (!takenColors.has(colorForAgent(candidate))) return candidate;
    fallbacks.push(candidate);
  }
  if (fallbacks.length) return fallbacks[0];
  // Every callsign is in use, which takes 24 concurrent sessions of one agent.
  for (let n = 2; ; n++) {
    const candidate = normalizeAgentName(`${requested} ${n}`);
    if (nameIsAvailable(candidate, session)) return candidate;
  }
}

/**
 * The name this session actually gets. The first session to ask for a name
 * keeps it; a later session asking for the same one is given a callsign, so two
 * Claude Code windows show up as "Claude Code" and "Claude Nova" rather than
 * sharing a single tab group.
 */
function claimAgentName(requested, session) {
  // Keyed by session *and* requested name, so one session that renames itself
  // and two processes that happen to share a session id never fight over one
  // entry.
  const key = `${session ?? "anonymous"}::${requested}`;
  const existing = agentSessions.get(key);
  // A session that keeps asking for the same name keeps the name it was given.
  if (existing) {
    existing.lastSeen = Date.now();
    rememberAgent(existing.name);
    persistAgentSessions();
    return existing.name;
  }

  const name = nameIsAvailable(requested, key) ? requested : availableVariant(requested, key);
  agentSessions.set(key, { name, requested, lastSeen: Date.now() });
  rememberAgent(name);
  persistAgentSessions({ force: true });
  if (name !== requested) {
    recordActivity(
      "agent",
      `“${requested}” is already in use, so this session is “${name}”`,
      { requested, name },
    );
    broadcastStateUpdate();
  }
  return name;
}

function statusForAgent(agent) {
  return agentStatuses.get(agent) ?? "idle";
}

/** Rewrite the title of every group this agent owns, in every window. */
async function retitleAgentGroups(agent) {
  const title = groupTitleFor(agent, statusForAgent(agent));
  const suffix = `::${agent}`;
  const updates = [];
  for (const [key, groupId] of agentGroupsByKey.entries()) {
    if (!key.endsWith(suffix)) continue;
    updates.push(
      chrome.tabGroups.update(groupId, { title }).catch(() => {
        // The group was closed between the lookup and the update.
        if (agentGroupsByKey.get(key) === groupId) agentGroupsByKey.delete(key);
      }),
    );
  }
  await Promise.allSettled(updates);
}

/** Move an agent to a new status and repaint its tab groups. */
function setAgentStatus(agent, status) {
  if (!agent) return;
  const next = statusKey(status);
  if (agentStatuses.get(agent) === next) return;
  agentStatuses.set(agent, next);
  void retitleAgentGroups(agent);
  broadcastStateUpdate();
}

/** Every agent that owns a group or has a status, with its emoji and word. */
function statusSummary() {
  const summary = {};
  for (const agent of new Set([...agentStatuses.keys(), ...tabAgents.values()])) {
    const status = statusForAgent(agent);
    const info = statusInfo(status);
    summary[agent] = { status, glyph: info.glyph, word: info.word };
  }
  return summary;
}

function agentForGroupId(groupId) {
  if (typeof groupId !== "number" || groupId < 0) return null;
  for (const [key, id] of agentGroupsByKey.entries()) {
    if (id === groupId) return key.slice(key.indexOf("::") + 2);
  }
  return null;
}

/** The agent whose group a tab currently sits in, from the group alone. */
async function agentOwningGroup(tab) {
  if (typeof tab?.groupId !== "number" || tab.groupId < 0) return null;
  const byId = agentForGroupId(tab.groupId);
  if (byId) return byId;
  try {
    return knownAgentFromGroupTitle((await chrome.tabGroups.get(tab.groupId)).title);
  } catch {
    // The group disappeared while it was being inspected.
    return null;
  }
}

/**
 * Which agent owns a tab. The tab's group decides, so a tab dragged from one
 * agent's group to another changes hands instead of keeping a stale claim, and
 * ownership survives a service-worker restart, which empties `tabAgents`.
 * Only an ungrouped tab falls back to the recorded owner, because grouping can
 * legitimately fail for pinned and otherwise special tabs.
 */
async function agentForTab(tab) {
  if (!tab?.id) return null;
  const byGroup = await agentOwningGroup(tab);
  if (byGroup) {
    tabAgents.set(tab.id, byGroup);
    return byGroup;
  }
  // Sitting in a group that belongs to no agent means the tab has left every
  // agent workspace, whoever used to hold it.
  if (typeof tab.groupId === "number" && tab.groupId >= 0) return null;
  return tabAgents.get(tab.id) ?? null;
}

async function getAgentGroup(groupId, windowId, agent) {
  if (typeof groupId !== "number" || groupId < 0) {
    return null;
  }
  try {
    const group = await chrome.tabGroups.get(groupId);
    if (group.windowId === windowId && agentFromGroupTitle(group.title) === agent) {
      return group;
    }
  } catch {
    // The group was removed while it was being inspected.
  }
  return null;
}

async function placeTabInAgentGroup(tabId, agent) {
  const tab = await chrome.tabs.get(tabId);
  const key = groupKey(tab.windowId, agent);
  let group = await getAgentGroup(agentGroupsByKey.get(key), tab.windowId, agent);

  if (!group) {
    group = await getAgentGroup(tab.groupId, tab.windowId, agent);
  }

  if (!group) {
    // Titles carry a status suffix, so an exact title query cannot be used.
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    group = groups.find((candidate) => agentFromGroupTitle(candidate.title) === agent) ?? null;
  }

  const groupId = group
    ? await chrome.tabs.group({ tabIds: [tabId], groupId: group.id })
    : await chrome.tabs.group({ tabIds: [tabId] });

  await chrome.tabGroups.update(groupId, {
    title: groupTitleFor(agent, statusForAgent(agent)),
    color: colorForAgent(agent),
    collapsed: false,
  });
  agentGroupsByKey.set(key, groupId);
  tabAgents.set(tabId, agent);
  return groupId;
}

async function ensureAgentGroup(tabId, agent) {
  const { windowId } = await chrome.tabs.get(tabId);
  const previous = agentGroupQueuesByWindow.get(windowId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => placeTabInAgentGroup(tabId, agent));
  agentGroupQueuesByWindow.set(windowId, operation);
  try {
    return await operation;
  } finally {
    if (agentGroupQueuesByWindow.get(windowId) === operation) {
      agentGroupQueuesByWindow.delete(windowId);
    }
  }
}

async function removeFromAgentGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (await agentForTab(tab)) {
      await chrome.tabs.ungroup(tabId);
    }
  } catch {
    // Closing, pinned, and concurrently moved tabs need no further cleanup.
  }
}

async function clearTabOwnership(tabId, reason) {
  const wasAttached = attachedTabs.delete(tabId);
  cursorPositions.delete(tabId);
  consoleMessages.delete(tabId);
  networkEntries.delete(tabId);
  await removeFromAgentGroup(tabId);
  tabAgents.delete(tabId);
  if (wasAttached && reason) {
    recordActivity("detach", reason, { tabId });
  }
}

// --- The group lock -------------------------------------------------------
// Attached tabs are global state, so a name alone does not keep two sessions
// apart: both reach for "the active attached tab" and end up driving — and
// regrouping — each other's tabs, which collapses two agents into one group.
// The tab group is therefore the boundary an agent works inside. A tab is
// workable by an agent only while it sits in that agent's group, and the group
// is the record of ownership rather than a map kept alongside it, so the user
// moving a tab between groups moves it between agents.

/** Whether a session holding `name` has been active recently enough to matter. */
function agentIsLive(name) {
  for (const entry of agentSessions.values()) {
    if (entry.name === name && Date.now() - (entry.lastSeen ?? 0) < SESSION_IDLE_MS) return true;
  }
  return false;
}

/** The agent whose group holds this tab, or null when no agent's does. */
async function ownerOfTab(tabId) {
  try {
    // Deliberately not short-circuited on `tabAgents`: the tab's group is what
    // decides, and the cache is exactly what goes stale when a tab is moved.
    return await agentForTab(await chrome.tabs.get(tabId));
  } catch {
    return tabAgents.get(tabId) ?? null;
  }
}

/**
 * The owner standing between `agent` and a tab, or null when the tab is free to
 * use. A tab whose owner has gone quiet is not defended, so an abandoned
 * session never strands its tabs.
 */
async function blockingOwner(tabId, agent) {
  if (!agent) return null;
  const owner = await ownerOfTab(tabId);
  if (!owner || owner === agent || !agentIsLive(owner)) return null;
  return owner;
}

function foreignTabError(tabId, owner) {
  return browserError(
    "TAB_NOT_IN_YOUR_GROUP",
    owner
      ? `Tab ${tabId} is in the “${owner}” tab group. Work only inside your own group: open your own tab with browser_open.`
      : `Tab ${tabId} is not in your tab group. Work only inside your own group: open your own tab with browser_open.`,
  );
}

/**
 * The tab a command acts on, which is always one inside the caller's own group.
 * Passing no agent skips the check, for the popup and for Latch's own internal
 * cleanup, which act on the user's behalf rather than an agent's.
 */
async function resolveAttachedTabId(requestedTabId, agent = null) {
  if (requestedTabId !== undefined && requestedTabId !== null) {
    if (!attachedTabs.has(requestedTabId)) {
      throw browserError(
        "TAB_NOT_ATTACHED",
        `Tab ${requestedTabId} is not attached. Attach it from the Latch toolbar popup first.`,
      );
    }
    if (agent) {
      const owner = await ownerOfTab(requestedTabId);
      if (owner !== agent) throw foreignTabError(requestedTabId, owner);
    }
    return requestedTabId;
  }

  const usable = [];
  for (const tabId of attachedTabs) {
    if (!agent || (await ownerOfTab(tabId)) === agent) usable.push(tabId);
  }

  const activeTab = await currentTab();
  if (activeTab && usable.includes(activeTab.id)) {
    return activeTab.id;
  }
  if (usable.length === 1) {
    return usable[0];
  }
  throw browserError(
    "NO_ACTIVE_ATTACHED_TAB",
    usable.length
      ? "Several tabs in your group are attached. Pass the tabId of the one to use."
      : "Your tab group has no attached tab. Open one with browser_open and work inside your group.",
  );
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function attachTabOnce(requestedTabId, agent = DEFAULT_AGENT_NAME, { takeover = false } = {}) {
  const tabId = requestedTabId ?? (await currentTab())?.id;
  if (!tabId) {
    throw browserError("TAB_NOT_FOUND", "No active Chrome tab was found.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!isControllableUrl(tab.url)) {
    throw browserError("UNSUPPORTED_PAGE", "Chrome internal pages and extension pages cannot be controlled.");
  }
  // Attaching regroups the tab and rewrites its owner, so it is the point where
  // one agent would otherwise pull another agent's tab into its own group.
  if (!takeover) {
    const owner = await blockingOwner(tabId, agent);
    if (owner) throw foreignTabError(tabId, owner);
  }
  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      if (!String(error.message).includes("Another debugger")) {
        throw error;
      }
      throw browserError("DEBUGGER_BUSY", "Another extension or DevTools is already debugging this tab.");
    }
    attachedTabs.add(tabId);
    consoleMessages.set(tabId, []);
    networkEntries.set(tabId, new Map());

    await Promise.allSettled([
      sendDebuggerCommand(tabId, "Page.enable"),
      sendDebuggerCommand(tabId, "Runtime.enable"),
      sendDebuggerCommand(tabId, "Log.enable"),
      sendDebuggerCommand(tabId, "Network.enable"),
    ]);

    recordActivity("attach", `Attached “${tab.title || tab.url}”`, { tabId, url: tab.url });
  }

  let groupId = null;
  tabAgents.set(tabId, agent);
  try {
    groupId = await ensureAgentGroup(tabId, agent);
  } catch {
    // Pinned and special tabs cannot always be grouped. Control still works,
    // and the recorded owner above keeps the tab reachable by its own agent.
  }

  const current = await chrome.tabs.get(tabId);
  await showLatchCursor(tabId, {
    x: 28,
    y: 28,
    agent,
    label: `${agent} · Connected`,
    status: "connected",
    durationMs: 1_150,
  });
  return { tabId, title: current.title, url: current.url, attached: true, agent, groupId };
}

async function attachTab(requestedTabId, agent = DEFAULT_AGENT_NAME, { takeover = false } = {}) {
  const tabId = requestedTabId ?? (await currentTab())?.id;
  if (!tabId) {
    throw browserError("TAB_NOT_FOUND", "No active Chrome tab was found.");
  }
  const existing = attachingTabs.get(tabId);
  if (existing) {
    // An attach already in flight has no recorded owner yet, so the pending
    // agent is what a second agent has to be checked against.
    if (!takeover && existing.agent !== agent && agentIsLive(existing.agent)) {
      throw foreignTabError(tabId, existing.agent);
    }
    return existing.operation;
  }
  rememberAgent(agent);
  setAgentStatus(agent, "connected");
  const operation = attachTabOnce(tabId, agent, { takeover });
  attachingTabs.set(tabId, { agent, operation });
  try {
    return await operation;
  } finally {
    if (attachingTabs.get(tabId)?.operation === operation) {
      attachingTabs.delete(tabId);
    }
  }
}

async function detachTab(requestedTabId, reason = "Detached by user", agent = null) {
  const tabId = requestedTabId ?? (await resolveAttachedTabId(undefined, agent));
  if (agent) {
    const owner = await ownerOfTab(tabId);
    if (owner !== agent) throw foreignTabError(tabId, owner);
  }
  if (attachedTabs.has(tabId)) {
    requestedDetachReasons.set(tabId, reason);
    await removeLatchCursor(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  const owner = tabAgents.get(tabId) ?? null;
  await clearTabOwnership(tabId, reason);
  requestedDetachReasons.delete(tabId);
  // Detaching from the popup never reaches dispatchBrowserCommand, so the
  // owning agent is stood down here instead.
  if (owner && ![...tabAgents.entries()].some(([id, name]) => name === owner && attachedTabs.has(id))) {
    setAgentStatus(owner, "idle");
  }
  return { tabId, attached: false };
}

async function evaluate(tabId, expression, { awaitPromise = false } = {}) {
  const response = await sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const message = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
    throw browserError("JAVASCRIPT_ERROR", message, response.exceptionDetails);
  }
  return response.result?.value;
}

function functionExpression(fn, ...args) {
  // JSON.stringify(undefined) returns undefined (rather than the string
  // "undefined"). Joining it into an argument list creates `(,value)`,
  // which prevents optional parameters from reaching the page helper.
  const serializedArgs = args.map((argument) => {
    const serialized = JSON.stringify(argument);
    return serialized === undefined ? "undefined" : serialized;
  });
  // Page helpers normally stop at a shadow-root boundary. Modern web apps
  // increasingly put their real controls there (LinkedIn's post composer is
  // one example), so every injected page function gets shadow-aware query and
  // text helpers. Closed roots remain intentionally inaccessible. Latch's own
  // cursor root is skipped so it never appears in snapshots or wait results.
  return `(() => {
    const __latchOpenRoots = () => {
      const roots = [document];
      for (let index = 0; index < roots.length; index += 1) {
        for (const element of roots[index].querySelectorAll("*")) {
          if (element.shadowRoot && element.dataset?.latchCursor !== "true") {
            roots.push(element.shadowRoot);
          }
        }
      }
      return roots;
    };
    const querySelectorAllDeep = (selector) => {
      const matches = [];
      for (const root of __latchOpenRoots()) matches.push(...root.querySelectorAll(selector));
      return matches;
    };
    const querySelectorDeep = (selector) => querySelectorAllDeep(selector)[0] ?? null;
    const innerTextDeep = () => __latchOpenRoots().map((root) => {
      if (root === document) return document.body?.innerText ?? "";
      return [...(root.children ?? [])]
        .filter((element) => !["STYLE", "SCRIPT", "TEMPLATE"].includes(element.tagName))
        .map((element) => element.innerText ?? element.textContent ?? "")
        .join("\\n");
    }).filter(Boolean).join("\\n");
    return (${fn.toString()})(${serializedArgs.join(",")});
  })()`;
}

function renderLatchCursor(elementId, state) {
  const accent = String(state.accent || "16,163,127");
  let host = document.getElementById(elementId);
  let created = false;
  if (!host || host.dataset.latchCursor !== "true") {
    host = document.createElement("div");
    host.id = elementId;
    host.dataset.latchCursor = "true";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "width:100vw",
      "height:100vh",
      "z-index:2147483647",
      "pointer-events:none",
      "overflow:hidden",
      "contain:layout style",
    ].join(";");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // Every colour derives from --latch-accent, which the host sets per agent,
    // so two agents on two tabs never look alike.
    style.textContent = `
        * { box-sizing: border-box; }
        #edge-glow {
          position: fixed;
          inset: 0;
          pointer-events: none;
          opacity: 0;
          background:
            linear-gradient(90deg, rgba(var(--latch-accent),.18), transparent 13%),
            linear-gradient(270deg, rgba(var(--latch-accent),.18), transparent 13%),
            linear-gradient(180deg, rgba(var(--latch-accent),.16), transparent 16%),
            linear-gradient(0deg, rgba(var(--latch-accent),.16), transparent 16%);
          box-shadow: inset 0 0 0 1px rgba(var(--latch-accent),.26), inset 0 0 42px rgba(var(--latch-accent),.16);
          transition: opacity 220ms ease;
        }
        #edge-glow.active { opacity: 1; }
        #cursor {
          position: fixed;
          left: 0;
          top: 0;
          width: 0;
          height: 0;
          opacity: 0;
          transform: translate3d(var(--latch-cursor-x, -2px), var(--latch-cursor-y, -2px), 0) scale(.94);
          transform-origin: 0 0;
          transition: opacity 120ms ease, transform 320ms cubic-bezier(.22,1,.36,1);
          filter: drop-shadow(0 5px 10px rgba(0,0,0,.18));
        }
        #cursor.visible {
          opacity: 1;
          transform: translate3d(var(--latch-cursor-x, 0), var(--latch-cursor-y, 0), 0) scale(1);
        }
        /* The arrow tip inside the viewBox sits at (2.2, 1.5). Offsetting by
           exactly that puts the tip on the coordinate the click is dispatched
           to, instead of ~2px down-right of it. */
        #pointer {
          position: absolute;
          left: -2.2px;
          top: -1.5px;
          width: 24px;
          height: 28px;
          overflow: visible;
        }
        #badge {
          position: absolute;
          left: 15px;
          top: 17px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: max-content;
          height: 27px;
          padding: 0 9px 0 7px;
          border: 1px solid rgba(var(--latch-accent),.55);
          border-radius: 999px;
          background: linear-gradient(145deg, rgba(31,34,32,.88), rgba(12,14,13,.94));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 7px 22px rgba(0,0,0,.2);
          color: rgba(255,255,255,.96);
          font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: -.01em;
          white-space: nowrap;
          backdrop-filter: blur(16px) saturate(150%);
          -webkit-backdrop-filter: blur(16px) saturate(150%);
          transition: left 160ms ease, right 160ms ease;
        }
        #cursor.flip #badge { left: auto; right: 5px; }
        #mark {
          display: grid;
          place-items: center;
          width: 15px;
          height: 15px;
          font-size: 12px;
          line-height: 1;
          font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
        }
        #pulse {
          position: absolute;
          left: -7px;
          top: -7px;
          width: 18px;
          height: 18px;
          border: 2px solid rgba(var(--latch-accent),.7);
          border-radius: 50%;
          opacity: 0;
          transform: scale(.35);
        }
        #pulse.active { animation: latch-click 430ms cubic-bezier(.22,1,.36,1); }
        @keyframes latch-click {
          0% { opacity: .9; transform: scale(.35); }
          100% { opacity: 0; transform: scale(1.75); }
        }
        /* Who is driving this tab, stated plainly and out of the way. Lives as
           long as the glow does, not just for the flash of a single action. */
        #footer {
          position: fixed;
          left: 50%;
          bottom: 14px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 6px 13px;
          border: 1px solid rgba(var(--latch-accent),.5);
          border-radius: 999px;
          background: linear-gradient(145deg, rgba(24,26,25,.86), rgba(10,12,11,.93));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 7px 22px rgba(0,0,0,.24);
          color: rgba(255,255,255,.94);
          font: 500 11.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          white-space: nowrap;
          backdrop-filter: blur(14px) saturate(150%);
          -webkit-backdrop-filter: blur(14px) saturate(150%);
          opacity: 0;
          transform: translateX(-50%) translateY(6px);
          transition: opacity 220ms ease, transform 220ms ease;
        }
        #footer.active { opacity: 1; transform: translateX(-50%) translateY(0); }
        #footer-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: rgb(var(--latch-accent));
          box-shadow: 0 0 0 3px rgba(var(--latch-accent),.22);
        }
        #footer-status {
          font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
          font-size: 11px;
        }
        #footer-name { font-weight: 700; }
        @media (prefers-reduced-motion: reduce) {
          #cursor { transition-duration: 1ms; }
          #pulse.active { animation-duration: 1ms; }
          #footer { transition-duration: 1ms; }
        }`;

    const edgeGlow = document.createElement("div");
    edgeGlow.id = "edge-glow";
    const cursor = document.createElement("div");
    cursor.id = "cursor";
    const svgNamespace = "http://www.w3.org/2000/svg";
    const pointer = document.createElementNS(svgNamespace, "svg");
    pointer.id = "pointer";
    pointer.setAttribute("viewBox", "0 0 24 28");
    pointer.setAttribute("aria-hidden", "true");
    const pointerPath = document.createElementNS(svgNamespace, "path");
    pointerPath.setAttribute("d", "M2.2 1.5 2.1 21l5.25-5.05 3.85 8.35 4.05-1.9-3.88-8.14 7.35-.35L2.2 1.5Z");
    pointerPath.id = "pointer-path";
    pointerPath.setAttribute("stroke", "rgba(255,255,255,.94)");
    pointerPath.setAttribute("stroke-width", "1.45");
    pointerPath.setAttribute("stroke-linejoin", "round");
    pointer.append(pointerPath);

    const pulse = document.createElement("span");
    pulse.id = "pulse";
    const badge = document.createElement("span");
    badge.id = "badge";
    const mark = document.createElement("span");
    mark.id = "mark";
    const label = document.createElement("span");
    label.id = "label";
    label.textContent = "Agent";
    badge.append(mark, label);
    cursor.append(pointer, pulse, badge);

    const footer = document.createElement("div");
    footer.id = "footer";
    const footerDot = document.createElement("span");
    footerDot.id = "footer-dot";
    const footerStatus = document.createElement("span");
    footerStatus.id = "footer-status";
    const footerText = document.createElement("span");
    footerText.id = "footer-text";
    const footerName = document.createElement("span");
    footerName.id = "footer-name";
    const footerTail = document.createElement("span");
    footerTail.textContent = " is using this tab";
    footerText.append(footerName, footerTail);
    footer.append(footerDot, footerStatus, footerText);

    root.append(style, edgeGlow, cursor, footer);
    document.documentElement.append(host);
    created = true;
  }

  const root = host.shadowRoot;
  const cursor = root.getElementById("cursor");
  const edgeGlow = root.getElementById("edge-glow");
  const label = root.getElementById("label");
  const mark = root.getElementById("mark");
  const pulse = root.getElementById("pulse");
  const footer = root.getElementById("footer");

  // Re-applied every render: one tab can change hands between agents.
  host.style.setProperty("--latch-accent", accent);
  const pointerPath = root.getElementById("pointer-path");
  if (pointerPath) pointerPath.setAttribute("fill", `rgb(${accent})`);

  const glyph = String(state.glyph || "");
  const word = String(state.word || "");
  mark.textContent = glyph;
  // The footer mirrors the agent's tab group title: emoji then word.
  root.getElementById("footer-status").textContent = word ? `${glyph} ${word}` : glyph;
  root.getElementById("footer-name").textContent = String(state.agent || "Agent").slice(0, 36);
  footer.classList.add("active");

  const viewportPadding = 10;
  const target = {
    x: Math.min(Math.max(Number(state.to?.x) || 0, viewportPadding), Math.max(viewportPadding, innerWidth - viewportPadding)),
    y: Math.min(Math.max(Number(state.to?.y) || 0, viewportPadding), Math.max(viewportPadding, innerHeight - viewportPadding)),
  };
  const from = {
    x: Math.min(Math.max(Number(state.from?.x) || target.x, viewportPadding), Math.max(viewportPadding, innerWidth - viewportPadding)),
    y: Math.min(Math.max(Number(state.from?.y) || target.y, viewportPadding), Math.max(viewportPadding, innerHeight - viewportPadding)),
  };

  label.textContent = String(state.label || "Agent").slice(0, 36);
  cursor.classList.toggle("flip", target.x > innerWidth - 155);
  cursor.classList.add("visible");
  edgeGlow.classList.add("active");

  if (created) {
    host.style.setProperty("--latch-cursor-x", `${from.x}px`);
    host.style.setProperty("--latch-cursor-y", `${from.y}px`);
    cursor.getBoundingClientRect();
  }

  if (state.pulse) {
    pulse.classList.remove("active");
    void pulse.offsetWidth;
    pulse.classList.add("active");
  }

  requestAnimationFrame(() => {
    host.style.setProperty("--latch-cursor-x", `${target.x}px`);
    host.style.setProperty("--latch-cursor-y", `${target.y}px`);
  });

  clearTimeout(host.__latchCursorHideTimer);
  host.__latchCursorHideTimer = setTimeout(() => {
    cursor.classList.remove("visible");
    // The pointer retreats between actions; the footer does not, because the
    // agent still holds the tab.
    if (mark.textContent !== "✅") mark.textContent = "⏳";
  }, Math.max(350, Number(state.durationMs) || 1_000));

  return new Promise((resolve) => {
    setTimeout(() => resolve({ x: target.x, y: target.y }), Math.max(0, Number(state.waitMs) || 0));
  });
}

function removeLatchCursorFromPage(elementId) {
  const host = document.getElementById(elementId);
  if (host?.dataset.latchCursor === "true") {
    host.remove();
    return true;
  }
  return false;
}

async function showLatchCursor(
  tabId,
  {
    x,
    y,
    agent = DEFAULT_AGENT_NAME,
    label,
    status = "working",
    pulse = false,
    waitMs = 0,
    durationMs = 1_000,
  } = {},
) {
  const previous = cursorPositions.get(tabId) ?? { x: 28, y: 28 };
  const target = {
    x: Number.isFinite(x) ? x : previous.x,
    y: Number.isFinite(y) ? y : previous.y,
  };
  cursorPositions.set(tabId, target);
  try {
    return await evaluate(
      tabId,
      functionExpression(renderLatchCursor, LATCH_CURSOR_ELEMENT_ID, {
        from: previous,
        to: target,
        agent,
        label: label ?? agent,
        glyph: statusInfo(status).glyph,
        word: statusInfo(status).word,
        accent: accentRgbForAgent(agent),
        pulse,
        waitMs,
        durationMs,
      }),
      { awaitPromise: true },
    );
  } catch {
    return null;
  }
}

async function removeLatchCursor(tabId) {
  cursorPositions.delete(tabId);
  try {
    await evaluate(tabId, functionExpression(removeLatchCursorFromPage, LATCH_CURSOR_ELEMENT_ID));
  } catch {
    // The tab may already be navigating or closed.
  }
}

function snapshotPage(maxElements, refAttribute) {
  const normalize = (value, limit = 240) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= innerHeight &&
      rect.left <= innerWidth
    );
  };
  const labelFor = (element) => {
    if (element.getAttribute("aria-label")) return element.getAttribute("aria-label");
    if (element.labels?.length) return [...element.labels].map((label) => label.innerText).join(" ");
    return (
      element.alt ||
      element.title ||
      element.placeholder ||
      element.innerText ||
      (element.type === "password" ? "" : element.value) ||
      ""
    );
  };

  querySelectorAllDeep(`[${refAttribute}]`).forEach((element) => element.removeAttribute(refAttribute));
  const selector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[role]",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const candidates = querySelectorAllDeep(selector).filter(isVisible).slice(0, maxElements);
  const elements = candidates.map((element, index) => {
    const ref = `e${index + 1}`;
    element.setAttribute(refAttribute, ref);
    const rect = element.getBoundingClientRect();
    return {
      ref,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      name: normalize(labelFor(element)),
      text: normalize(element.innerText),
      type: element.getAttribute("type") || undefined,
      placeholder: normalize(element.getAttribute("placeholder")),
      value:
        element instanceof HTMLInputElement && element.type === "password"
          ? "[password]"
          : normalize(element.value),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });

  // Where the page is scrolled to, and what else can scroll. Without this a
  // caller has no way to know there is more page below the fold, and `elements`
  // only ever describes what is currently on screen.
  const overflows = (value) => value === "auto" || value === "scroll" || value === "overlay";
  const scrollStateOf = (element, isPage) => {
    const scrollableY = Math.max(0, element.scrollHeight - element.clientHeight);
    const scrollableX = Math.max(0, element.scrollWidth - element.clientWidth);
    return {
      isPage,
      x: Math.round(element.scrollLeft),
      y: Math.round(element.scrollTop),
      scrollHeight: Math.round(element.scrollHeight),
      clientHeight: Math.round(element.clientHeight),
      scrollsVertically: scrollableY > 1,
      scrollsHorizontally: scrollableX > 1,
      atTop: element.scrollTop <= 1,
      atBottom: scrollableY - element.scrollTop <= 1,
      percent: scrollableY > 0 ? Math.round((element.scrollTop / scrollableY) * 100) : 100,
    };
  };

  const page = document.scrollingElement || document.documentElement;
  const scrollers = [];
  let scrollerIndex = 0;
  for (const element of querySelectorAllDeep("*")) {
    const style = getComputedStyle(element);
    const scrollsDown = overflows(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    const scrollsAcross = overflows(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    if (!scrollsDown && !scrollsAcross) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) continue;
    const area =
      Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) *
      Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    if (area <= 0) continue;
    // Reuse the ref this element already has if it is also an interactive one.
    const ref = element.getAttribute(refAttribute) || `s${++scrollerIndex}`;
    element.setAttribute(refAttribute, ref);
    scrollers.push({
      ref,
      area,
      tag: element.tagName.toLowerCase(),
      name: normalize(element.getAttribute("aria-label") || element.id || element.classList[0], 60),
      ...scrollStateOf(element, false),
    });
  }
  // The biggest on-screen container first: on a page whose window does not
  // scroll, that is the one "scroll down" will act on.
  scrollers.sort((a, b) => b.area - a.area);
  scrollers.forEach((entry) => delete entry.area);

  const fullText = String(innerTextDeep());
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    scroll: scrollStateOf(page, true),
    // Inner containers, when the window itself is not what scrolls. Pass one of
    // these refs to browser_scroll to move that container specifically.
    scrollers: scrollers.slice(0, 5),
    text: normalize(fullText, 20_000),
    textLength: fullText.length,
    textTruncated: fullText.length > 20_000,
    elements,
  };
}

async function browserSnapshot(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const maxElements = Math.min(Math.max(params.maxElements ?? 200, 1), 500);
  const snapshot = await evaluate(tabId, functionExpression(snapshotPage, maxElements, REF_ATTRIBUTE));
  recordActivity(
    "read",
    `Read page state (${snapshot.elements.length} elements, ${snapshot.scroll.percent}% scrolled)`,
    { tabId },
  );
  return { tabId, ...snapshot };
}

/**
 * Finds the element that actually scrolls, and moves it. Runs in the page.
 *
 * Most agent scrolling fails because the window does not scroll at all: the
 * content lives in an inner container (mail, chat, dashboards, modals). When
 * the document cannot scroll, the largest scrollable container on screen is
 * used instead, so "scroll down" means the same thing everywhere.
 */
function scrollPage(request, refAttribute) {
  const doc = document.scrollingElement || document.documentElement;
  const canScrollY = (el) => Boolean(el) && el.scrollHeight > el.clientHeight + 1;
  const canScrollX = (el) => Boolean(el) && el.scrollWidth > el.clientWidth + 1;
  const scrollable = (el) => canScrollY(el) || canScrollX(el);

  const findScroller = () => {
    if (scrollable(doc)) return doc;
    let best = null;
    let bestArea = 0;
    const overflows = (value) => value === "auto" || value === "scroll" || value === "overlay";
    for (const element of querySelectorAllDeep("*")) {
      const style = getComputedStyle(element);
      const scrollsDown = overflows(style.overflowY) && canScrollY(element);
      const scrollsAcross = overflows(style.overflowX) && canScrollX(element);
      if (!scrollsDown && !scrollsAcross) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      // Rank by how much of the viewport the container occupies, so the main
      // content region wins over a small sidebar or dropdown.
      const area =
        Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) *
        Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      if (area > bestArea) {
        bestArea = area;
        best = element;
      }
    }
    return best ?? doc;
  };

  let scroller = null;
  let target = null;
  if (request.ref || request.selector) {
    const selector = request.ref
      ? `[${refAttribute}="${CSS.escape(request.ref)}"]`
      : request.selector;
    target = querySelectorDeep(selector);
    if (!target) throw new Error(`Element not found: ${selector}`);
    // A scrollable element the caller names is scrolled itself. Anything else
    // is brought into view inside whichever container holds it.
    if (scrollable(target)) scroller = target;
  }
  scroller = scroller ?? findScroller();

  const describe = (element) => {
    if (element === doc) return "page";
    const id = element.id ? `#${element.id}` : "";
    const cls = element.classList[0] ? `.${element.classList[0]}` : "";
    return `${element.tagName.toLowerCase()}${id}${cls}`;
  };
  const measure = () => ({
    x: Math.round(scroller.scrollLeft),
    y: Math.round(scroller.scrollTop),
    scrollWidth: Math.round(scroller.scrollWidth),
    scrollHeight: Math.round(scroller.scrollHeight),
    clientWidth: Math.round(scroller.clientWidth),
    clientHeight: Math.round(scroller.clientHeight),
  });

  const before = measure();
  const to = String(request.to || "down").toLowerCase();
  const broughtIntoView = Boolean(target) && scroller !== target;

  if (broughtIntoView) {
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  } else if (to !== "none") {
    // A page-sized step keeps a strip of overlap, so nothing is skipped between
    // one screenful and the next.
    const step = Math.max(1, scroller.clientHeight - 80);
    const amount = Number.isFinite(request.amount) ? Math.abs(request.amount) : step;
    if (to === "top") scroller.scrollTo({ top: 0, behavior: "instant" });
    else if (to === "bottom") scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
    else if (to === "up") scroller.scrollBy({ top: -amount, behavior: "instant" });
    else if (to === "left") scroller.scrollBy({ left: -amount, behavior: "instant" });
    else if (to === "right") scroller.scrollBy({ left: amount, behavior: "instant" });
    else scroller.scrollBy({ top: amount, behavior: "instant" });
  }

  const after = measure();
  const rect = scroller === doc ? null : scroller.getBoundingClientRect();
  const scrollableY = Math.max(0, after.scrollHeight - after.clientHeight);
  return {
    scroller: describe(scroller),
    isPage: scroller === doc,
    // Where to aim a real wheel event if the JavaScript scroll did not take.
    point: rect
      ? {
          x: Math.round(Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1)),
          y: Math.round(Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1)),
        }
      : { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) },
    broughtIntoView,
    before,
    after,
    movedX: after.x - before.x,
    movedY: after.y - before.y,
    atTop: after.y <= 1,
    atBottom: scrollableY - after.y <= 1,
    remaining: Math.max(0, scrollableY - after.y),
    percent: scrollableY > 0 ? Math.round((after.y / scrollableY) * 100) : 100,
  };
}

function locateElement(target, refAttribute) {
  const selector = target.ref ? `[${refAttribute}="${CSS.escape(target.ref)}"]` : target.selector;
  if (!selector) {
    throw new Error("Provide an element ref from browser_snapshot or a CSS selector.");
  }
  const element = querySelectorDeep(selector);
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error(`Element is not visible: ${selector}`);
  }
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    tag: element.tagName.toLowerCase(),
  };
}

async function browserClick(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const point = await evaluate(
    tabId,
    functionExpression(locateElement, { ref: params.ref, selector: params.selector }, REF_ATTRIBUTE),
  );
  await showLatchCursor(tabId, { x: point.x, y: point.y, agent, status: "working", waitMs: 280, durationMs: 1_150 });
  await showLatchCursor(tabId, {
    x: point.x,
    y: point.y,
    agent,
    label: `${agent} · Click`,
    status: "click",
    pulse: true,
    durationMs: 1_150,
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  recordActivity("action", `Clicked ${params.ref ?? params.selector}`, { tabId });
  return { tabId, clicked: params.ref ?? params.selector, point };
}

/**
 * Scrolls the page, a named container, or an element into view.
 *
 * The page is measured before and after, so the caller is told how far it
 * actually moved and how much is left. When a page hijacks the wheel instead of
 * using a real scroll container, the JavaScript scroll moves nothing; a genuine
 * wheel event is sent as a second attempt rather than silently doing nothing.
 */
async function browserScroll(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const to = String(params.to ?? params.direction ?? "down").toLowerCase();
  const request = { ref: params.ref, selector: params.selector, to, amount: params.amount };
  let result = await evaluate(tabId, functionExpression(scrollPage, request, REF_ATTRIBUTE));
  let method = "script";

  const stuck =
    !result.broughtIntoView &&
    result.movedX === 0 &&
    result.movedY === 0 &&
    !(to === "top" ? result.atTop : to === "bottom" ? result.atBottom : false);

  if (stuck && to !== "none") {
    const step = Math.max(1, result.after.clientHeight - 80);
    const amount = Number.isFinite(params.amount) ? Math.abs(params.amount) : step;
    const deltas = {
      up: { deltaX: 0, deltaY: -amount },
      down: { deltaX: 0, deltaY: amount },
      left: { deltaX: -amount, deltaY: 0 },
      right: { deltaX: amount, deltaY: 0 },
      top: { deltaX: 0, deltaY: -result.after.scrollHeight },
      bottom: { deltaX: 0, deltaY: result.after.scrollHeight },
    };
    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: result.point.x,
      y: result.point.y,
      ...(deltas[to] ?? deltas.down),
    });
    result = await evaluate(
      tabId,
      functionExpression(scrollPage, { ...request, to: "none" }, REF_ATTRIBUTE),
    );
    method = "wheel";
  }

  await showLatchCursor(tabId, {
    x: result.point.x,
    y: result.point.y,
    agent,
    label: `${agent} \u00B7 Scroll`,
    status: "scrolling",
    durationMs: 900,
  });

  const moved = result.movedX !== 0 || result.movedY !== 0 || result.broughtIntoView;
  recordActivity(
    "action",
    result.broughtIntoView
      ? `Scrolled ${params.ref ?? params.selector} into view`
      : `Scrolled ${to} in ${result.scroller} (${result.percent}%)`,
    { tabId },
  );
  return {
    tabId,
    ...result,
    method,
    moved,
    // Nothing moved and nothing is in the way: say so, rather than returning a
    // success the caller cannot distinguish from a real scroll.
    note: moved
      ? undefined
      : result.atBottom && (to === "down" || to === "bottom")
        ? "Already at the bottom of this scroller."
        : result.atTop && (to === "up" || to === "top")
          ? "Already at the top of this scroller."
          : `Nothing scrolled. Pass a selector for the container that holds the content, or use browser_press_key with PageDown.`,
  };
}

function focusElement(target, refAttribute, clear) {
  const selector = target.ref ? `[${refAttribute}="${CSS.escape(target.ref)}"]` : target.selector;
  if (!selector) throw new Error("Provide an element ref from browser_snapshot or a CSS selector.");
  const element = querySelectorDeep(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  element.focus();

  if (clear) {
    if (element.isContentEditable) {
      // Use the browser selection instead of directly mutating the DOM. A
      // controlled input (for example React) can otherwise restore its old
      // value between this call and CDP's Input.insertText, causing an append.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else if ("value" in element) {
      if (typeof element.select === "function") {
        element.select();
      } else if (typeof element.setSelectionRange === "function") {
        element.setSelectionRange(0, String(element.value ?? "").length);
      }
    }
  } else if (typeof element.setSelectionRange === "function") {
    element.setSelectionRange(element.value.length, element.value.length);
  }
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName.toLowerCase(),
    selector,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

async function browserType(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const target = await evaluate(
    tabId,
    functionExpression(
      focusElement,
      { ref: params.ref, selector: params.selector },
      REF_ATTRIBUTE,
      params.clear !== false,
    ),
  );
  await showLatchCursor(tabId, {
    x: target.x,
    y: target.y,
    agent,
    label: `${agent} · Typing`,
    status: "type",
    waitMs: 240,
    durationMs: 1_200,
  });
  await sendDebuggerCommand(tabId, "Input.insertText", { text: params.text ?? "" });
  recordActivity("action", `Typed into ${params.ref ?? params.selector}`, {
    tabId,
    characterCount: (params.text ?? "").length,
  });
  return { tabId, target, characterCount: (params.text ?? "").length };
}

const KEY_CODES = {
  Enter: { code: "Enter", keyCode: 13 },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32 },
};

async function browserPressKey(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const key = params.key;
  const definition = KEY_CODES[key] ?? {
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
  };
  const common = {
    key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  };
  await showLatchCursor(tabId, { agent, label: `${agent} · ${key}`, status: "key", durationMs: 1_000 });
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...common });
  if (key.length === 1) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "char",
      ...common,
      text: key,
      unmodifiedText: key,
    });
  }
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...common });
  recordActivity("action", `Pressed ${key}`, { tabId });
  return { tabId, key };
}

async function waitForTabComplete(tabId, timeoutMs) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") {
    return existing;
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(browserError("NAVIGATION_TIMEOUT", `Navigation did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForControllableTab(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(updatedListener);
      chrome.tabs.onRemoved.removeListener(removedListener);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const finishIfReady = (tab) => {
      if (tab?.status === "complete" && isControllableUrl(tab.url)) {
        finish(resolve, tab);
      }
    };
    const updatedListener = (updatedTabId, _changeInfo, tab) => {
      if (updatedTabId === tabId) {
        finishIfReady(tab);
      }
    };
    const removedListener = (removedTabId) => {
      if (removedTabId === tabId) {
        finish(reject, browserError("TAB_CLOSED", "The new tab was closed before it finished loading."));
      }
    };
    const timeout = setTimeout(() => {
      finish(
        reject,
        browserError("NAVIGATION_TIMEOUT", `The new tab did not load a controllable page within ${timeoutMs}ms`),
      );
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(updatedListener);
    chrome.tabs.onRemoved.addListener(removedListener);
    chrome.tabs.get(tabId).then(finishIfReady).catch((error) => finish(reject, error));
  });
}

async function browserNavigate(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  if (!isControllableUrl(params.url)) {
    throw browserError("UNSUPPORTED_PAGE", "Chrome internal pages and extension pages cannot be controlled.");
  }
  await showLatchCursor(tabId, { agent, label: `${agent} · Navigating`, status: "navigate", waitMs: 140, durationMs: 900 });
  await chrome.tabs.update(tabId, { url: params.url });
  const tab = await waitForTabComplete(tabId, params.timeoutMs ?? 20_000);
  await showLatchCursor(tabId, { x: 28, y: 28, agent, label: `${agent} · Loaded`, status: "done", durationMs: 1_000 });
  recordActivity("navigate", `Navigated to ${tab.url}`, { tabId });
  return { tabId, url: tab.url, title: tab.title };
}

function pageContains(selector, text) {
  if (selector) {
    const element = querySelectorDeep(selector);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
  }
  if (text && !innerTextDeep().includes(text)) return false;
  return Boolean(selector || text);
}

async function browserWaitFor(params, agent = DEFAULT_AGENT_NAME) {
  if (!params.selector && !params.text) {
    throw browserError("INVALID_TARGET", "Provide a selector or text to wait for.");
  }
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const timeoutMs = params.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const found = await evaluate(tabId, functionExpression(pageContains, params.selector, params.text));
    if (found) {
      return { tabId, found: true, selector: params.selector, text: params.text };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw browserError("WAIT_TIMEOUT", `Page condition was not met within ${timeoutMs}ms.`);
}

async function browserScreenshot(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const captureParams = { format: "png", captureBeyondViewport: Boolean(params.fullPage) };
  if (params.fullPage) {
    const metrics = await sendDebuggerCommand(tabId, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    captureParams.clip = {
      x: 0,
      y: 0,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      scale: 1,
    };
  }
  const result = await sendDebuggerCommand(tabId, "Page.captureScreenshot", captureParams);
  const tab = await chrome.tabs.get(tabId);
  recordActivity("read", `Captured ${params.fullPage ? "full-page" : "viewport"} screenshot`, { tabId });
  return {
    tabId,
    url: tab.url,
    fullPage: Boolean(params.fullPage),
    mimeType: "image/png",
    data: result.data,
  };
}

async function browserConsole(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const messages = [...(consoleMessages.get(tabId) ?? [])];
  if (params.clear) {
    consoleMessages.set(tabId, []);
  }
  return { tabId, messages };
}

async function browserNetwork(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  const entries = [...(networkEntries.get(tabId)?.values() ?? [])];
  if (params.clear) {
    networkEntries.set(tabId, new Map());
  }
  return { tabId, entries };
}

async function browserEvaluate(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  await showLatchCursor(tabId, { agent, label: `${agent} · Running`, status: "working", durationMs: 1_000 });
  const value = await evaluate(tabId, params.expression, { awaitPromise: true });
  recordActivity("evaluate", "Evaluated JavaScript", { tabId });
  return { tabId, value };
}

async function browserTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      attached: attachedTabs.has(tab.id),
      agent: tabAgents.get(tab.id) ?? null,
      groupId: tab.groupId,
    })),
  };
}

/** Attached tabs grouped by the agent that owns them. */
function agentSummary() {
  const summary = {};
  for (const [tabId, agent] of tabAgents.entries()) {
    if (!attachedTabs.has(tabId)) continue;
    (summary[agent] ??= []).push(tabId);
  }
  return summary;
}

async function browserStatus(_params, agent = null) {
  const tabs = await browserTabs();
  return {
    connected: Boolean(nativePort),
    // The name this caller is actually using, which may be a callsign variant
    // of the one it asked for.
    agent,
    attachedTabIds: [...attachedTabs],
    agents: agentSummary(),
    statuses: statusSummary(),
    ...tabs,
  };
}

function comparableUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.href;
  } catch {
    return String(url || "");
  }
}

/** Only reuse a tab sitting in this agent's own group, never anyone else's. */
async function tabBelongsToAgent(tab, agent) {
  return (await agentForTab(tab)) === agent;
}

async function activateTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return chrome.tabs.update(tabId, { active: true });
}

async function browserOpen(params, agent = DEFAULT_AGENT_NAME) {
  const url = params.url;
  if (!isControllableUrl(url)) {
    throw browserError("UNSUPPORTED_PAGE", "Chrome internal pages and extension pages cannot be controlled.");
  }

  if (params.reuseExisting !== false) {
    const tabs = (await chrome.tabs.query({})).filter((tab) => isControllableUrl(tab.url));
    const exactUrl = comparableUrl(url);
    // Only tabs already in this agent's group are reuse candidates. A matching
    // URL is not a claim on someone else's tab, or on one of the user's.
    const exactMatches = tabs
      .filter((tab) => comparableUrl(tab.url) === exactUrl)
      .sort((left, right) => Number(attachedTabs.has(right.id)) - Number(attachedTabs.has(left.id)));
    let selected = null;
    for (const candidate of exactMatches) {
      if (await tabBelongsToAgent(candidate, agent)) {
        selected = candidate;
        break;
      }
    }

    if (!selected && params.reuseSiteTab !== false) {
      const requestedOrigin = originForUrl(url);
      const sameSiteTabs = tabs.filter((tab) => originForUrl(tab.url) === requestedOrigin);
      for (const candidate of sameSiteTabs) {
        if (await tabBelongsToAgent(candidate, agent)) {
          selected = candidate;
          break;
        }
      }
    }

    if (selected) {
      if (params.active === true) {
        await activateTab(selected.id);
      }
      const attached = await attachTab(selected.id, agent);
      if (comparableUrl(selected.url) !== exactUrl) {
        const navigated = await browserNavigate({
          tabId: selected.id,
          url,
          timeoutMs: params.timeoutMs ?? 20_000,
        }, agent);
        return { opened: false, reused: true, ...attached, ...navigated };
      }
      recordActivity("tab", `Reused ${selected.url}`, { tabId: selected.id });
      return { opened: false, reused: true, ...attached };
    }
  }

  return browserNewTab(
    {
      url,
      attach: params.attach !== false,
      active: params.active === true,
      timeoutMs: params.timeoutMs ?? 20_000,
    },
    agent,
  );
}

async function browserNewTab(params, agent = DEFAULT_AGENT_NAME) {
  const url = params.url ?? "https://example.com";
  if (!isControllableUrl(url)) {
    throw browserError("UNSUPPORTED_PAGE", "Chrome internal pages and extension pages cannot be controlled.");
  }

  const createdTab = await chrome.tabs.create({ url, active: params.active === true });
  try {
    const loadedTab = await waitForControllableTab(createdTab.id, params.timeoutMs ?? 20_000);
    recordActivity("tab", `Opened ${loadedTab.url}`, { tabId: loadedTab.id });
    if (params.attach === false) {
      return {
        tabId: loadedTab.id,
        title: loadedTab.title,
        url: loadedTab.url,
        attached: false,
        active: loadedTab.active,
        groupId: loadedTab.groupId,
      };
    }
    return { opened: true, active: loadedTab.active, ...(await attachTab(loadedTab.id, agent)) };
  } catch (error) {
    await chrome.tabs.remove(createdTab.id).catch(() => {});
    throw error;
  }
}

async function browserCloseTab(params, agent = DEFAULT_AGENT_NAME) {
  const tabId = await resolveAttachedTabId(params.tabId, agent);
  await chrome.tabs.remove(tabId);
  attachedTabs.delete(tabId);
  consoleMessages.delete(tabId);
  networkEntries.delete(tabId);
  recordActivity("tab", `Closed tab ${tabId}`, { tabId });
  return { tabId, closed: true };
}

// The status an agent shows while a command runs, and the one it settles on
// when the command succeeds. Attaching rests on "connected" and detaching on
// "idle"; everything else rests on "done".
const COMMAND_STATUSES = {
  browser_attach: { busy: "connected", rest: "connected" },
  browser_detach: { busy: "idle", rest: "idle" },
  browser_snapshot: { busy: "reading", rest: "done" },
  browser_scroll: { busy: "scrolling", rest: "done" },
  browser_navigate: { busy: "navigating", rest: "done" },
  browser_open: { busy: "navigating", rest: "done" },
  browser_new_tab: { busy: "navigating", rest: "done" },
  browser_click: { busy: "clicking", rest: "done" },
  browser_type: { busy: "typing", rest: "done" },
  browser_press_key: { busy: "typing", rest: "done" },
  browser_wait_for: { busy: "waiting", rest: "done" },
  browser_screenshot: { busy: "reading", rest: "done" },
  browser_console: { busy: "reading", rest: "done" },
  browser_network: { busy: "reading", rest: "done" },
  browser_evaluate: { busy: "working", rest: "done" },
  browser_close_tab: { busy: "working", rest: "done" },
};

async function dispatchBrowserCommand(method, params) {
  const request = params ?? {};
  // The caller names itself, but two sessions of the same agent ask for the
  // same name. The registry hands the second one a callsign instead.
  const requested = normalizeAgentName(request.agent) ?? DEFAULT_AGENT_NAME;
  await hydrateAgentSessions();
  const agent = claimAgentName(requested, normalizeSessionId(request.session));
  const commands = {
    browser_status: browserStatus,
    browser_tabs: browserTabs,
    browser_attach: ({ tabId }) => attachTab(tabId, agent),
    browser_detach: ({ tabId }) => detachTab(tabId, "Detached by agent", agent),
    browser_snapshot: browserSnapshot,
    browser_scroll: browserScroll,
    browser_navigate: browserNavigate,
    browser_click: browserClick,
    browser_type: browserType,
    browser_press_key: browserPressKey,
    browser_wait_for: browserWaitFor,
    browser_screenshot: browserScreenshot,
    browser_console: browserConsole,
    browser_network: browserNetwork,
    browser_evaluate: browserEvaluate,
    browser_open: browserOpen,
    browser_new_tab: browserNewTab,
    browser_close_tab: browserCloseTab,
  };
  const command = commands[method];
  if (!command) {
    throw browserError("UNKNOWN_COMMAND", `Unknown browser command: ${method}`);
  }

  // browser_status and browser_tabs only read extension state, so they are not
  // in the table and leave the tab group title alone.
  const transition = COMMAND_STATUSES[method];
  if (!transition) {
    return command(request, agent);
  }

  setAgentStatus(agent, transition.busy);
  try {
    const result = await command(request, agent);
    setAgentStatus(agent, transition.rest);
    return result;
  } catch (error) {
    setAgentStatus(agent, "error");
    throw error;
  }
}

function addConsoleMessage(tabId, message) {
  const messages = consoleMessages.get(tabId) ?? [];
  messages.push(message);
  if (messages.length > MAX_CONSOLE_MESSAGES) {
    messages.splice(0, messages.length - MAX_CONSOLE_MESSAGES);
  }
  consoleMessages.set(tabId, messages);
}

function valueFromRuntimeObject(runtimeObject) {
  if (runtimeObject.value !== undefined) return runtimeObject.value;
  return runtimeObject.description ?? runtimeObject.type;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId || !attachedTabs.has(tabId)) {
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    addConsoleMessage(tabId, {
      level: params.type,
      text: params.args.map(valueFromRuntimeObject).join(" "),
      timestamp: new Date(params.timestamp).toISOString(),
      stack: params.stackTrace,
    });
  } else if (method === "Runtime.exceptionThrown") {
    addConsoleMessage(tabId, {
      level: "error",
      text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text,
      timestamp: new Date(params.timestamp).toISOString(),
      stack: params.exceptionDetails.stackTrace,
    });
  } else if (method === "Log.entryAdded") {
    addConsoleMessage(tabId, {
      level: params.entry.level,
      text: params.entry.text,
      timestamp: new Date(params.entry.timestamp).toISOString(),
      url: params.entry.url,
      lineNumber: params.entry.lineNumber,
    });
  } else if (method === "Network.requestWillBeSent") {
    const entries = networkEntries.get(tabId) ?? new Map();
    entries.set(params.requestId, {
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      resourceType: params.type,
      timestamp: params.wallTime ? new Date(params.wallTime * 1000).toISOString() : new Date().toISOString(),
    });
    while (entries.size > MAX_NETWORK_ENTRIES) {
      entries.delete(entries.keys().next().value);
    }
    networkEntries.set(tabId, entries);
  } else if (method === "Network.responseReceived") {
    const entries = networkEntries.get(tabId) ?? new Map();
    const entry = entries.get(params.requestId) ?? { requestId: params.requestId, url: params.response.url };
    Object.assign(entry, {
      status: params.response.status,
      statusText: params.response.statusText,
      mimeType: params.response.mimeType,
      fromDiskCache: params.response.fromDiskCache,
    });
    entries.set(params.requestId, entry);
    networkEntries.set(tabId, entries);
  } else if (method === "Network.loadingFailed") {
    const entries = networkEntries.get(tabId) ?? new Map();
    const entry = entries.get(params.requestId) ?? { requestId: params.requestId };
    Object.assign(entry, { failed: true, errorText: params.errorText, canceled: params.canceled });
    entries.set(params.requestId, entry);
    networkEntries.set(tabId, entries);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    const activityReason = requestedDetachReasons.get(source.tabId) ?? `Chrome detached the tab: ${reason}`;
    void clearTabOwnership(source.tabId, activityReason);
  }
});

async function adoptAgentOwnedTab(tab, agent, reason) {
  if (!tab?.id || attachedTabs.has(tab.id) || attachingTabs.has(tab.id)) {
    return;
  }
  try {
    const readyTab = isControllableUrl(tab.url)
      ? tab
      : await waitForControllableTab(tab.id, 20_000);
    await attachTab(readyTab.id, agent);
    recordActivity("tab", reason, { tabId: readyTab.id, url: readyTab.url, agent });
  } catch (error) {
    if (!String(error.message).includes("closed") && !String(error.message).includes("timed out")) {
      recordActivity("error", `Could not adopt tab: ${error.message}`, { tabId: tab.id });
    }
  }
}

async function adoptTabsInAgentGroup(groupId) {
  let group;
  try {
    group = await chrome.tabGroups.get(groupId);
  } catch {
    return;
  }
  // Only groups named after an agent we have actually seen are adopted, so a
  // user's own tab groups are left alone.
  const agent = knownAgentFromGroupTitle(group.title);
  if (!agent) {
    return;
  }
  agentGroupsByKey.set(groupKey(group.windowId, agent), group.id);
  const tabs = await chrome.tabs.query({ groupId: group.id });
  await Promise.allSettled(
    tabs.map((tab) => adoptAgentOwnedTab(tab, agent, `Adopted tab from the ${agent} group`)),
  );
}

chrome.tabs.onCreated.addListener((tab) => {
  // A tab inherits the agent of whichever tab opened it, or of the agent group
  // it was created inside.
  const openerAgent = tab.openerTabId && attachedTabs.has(tab.openerTabId)
    ? tabAgents.get(tab.openerTabId) ?? null
    : null;
  const agent = openerAgent ?? agentForGroupId(tab.groupId);
  if (agent) {
    void adoptAgentOwnedTab(tab, agent, `Adopted a tab opened by ${agent}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  attachingTabs.delete(tabId);
  cursorPositions.delete(tabId);
  consoleMessages.delete(tabId);
  networkEntries.delete(tabId);
  tabAgents.delete(tabId);
});

/**
 * Reconcile an attached tab with the group it now sits in. Dragging a tab from
 * one agent's group to another hands it over; dragging it out of every agent
 * group detaches it, so no agent keeps driving a tab outside its workspace.
 */
async function reconcileTabGroup(tabId) {
  // An attach in flight is mid-way through creating and titling its group, so
  // the group legitimately looks nameless for a moment.
  if (attachingTabs.has(tabId)) return;
  let owner;
  try {
    owner = await agentOwningGroup(await chrome.tabs.get(tabId));
  } catch {
    return;
  }
  const recorded = tabAgents.get(tabId) ?? null;
  if (owner === recorded) return;
  if (owner) {
    tabAgents.set(tabId, owner);
    rememberAgent(owner);
    setAgentStatus(owner, "connected");
    recordActivity("tab", `Moved into the ${owner} group`, { tabId, agent: owner });
    return;
  }
  await detachTab(tabId, "Detached after being moved out of its agent group");
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (attachedTabs.has(tabId) && changeInfo.url && !isControllableUrl(changeInfo.url)) {
    void detachTab(tabId, "Detached because Chrome does not allow control of this page");
    return;
  }
  if (attachedTabs.has(tabId) && changeInfo.groupId !== undefined) {
    void reconcileTabGroup(tabId);
    return;
  }
  if (!attachedTabs.has(tabId) && changeInfo.groupId !== undefined) {
    void agentForTab(tab).then((agent) => {
      if (agent) {
        void adoptAgentOwnedTab(tab, agent, `Adopted a tab moved into the ${agent} group`);
      }
    });
  }
});

chrome.tabGroups.onCreated.addListener((group) => {
  if (knownAgentFromGroupTitle(group.title)) {
    void adoptTabsInAgentGroup(group.id);
  }
});

chrome.tabGroups.onUpdated.addListener((group) => {
  const agent = knownAgentFromGroupTitle(group.title);
  if (!agent) {
    return;
  }
  // Latch rewrites the title on every status change, which fires this listener.
  // Skip our own writes; re-running adoption twice per command would retry
  // attaching any tab in the group that cannot be attached.
  const owned = agentGroupsByKey.get(groupKey(group.windowId, agent)) === group.id;
  if (owned && group.title === groupTitleFor(agent, statusForAgent(agent))) {
    return;
  }
  void adoptTabsInAgentGroup(group.id);
});

chrome.tabGroups.onRemoved.addListener((group) => {
  const orphaned = new Set();
  for (const [key, id] of agentGroupsByKey.entries()) {
    if (id !== group.id) continue;
    orphaned.add(key.slice(key.indexOf("::") + 2));
    agentGroupsByKey.delete(key);
  }
  // Drop the status once an agent holds no groups at all, so a stale "Done"
  // does not reappear on its next group.
  for (const agent of orphaned) {
    const stillOwns = [...agentGroupsByKey.keys()].some((key) => key.endsWith(`::${agent}`));
    if (!stillOwns) agentStatuses.delete(agent);
  }
});

async function uiState() {
  const tab = await currentTab();
  return {
    connected: Boolean(nativePort),
    currentTab: tab
      ? {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          origin: originForUrl(tab.url),
          controllable: isControllableUrl(tab.url),
          attached: attachedTabs.has(tab.id),
        }
      : null,
    attachedTabIds: [...attachedTabs],
    agents: agentSummary(),
    statuses: statusSummary(),
    activity: activity.slice(0, 10),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    ui_get_state: () => uiState(),
    // The popup is a person acting directly, so it gets its own group label.
    ui_attach: async ({ tabId, agent }) => {
      await hydrateAgentSessions();
      const name = claimAgentName(normalizeAgentName(agent) ?? "Me", "ui:popup");
      return attachTab(tabId, name, { takeover: true });
    },
    ui_detach: ({ tabId }) => detachTab(tabId),
    ui_retry_connection: async () => {
      if (nativePort) {
        nativePort.disconnect();
        nativePort = null;
      }
      connectNativeHost();
      return { retrying: true };
    },
  };
  const handler = handlers[message?.type];
  if (!handler) {
    return false;
  }
  Promise.resolve(handler(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message ?? String(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  recordActivity("setup", "Extension installed. Install the native host to connect your agents.");
  connectNativeHost();
});
chrome.runtime.onStartup.addListener(connectNativeHost);
connectNativeHost();
