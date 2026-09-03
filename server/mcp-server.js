#!/usr/bin/env node

import crypto from "node:crypto";
import net from "node:net";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveAgentName, resolveSessionId } from "./agent-identity.js";
import { bridgeSocketPath } from "./bridge-path.js";
import { encodeJsonLine, JsonLineDecoder } from "./native-protocol.js";

const server = new McpServer({
  name: "latch",
  version: "0.1.0",
});

function bridgeUnavailableMessage(error) {
  if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED") {
    return (
      "The Chrome bridge is not connected. Open Chrome, click the Latch " +
      "toolbar icon, and confirm it shows Connected."
    );
  }
  return error?.message ?? String(error);
}

function callBridge(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(bridgeSocketPath());
    const decoder = new JsonLineDecoder();
    let settled = false;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      callback(value);
    };

    const timeout = setTimeout(() => {
      finish(reject, new Error(`Browser command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(encodeJsonLine({ id, method, params }));
    });
    socket.on("data", (chunk) => {
      try {
        for (const response of decoder.push(chunk)) {
          if (response.id !== id) {
            continue;
          }
          if (response.error) {
            const error = new Error(response.error.message ?? "Browser command failed");
            error.code = response.error.code;
            error.details = response.error.details;
            finish(reject, error);
          } else {
            finish(resolve, response.result);
          }
        }
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.once("error", (error) => finish(reject, error));
    socket.once("end", () => {
      if (!settled) {
        finish(reject, new Error("Browser bridge closed without a response"));
      }
    });
  });
}

function jsonToolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

function errorToolResult(error) {
  const details = error?.details ? `\n\n${JSON.stringify(error.details, null, 2)}` : "";
  return {
    isError: true,
    content: [{ type: "text", text: `${bridgeUnavailableMessage(error)}${details}` }],
  };
}

// Identifies this MCP server process to the extension. Two agents that ask for
// the same name are told apart by this, and the second one is given a variant.
const SESSION_ID = resolveSessionId();

const optionalAgent = z
  .string()
  .optional()
  .describe(
    "Name of the agent making this call. It becomes the title of the Chrome tab group " +
      "holding this agent's tabs, so several agents can share one Chrome profile. " +
      "Defaults to $LATCH_AGENT, then to an auto-detected name. If another live " +
      "session already holds that name, this one is given a callsign variant of " +
      "it instead; browser_status reports the name actually in use.",
  );

/**
 * Every tool takes an optional `agent`. It is resolved here rather than in each
 * tool so a caller that omits it still gets a sensible, stable group name.
 */
function registerBrowserTool(name, definition, method = name) {
  const definitionWithAgent = {
    ...definition,
    inputSchema: { ...(definition.inputSchema ?? {}), agent: optionalAgent },
  };
  server.registerTool(name, definitionWithAgent, async (params) => {
    try {
      const { agent, ...rest } = params ?? {};
      return jsonToolResult(
        await callBridge(method, { ...rest, agent: resolveAgentName(agent), session: SESSION_ID }),
      );
    } catch (error) {
      return errorToolResult(error);
    }
  });
}

const optionalTabId = z.number().int().positive().optional().describe("Chrome tab ID. Omit to use the active attached tab.");
const optionalTarget = {
  ref: z.string().optional().describe("Element reference from browser_snapshot, such as e12."),
  selector: z.string().optional().describe("CSS selector. Prefer a snapshot ref when available."),
};

registerBrowserTool("browser_status", {
  title: "Browser connection status",
  description: "Check whether Chrome is connected and list attached tabs.",
  inputSchema: {},
});

registerBrowserTool("browser_tabs", {
  title: "List Chrome tabs",
  description: "List open Chrome tabs, including which agent each attached tab belongs to.",
  inputSchema: {},
});

registerBrowserTool("browser_attach", {
  title: "Attach a Chrome tab",
  description: "Attach this agent to any normal web tab so it can inspect and control that tab.",
  inputSchema: { tabId: optionalTabId },
});

registerBrowserTool("browser_detach", {
  title: "Detach a Chrome tab",
  description: "Stop controlling a Chrome tab.",
  inputSchema: { tabId: optionalTabId },
});

registerBrowserTool("browser_snapshot", {
  title: "Read page state",
  description:
    "Read the current URL, title, visible text, and visible interactive elements. " +
    "Interactive elements receive refs that can be passed to click and type tools.",
  inputSchema: {
    tabId: optionalTabId,
    maxElements: z.number().int().min(1).max(500).default(200),
  },
});

registerBrowserTool("browser_navigate", {
  title: "Navigate an attached tab",
  description: "Navigate an attached tab to any normal HTTP, HTTPS, or file URL.",
  inputSchema: {
    url: z.string().url(),
    tabId: optionalTabId,
    timeoutMs: z.number().int().min(500).max(60_000).default(20_000),
  },
});

registerBrowserTool("browser_click", {
  title: "Click a page element",
  description: "Click an element by snapshot ref or CSS selector using a trusted Chrome input event.",
  inputSchema: {
    ...optionalTarget,
    tabId: optionalTabId,
  },
});

registerBrowserTool("browser_type", {
  title: "Type into a page element",
  description: "Focus an input by snapshot ref or selector, optionally clear it, and type text.",
  inputSchema: {
    ...optionalTarget,
    text: z.string(),
    clear: z.boolean().default(true),
    tabId: optionalTabId,
  },
});

registerBrowserTool("browser_press_key", {
  title: "Press a keyboard key",
  description: "Send a key press, such as Enter, Escape, Tab, ArrowDown, or a single character.",
  inputSchema: {
    key: z.string().min(1).max(32),
    tabId: optionalTabId,
  },
});

registerBrowserTool("browser_wait_for", {
  title: "Wait for page content",
  description: "Wait until a CSS selector is visible or specific text appears on the page.",
  inputSchema: {
    selector: z.string().optional(),
    text: z.string().optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    tabId: optionalTabId,
  },
});

server.registerTool(
  "browser_screenshot",
  {
    title: "Capture a page screenshot",
    description: "Capture the visible viewport or the full page from an attached tab.",
    inputSchema: {
      tabId: optionalTabId,
      fullPage: z.boolean().default(false),
      agent: optionalAgent,
    },
  },
  async (params) => {
    try {
      // Registered directly rather than through registerBrowserTool because it
      // returns image content, so the agent is resolved here too.
      const { agent, ...rest } = params ?? {};
      const result = await callBridge(
        "browser_screenshot",
        { ...rest, agent: resolveAgentName(agent), session: SESSION_ID },
        45_000,
      );
      return {
        content: [
          { type: "image", data: result.data, mimeType: result.mimeType ?? "image/png" },
          {
            type: "text",
            text: JSON.stringify({ tabId: result.tabId, url: result.url, fullPage: result.fullPage }, null, 2),
          },
        ],
      };
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

registerBrowserTool("browser_console", {
  title: "Read browser console",
  description: "Read captured console messages and JavaScript errors from an attached tab.",
  inputSchema: {
    tabId: optionalTabId,
    clear: z.boolean().default(false),
  },
});

registerBrowserTool("browser_network", {
  title: "Read browser network activity",
  description: "Read recent request URLs, methods, response statuses, MIME types, and failures.",
  inputSchema: {
    tabId: optionalTabId,
    clear: z.boolean().default(false),
  },
});

registerBrowserTool("browser_evaluate", {
  title: "Evaluate JavaScript",
  description:
    "Evaluate JavaScript in an explicitly attached tab. Use only when DOM snapshot actions are insufficient.",
  inputSchema: {
    expression: z.string().min(1),
    tabId: optionalTabId,
  },
});

registerBrowserTool("browser_open", {
  title: "Open or reuse a Chrome tab",
  description:
    "Open a URL while preferring an existing exact-match tab or a tab this same agent already owns on the same site. " +
    "Use this instead of browser_new_tab unless the user explicitly asks for a separate tab.",
  inputSchema: {
    url: z.string().url(),
    reuseExisting: z.boolean().default(true),
    reuseSiteTab: z.boolean().default(true),
    attach: z.boolean().default(true),
    active: z
      .boolean()
      .default(false)
      .describe("Bring the tab to the foreground. Keep false unless the user explicitly asks to see it."),
    timeoutMs: z.number().int().min(500).max(60_000).default(20_000),
  },
});

registerBrowserTool("browser_new_tab", {
  title: "Open a Chrome tab",
  description:
    "Always open a separate tab and attach it to this agent's own tab group by default. " +
    "Prefer browser_open unless the user explicitly needs another tab.",
  inputSchema: {
    url: z.string().url().default("https://example.com"),
    attach: z.boolean().default(true),
    active: z
      .boolean()
      .default(false)
      .describe("Bring the new tab to the foreground. Keep false for normal background work."),
    timeoutMs: z.number().int().min(500).max(60_000).default(20_000),
  },
});

registerBrowserTool("browser_close_tab", {
  title: "Close an attached tab",
  description: "Close a tab currently attached to this agent.",
  inputSchema: { tabId: optionalTabId },
});

const transport = new StdioServerTransport();
await server.connect(transport);
