import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set(["node_modules", ".git"]);
const JavaScriptExtensions = new Set([".js", ".mjs"]);

function collectFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(candidate));
    } else {
      files.push(candidate);
    }
  }
  return files;
}

const files = collectFiles(projectRoot);
for (const file of files.filter((candidate) => JavaScriptExtensions.has(path.extname(candidate)))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exitCode = 1;
  }
}

for (const file of files.filter((candidate) => path.extname(candidate) === ".json")) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(`${path.relative(projectRoot, file)}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  process.stdout.write("Syntax and JSON checks passed.\n");
}
