/**
 * Shared agent identity helpers.
 *
 * Every bridge request carries the name of the agent that issued it. The
 * extension uses that name as the title of the Chrome tab group it puts the
 * agent's tabs in, so several agents can drive the same Chrome profile at the
 * same time and stay visually separated.
 *
 * The pure helpers here (normalizeAgentName / colorForAgent / the status and
 * group-title helpers) are mirrored in extension/background.js, which cannot
 * import from server/. Keep them in sync.
 */

export const AGENT_ENV_VAR = "LATCH_AGENT";
export const SESSION_ENV_VAR = "LATCH_SESSION";
export const DEFAULT_AGENT_NAME = "Agent";
export const MAX_AGENT_NAME_LENGTH = 24;

/** The nine colors chrome.tabGroups accepts. */
export const GROUP_COLORS = ["blue", "cyan", "green", "grey", "orange", "pink", "purple", "red", "yellow"];

/** Stable colors so a given agent always looks the same across sessions. */
export const KNOWN_AGENT_COLORS = {
  "claude code": "purple",
  codex: "cyan",
  gemini: "blue",
  cursor: "orange",
  deepseek: "green",
  hermes: "yellow",
};

/**
 * Environment signatures for agents that run as a CLI. Checked in order, so
 * put the more specific signals first.
 */
const AGENT_ENV_SIGNATURES = [
  { name: "Claude Code", keys: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] },
  { name: "Codex", keys: ["CODEX_SANDBOX", "CODEX_HOME", "CODEX_MODE"] },
  { name: "Cursor", keys: ["CURSOR_AGENT", "CURSOR_TRACE_ID"] },
  { name: "Gemini", keys: ["GEMINI_CLI", "GEMINI_SESSION"] },
  { name: "DeepSeek", keys: ["DEEPSEEK_AGENT", "DEEPSEEK_HARNESS"] },
  { name: "Hermes", keys: ["HERMES_AGENT", "HERMES_SESSION"] },
];

export function normalizeAgentName(raw) {
  if (typeof raw !== "string") return null;
  // Tab group titles are a single line; collapse whitespace and cap the length.
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_AGENT_NAME_LENGTH);
}

export function detectAgentName(env = process.env) {
  const explicit = normalizeAgentName(env[AGENT_ENV_VAR]);
  if (explicit) return explicit;
  for (const { name, keys } of AGENT_ENV_SIGNATURES) {
    if (keys.some((key) => env[key])) return name;
  }
  return DEFAULT_AGENT_NAME;
}

/** Explicit flag wins, then the environment, then the neutral default. */
export function resolveAgentName(explicit, env = process.env) {
  return normalizeAgentName(explicit) ?? detectAgentName(env);
}

/** Small stable string hash, used to spread names and colors over a palette. */
export function hashString(value) {
  const key = String(value ?? "");
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash;
}

export function colorForAgent(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (KNOWN_AGENT_COLORS[key]) return KNOWN_AGENT_COLORS[key];
  return GROUP_COLORS[hashString(key) % GROUP_COLORS.length];
}

// --- Session identity -----------------------------------------------------
// Two Claude Code windows both call themselves "Claude Code". To tell them
// apart, every request also carries an opaque session id, and the extension
// hands the second one a different name. The id has to survive across CLI
// invocations from the same shell, so it is derived from the environment
// rather than generated per process.

/** Session variables agents export, most specific first. */
const SESSION_ENV_KEYS = [
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CURSOR_TRACE_ID",
  "GEMINI_SESSION",
  "DEEPSEEK_SESSION",
  "HERMES_SESSION",
  // Then the terminal the agent runs in, which is stable per window or pane.
  "ITERM_SESSION_ID",
  "TERM_SESSION_ID",
  "TMUX_PANE",
];

/**
 * A stable id for this agent session. Falls back to the parent process id,
 * which is the shell for a CLI call and the agent itself for the MCP server.
 */
export function resolveSessionId(env = process.env, parentPid = process.ppid) {
  const explicit = String(env[SESSION_ENV_VAR] ?? "").trim();
  if (explicit) return explicit.slice(0, 64);
  for (const key of SESSION_ENV_KEYS) {
    const value = String(env[key] ?? "").trim();
    if (value) return `${key}:${value}`.slice(0, 64);
  }
  return `ppid:${parentPid}`;
}

// --- Name collisions ------------------------------------------------------
// When a name is already claimed by another live session, the newcomer takes
// the base name plus a callsign: "Claude Code" becomes "Claude Nova".

export const AGENT_CALLSIGNS = [
  "Nova", "Orion", "Vega", "Atlas", "Echo", "Zephyr", "Onyx", "Quasar",
  "Lynx", "Kodiak", "Falcon", "Cobalt", "Ember", "Sable", "Vertex", "Halo",
  "Rogue", "Titan", "Drift", "Prism", "Comet", "Saber", "Aurora", "Flint",
];

/**
 * The nth callsign variant of a name. The first word is kept as the brand, so
 * "Claude Code" yields "Claude Nova" rather than "Claude Code Nova". The result
 * still fits MAX_AGENT_NAME_LENGTH.
 */
export function callsignName(baseName, index) {
  const root = String(baseName ?? "").trim().split(/\s+/)[0] || DEFAULT_AGENT_NAME;
  const size = AGENT_CALLSIGNS.length;
  const callsign = AGENT_CALLSIGNS[((Math.trunc(index) % size) + size) % size];
  const roomForRoot = MAX_AGENT_NAME_LENGTH - callsign.length - 1;
  return `${root.slice(0, Math.max(1, roomForRoot))} ${callsign}`;
}

// --- Agent status ---------------------------------------------------------
// What an agent is doing right now, as an emoji plus one word. The pair is
// appended to the agent's Chrome tab group title, so the tab strip reports live
// progress, and is shown on the on-page cursor footer and in the popup.

export const AGENT_STATUSES = {
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

/** Older, verb-shaped status names kept working for the on-page cursor. */
export const STATUS_ALIASES = {
  click: "clicking",
  type: "typing",
  key: "typing",
  navigate: "navigating",
  read: "reading",
  scroll: "scrolling",
  wait: "waiting",
};

/** Anything unrecognized falls back to the generic busy state. */
export function statusKey(status) {
  const raw = String(status ?? "").toLowerCase();
  const resolved = STATUS_ALIASES[raw] ?? raw;
  return AGENT_STATUSES[resolved] ? resolved : "working";
}

export function statusInfo(status) {
  return AGENT_STATUSES[statusKey(status)];
}

/** Separates the agent name from its status inside a tab group title. */
export const STATUS_SEPARATOR = " \u00B7 ";

/** The tab group title for an agent in a given status: "Codex \u00B7 \u23F3 Working". */
export function groupTitleFor(agent, status) {
  const info = statusInfo(status);
  return `${agent}${STATUS_SEPARATOR}${info.glyph} ${info.word}`;
}

/** The agent named by a group title, with or without a status suffix. */
export function agentFromGroupTitle(title) {
  if (typeof title !== "string") return null;
  const index = title.indexOf(STATUS_SEPARATOR);
  const name = (index === -1 ? title : title.slice(0, index)).trim();
  return name || null;
}
