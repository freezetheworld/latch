#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [rawTabId, selector, filePath, mimeType = "image/png"] = process.argv.slice(2);
const tabId = Number(rawTabId);

if (!Number.isInteger(tabId) || !selector || !filePath) {
  console.error("Usage: node scripts/browser-upload.js <tab-id> <input-selector> <file-path> [mime-type]");
  process.exit(2);
}

const data = await fs.readFile(filePath);
const base64 = data.toString("base64");
const fileName = path.basename(filePath);
const expression = `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) throw new Error("Upload input not found: " + ${JSON.stringify(selector)});
  const binary = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { selector: ${JSON.stringify(selector)}, fileName: ${JSON.stringify(fileName)}, bytes: bytes.length };
})()`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "server", "mcp-server.js")],
  cwd: projectRoot,
  stderr: "inherit",
});
const client = new Client({ name: "latch-upload", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: { tabId, expression },
  });
  for (const item of result.content ?? []) {
    if (item.type === "text") process.stdout.write(`${item.text}\n`);
  }
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
