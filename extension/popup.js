// Minimal Latch popup: connection state, which agents own tabs, and attach/detach
// for the current tab. No chat, no agent session - the CLI and MCP do that work.

const el = (id) => document.getElementById(id);

// Mirrors colorForAgent() in background.js so the swatch matches the tab group.
const GROUP_COLORS = {
  blue: "#3b82f6", cyan: "#06b6d4", green: "#22c55e", grey: "#9ca3af",
  orange: "#f97316", pink: "#ec4899", purple: "#8b5cf6", red: "#ef4444", yellow: "#eab308",
};
const KNOWN = {
  "claude code": "purple", codex: "cyan", gemini: "blue",
  cursor: "orange", deepseek: "green", hermes: "yellow",
};
function colorForAgent(name) {
  const key = String(name || "").trim().toLowerCase();
  if (KNOWN[key]) return GROUP_COLORS[KNOWN[key]];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[Object.keys(GROUP_COLORS)[hash % 9]];
}

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "Request failed"));
      resolve(response.result);
    });
  });
}

let current = null;

function renderAgents(agents) {
  const box = el("agents");
  box.textContent = "";
  const names = Object.keys(agents || {});
  for (const name of names) {
    const row = document.createElement("div");
    row.className = "agent";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = colorForAgent(name);
    const label = document.createElement("span");
    label.textContent = name;
    const n = document.createElement("span");
    n.className = "n";
    const count = agents[name].length;
    n.textContent = count === 1 ? "1 tab" : `${count} tabs`;
    row.append(sw, label, n);
    box.append(row);
  }
}

function render(state) {
  current = state;
  const connected = Boolean(state.connected);
  el("dot").classList.toggle("on", connected);
  el("status").textContent = connected ? "Connected" : "Offline";

  const total = (state.attachedTabIds || []).length;
  el("count").textContent = total ? (total === 1 ? "1 attached" : `${total} attached`) : "";

  renderAgents(state.agents);

  const tab = state.currentTab;
  el("tab-title").textContent = tab ? tab.title || tab.url : "No active tab";
  el("tab-origin").textContent = tab ? tab.origin || "" : "";

  const button = el("action");
  if (!tab || !tab.controllable) {
    button.disabled = true;
    button.textContent = "Attach";
  } else {
    button.disabled = !connected;
    button.textContent = tab.attached ? "Detach" : "Attach";
  }

  el("offline").classList.toggle("hidden", connected);
  if (!connected) el("ext-id").textContent = chrome.runtime.id;
}

async function refresh() {
  try {
    render(await send("ui_get_state"));
    el("error").textContent = "";
  } catch (error) {
    el("error").textContent = error.message;
  }
}

el("action").addEventListener("click", async () => {
  const tab = current?.currentTab;
  if (!tab) return;
  el("action").disabled = true;
  try {
    // The popup is a person acting directly, so it attaches under its own label
    // rather than impersonating one of the coding agents.
    await send(tab.attached ? "ui_detach" : "ui_attach", { tabId: tab.id, agent: "Me" });
    await refresh();
  } catch (error) {
    el("error").textContent = error.message;
    el("action").disabled = false;
  }
});

el("retry").addEventListener("click", async () => {
  el("error").textContent = "";
  try { await send("ui_retry_connection"); } catch (error) { el("error").textContent = error.message; }
  setTimeout(refresh, 600);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state_updated" || message?.type === "activity_updated") refresh();
});

refresh();
