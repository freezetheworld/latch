import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server advertises the complete browser tool set", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "server", "mcp-server.js")],
    cwd: projectRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "latch-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      [
        "browser_attach",
        "browser_click",
        "browser_close_tab",
        "browser_console",
        "browser_detach",
        "browser_evaluate",
        "browser_navigate",
        "browser_network",
        "browser_new_tab",
        "browser_open",
        "browser_press_key",
        "browser_screenshot",
        "browser_scroll",
        "browser_snapshot",
        "browser_status",
        "browser_tabs",
        "browser_type",
        "browser_wait_for",
      ],
    );
    // Every tool must let the caller name itself, so its tabs land in its own group.
    for (const tool of result.tools) {
      assert.ok(
        tool.inputSchema?.properties?.agent,
        `${tool.name} is missing the agent parameter`,
      );
    }

    const newTabTool = result.tools.find((tool) => tool.name === "browser_new_tab");
    assert.equal(newTabTool.inputSchema.properties.attach.default, true);
    assert.equal(newTabTool.inputSchema.properties.active.default, false);
    assert.equal(newTabTool.inputSchema.properties.timeoutMs.default, 20_000);
    const openTool = result.tools.find((tool) => tool.name === "browser_open");
    assert.equal(openTool.inputSchema.properties.active.default, false);
    assert.equal(openTool.inputSchema.properties.reuseExisting.default, true);

    // Every advertised tool must exist on both other sides of the bridge, or a
    // caller gets "Unknown browser command" at run time instead of here.
    const advertised = result.tools.map((tool) => tool.name).sort();
    const background = fs.readFileSync(path.join(projectRoot, "extension", "background.js"), "utf8");
    const commandTable = background.slice(
      background.indexOf("const commands = {"),
      background.indexOf("};", background.indexOf("const commands = {")),
    );
    for (const name of advertised) {
      assert.ok(commandTable.includes(`${name}:`), `${name} is not handled in background.js`);
    }

    const cli = fs.readFileSync(path.join(projectRoot, "cli", "latch.js"), "utf8");
    for (const name of advertised) {
      assert.ok(cli.includes(`"${name}"`), `${name} is not reachable from the CLI`);
    }
  } finally {
    await client.close();
  }
});
