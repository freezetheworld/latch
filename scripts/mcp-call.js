#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [toolName, rawArguments = "{}"] = process.argv.slice(2);

if (!toolName) {
  console.error("Usage: node scripts/mcp-call.js <tool-name> [json-arguments]");
  process.exit(2);
}

let args;
try {
  args = JSON.parse(rawArguments);
} catch (error) {
  console.error(`Invalid JSON arguments: ${error.message}`);
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "server", "mcp-server.js")],
  cwd: projectRoot,
  stderr: "inherit",
});
const client = new Client({ name: "latch-cli", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({ name: toolName, arguments: args });
  for (const item of result.content ?? []) {
    if (item.type === "text") {
      process.stdout.write(`${item.text}\n`);
    } else if (item.type === "image") {
      process.stdout.write(`${JSON.stringify({ type: item.type, mimeType: item.mimeType, bytes: item.data?.length ?? 0 })}\n`);
    }
  }
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
