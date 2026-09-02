#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [rawTabId, outputPath, fullPageFlag = "false"] = process.argv.slice(2);
const tabId = Number(rawTabId);

if (!Number.isInteger(tabId) || !outputPath) {
  console.error("Usage: node scripts/browser-screenshot.js <tab-id> <output-path> [true|false]");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "server", "mcp-server.js")],
  cwd: projectRoot,
  stderr: "inherit",
});
const client = new Client({ name: "latch-screenshot", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "browser_screenshot",
    arguments: { tabId, fullPage: fullPageFlag === "true" },
  });
  if (result.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text ?? "Screenshot failed";
    throw new Error(message);
  }
  const image = result.content?.find((item) => item.type === "image");
  if (!image?.data) throw new Error("Browser returned no screenshot image");
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(image.data, "base64"));
  process.stdout.write(`${path.resolve(outputPath)}\n`);
} finally {
  await client.close();
}
