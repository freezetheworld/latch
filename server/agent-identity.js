/**
 * Shared agent identity helpers.
 *
 * Every bridge request carries the name of the agent that issued it. The
 * extension uses that name as the title of the Chrome tab group it puts the
 * agent's tabs in, so several agents can drive the same Chrome profile at the
 * same time and stay visually separated.
 *
 * The pure helpers here (normalizeAgentName / colorForAgent) are mirrored in
 * extension/background.js, which cannot import from server/. Keep them in sync.
 */

export const AGENT_ENV_VAR = "LATCH_AGENT";
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

export function colorForAgent(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (KNOWN_AGENT_COLORS[key]) return KNOWN_AGENT_COLORS[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}
