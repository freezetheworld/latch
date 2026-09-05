#!/usr/bin/env node

import crypto from "node:crypto";
import net from "node:net";
import process from "node:process";
import { resolveAgentName, resolveSessionId } from "../server/agent-identity.js";
import { bridgeSocketPath } from "../server/bridge-path.js";
import { encodeJsonLine, JsonLineDecoder } from "../server/native-protocol.js";

const USAGE = `Usage: latch [--agent NAME] <command> [options]

Commands:
  status                              Check bridge connection and attached tabs
  tabs                                List all Chrome tabs
  attach [--tab-id N]                 Attach to a tab (active tab if no ID)
  detach [--tab-id N]                 Detach from a tab
  snapshot [--tab-id N] [--max-elements N]  Read page state with element refs
  scroll [down|up|top|bottom|left|right] [--amount N] [--ref eN | --selector CSS] [--tab-id N]  Scroll the page or a container
  navigate <url> [--tab-id N] [--timeout-ms N]  Navigate to a URL
  click [--ref eN | --selector CSS] [--tab-id N]  Click an element
  type <text> [--ref eN | --selector CSS] [--no-clear] [--tab-id N]  Type text
  press-key <key> [--tab-id N]        Press a keyboard key
  wait-for [--selector CSS | --text TEXT] [--timeout-ms N] [--tab-id N]  Wait for content
  screenshot [--full-page] [--tab-id N] [--save PATH]  Capture screenshot
  console [--clear] [--tab-id N]      Read console messages
  network [--clear] [--tab-id N]      Read network activity
  evaluate <expression> [--tab-id N]  Evaluate JavaScript
  open <url> [--active] [--no-reuse] [--tab-id N] [--timeout-ms N]  Open or reuse a tab
  new-tab <url> [--active] [--no-attach] [--tab-id N] [--timeout-ms N]  Open a new tab
  close-tab [--tab-id N]              Close an attached tab

Options:
  --agent NAME      Name this agent. Becomes the title of the Chrome tab group
                    holding its tabs, so several agents can share one profile.
                    Defaults to $LATCH_AGENT, then an auto-detected name.
  --tab-id N        Chrome tab ID, in this agent's own tab group (uses the active
                    attached tab in that group if omitted)
  --ref eN          Element reference from snapshot (e.g. e12)
  --selector CSS    CSS selector
  --max-elements N  Max elements in snapshot (default 200, max 500)
  --timeout-ms N    Timeout in milliseconds (default 20000)
  --amount N        Pixels to scroll (default one screenful)
  --full-page       Capture full page in screenshot
  --save PATH       Save screenshot to file instead of printing base64
  --clear           Clear messages after reading
  --no-clear        Don't clear input before typing (default: clear)
  --active          Bring tab to foreground
  --no-reuse        Don't reuse existing tabs
  --no-attach       Don't auto-attach new tab
  --text TEXT       Text to wait for
  --help            Show this help
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  // The command may appear before or after global options such as --agent.
  let command;
  const options = { agent: undefined, tabId: undefined, ref: undefined, selector: undefined, maxElements: undefined, timeoutMs: undefined, fullPage: false, save: undefined, clear: undefined, text: undefined, active: false, reuseExisting: undefined, attach: undefined, amount: undefined };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agent") options.agent = args[++i];
    else if (arg.startsWith("--agent=")) options.agent = arg.slice(8);
    else if (arg === "--tab-id") options.tabId = parseInt(args[++i], 10);
    else if (arg.startsWith("--tab-id=")) options.tabId = parseInt(arg.slice(9), 10);
    else if (arg === "--ref") options.ref = args[++i];
    else if (arg.startsWith("--ref=")) options.ref = arg.slice(6);
    else if (arg === "--selector") options.selector = args[++i];
    else if (arg.startsWith("--selector=")) options.selector = arg.slice(11);
    else if (arg === "--max-elements") options.maxElements = parseInt(args[++i], 10);
    else if (arg.startsWith("--max-elements=")) options.maxElements = parseInt(arg.slice(14), 10);
    else if (arg === "--timeout-ms") options.timeoutMs = parseInt(args[++i], 10);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = parseInt(arg.slice(13), 10);
    else if (arg === "--amount") options.amount = parseInt(args[++i], 10);
    else if (arg.startsWith("--amount=")) options.amount = parseInt(arg.slice(9), 10);
    else if (arg === "--full-page") options.fullPage = true;
    else if (arg === "--save") options.save = args[++i];
    else if (arg.startsWith("--save=")) options.save = arg.slice(7);
    else if (arg === "--clear") options.clear = true;
    else if (arg === "--no-clear") options.clear = false;
    else if (arg === "--text") options.text = args[++i];
    else if (arg.startsWith("--text=")) options.text = arg.slice(7);
    else if (arg === "--active") options.active = true;
    else if (arg === "--no-reuse") options.reuseExisting = false;
    else if (arg === "--no-attach") options.attach = false;
    else if (arg.startsWith("--")) { process.stderr.write(`Unknown option: ${arg}\n`); process.exit(1); }
    else if (command === undefined) command = arg;
    else positional.push(arg);
  }
  if (!command) {
    process.stderr.write(`A command is required\n\n${USAGE}`);
    process.exit(1);
  }
  return { command, options, positional };
}

function buildParams(command, options, positional) {
  // Every request names its agent; the extension groups tabs by that name.
  // The session id lets the extension tell two shells running the same agent
  // apart, so the second one gets a callsign instead of a duplicate name.
  const p = { agent: resolveAgentName(options.agent), session: resolveSessionId() };
  if (options.tabId !== undefined) p.tabId = options.tabId;
  if (options.ref !== undefined) p.ref = options.ref;
  if (options.selector !== undefined) p.selector = options.selector;
  if (options.maxElements !== undefined) p.maxElements = options.maxElements;
  if (options.timeoutMs !== undefined) p.timeoutMs = options.timeoutMs;
  if (options.fullPage !== undefined) p.fullPage = options.fullPage;
  if (options.clear !== undefined) p.clear = options.clear;
  if (options.text !== undefined) p.text = options.text;
  if (options.active !== undefined) p.active = options.active;
  if (options.reuseExisting !== undefined) p.reuseExisting = options.reuseExisting;
  if (options.attach !== undefined) p.attach = options.attach;
  if (options.amount !== undefined) p.amount = options.amount;

  switch (command) {
    case "scroll":
      // `latch scroll` alone means one screenful down.
      if (positional[0]) p.to = positional[0];
      break;
    case "navigate":
    case "open":
    case "new-tab":
      if (!positional[0]) { process.stderr.write("URL is required\n"); process.exit(1); }
      p.url = positional[0];
      break;
    case "type":
      if (!positional[0]) { process.stderr.write("Text is required\n"); process.exit(1); }
      p.text = positional[0];
      break;
    case "press-key":
      if (!positional[0]) { process.stderr.write("Key is required\n"); process.exit(1); }
      p.key = positional[0];
      break;
    case "evaluate":
      if (!positional[0]) { process.stderr.write("Expression is required\n"); process.exit(1); }
      p.expression = positional[0];
      break;
  }
  return p;
}

const COMMAND_MAP = {
  status: "browser_status",
  tabs: "browser_tabs",
  attach: "browser_attach",
  detach: "browser_detach",
  snapshot: "browser_snapshot",
  scroll: "browser_scroll",
  navigate: "browser_navigate",
  click: "browser_click",
  type: "browser_type",
  "press-key": "browser_press_key",
  "wait-for": "browser_wait_for",
  screenshot: "browser_screenshot",
  console: "browser_console",
  network: "browser_network",
  evaluate: "browser_evaluate",
  open: "browser_open",
  "new-tab": "browser_new_tab",
  "close-tab": "browser_close_tab",
};

function callBridge(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(bridgeSocketPath());
    const decoder = new JsonLineDecoder();
    let settled = false;

    const finish = (cb, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      cb(val);
    };

    const timer = setTimeout(() => finish(reject, new Error(`Browser command timed out after ${timeoutMs}ms`)), timeoutMs);

    socket.once("connect", () => socket.write(encodeJsonLine({ id, method, params })));
    socket.on("data", (chunk) => {
      try {
        for (const response of decoder.push(chunk)) {
          if (response.id !== id) continue;
          if (response.error) {
            const err = new Error(response.error.message ?? "Browser command failed");
            err.code = response.error.code;
            err.details = response.error.details;
            finish(reject, err);
          } else finish(resolve, response.result);
        }
      } catch (error) { finish(reject, error); }
    });
    socket.once("error", (error) => {
      if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED")
        finish(reject, new Error("Browser bridge is not connected. Open Chrome, click the Latch toolbar icon, and confirm it shows Connected."));
      finish(reject, error);
    });
    socket.once("end", () => { if (!settled) finish(reject, new Error("Browser bridge closed without a response")); });
  });
}

async function main() {
  const { command, options, positional } = parseArgs(process.argv);
  const method = COMMAND_MAP[command];
  if (!method) { process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`); process.exit(1); }
  const params = buildParams(command, options, positional);
  const timeout = command === "screenshot" ? 45_000 : 30_000;

  try {
    const result = await callBridge(method, params, timeout);
    if (command === "screenshot" && result?.data && options.save) {
      const fs = await import("node:fs");
      fs.writeFileSync(options.save, Buffer.from(result.data, "base64"));
      process.stdout.write(`Screenshot saved to ${options.save}\n`);
      process.stdout.write(JSON.stringify({ tabId: result.tabId, url: result.url, fullPage: result.fullPage }, null, 2) + "\n");
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error.details) process.stderr.write(JSON.stringify(error.details, null, 2) + "\n");
    process.exit(1);
  }
}

main();