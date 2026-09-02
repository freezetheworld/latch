#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bridgeDirectory, NATIVE_HOST_NAME } from "../server/bridge-path.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeHostPath = path.join(projectRoot, "server", "native-host.js");
const extensionManifestPath = path.join(projectRoot, "extension", "manifest.json");
const nativeRuntimeFiles = [
  "bridge-path.js",
  "native-host.js",
  "native-protocol.js",
];

export function extensionIdFromManifest(manifestPath = extensionManifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.key) {
    throw new Error("extension/manifest.json has no key; pass --extension-id explicitly");
  }
  const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((value) => String.fromCharCode(97 + value))
    .join("");
}

export function nativeHostLauncherPath() {
  return path.join(bridgeDirectory(), "native-host-launcher");
}

export function nativeHostLogPath() {
  return path.join(bridgeDirectory(), "native-host.log");
}

export function nativeHostRuntimeDirectory() {
  return path.join(bridgeDirectory(), "runtime");
}

export function installedNativeHostPath() {
  return path.join(nativeHostRuntimeDirectory(), "native-host.js");
}

export function installNativeHostRuntime({ sourceDirectory = path.dirname(nativeHostPath), targetDirectory = nativeHostRuntimeDirectory() } = {}) {
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(targetDirectory, 0o700);
  fs.writeFileSync(path.join(targetDirectory, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  for (const file of nativeRuntimeFiles) {
    fs.copyFileSync(path.join(sourceDirectory, file), path.join(targetDirectory, file));
    fs.chmodSync(path.join(targetDirectory, file), 0o600);
  }
  return path.join(targetDirectory, "native-host.js");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function createLauncher(nodePath = process.execPath, hostPath = nativeHostPath, logPath = nativeHostLogPath()) {
  return `#!/bin/sh\nprintf '%s native host invoked\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ${shellQuote(logPath)}\nexec ${shellQuote(nodePath)} ${shellQuote(hostPath)} "$@" 2>> ${shellQuote(logPath)}\n`;
}

export function parseArguments(argv) {
  const options = {
    browser: "chrome",
    dryRun: false,
    extensionId: null,
    uninstall: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--uninstall") {
      options.uninstall = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument.startsWith("--extension-id=")) {
      options.extensionId = argument.slice("--extension-id=".length);
    } else if (argument === "--extension-id") {
      options.extensionId = argv[++index];
    } else if (argument.startsWith("--browser=")) {
      options.browser = argument.slice("--browser=".length);
    } else if (argument === "--browser") {
      options.browser = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

export function nativeMessagingDirectory({ browser, platform = process.platform, home = os.homedir() }) {
  if (platform === "darwin") {
    const productDirectories = {
      chrome: "Google/Chrome",
      "chrome-beta": "Google/Chrome Beta",
      chromium: "Chromium",
    };
    const productDirectory = productDirectories[browser];
    if (!productDirectory) {
      throw new Error(`Unsupported browser on macOS: ${browser}`);
    }
    return path.join(home, "Library", "Application Support", productDirectory, "NativeMessagingHosts");
  }

  if (platform === "linux") {
    const productDirectories = {
      chrome: "google-chrome",
      "chrome-beta": "google-chrome-beta",
      chromium: "chromium",
    };
    const productDirectory = productDirectories[browser];
    if (!productDirectory) {
      throw new Error(`Unsupported browser on Linux: ${browser}`);
    }
    return path.join(home, ".config", productDirectory, "NativeMessagingHosts");
  }

  throw new Error("The installer currently supports macOS and Linux. Windows requires a registry entry.");
}

export function createHostManifest(extensionId, hostPath = nativeHostPath) {
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
    throw new Error("Extension ID must be the 32-character ID shown on chrome://extensions");
  }

  return {
    name: NATIVE_HOST_NAME,
    description: "Local native-messaging bridge between Chrome and any local coding agent",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function manifestPath(options) {
  return path.join(nativeMessagingDirectory(options), `${NATIVE_HOST_NAME}.json`);
}

export function install(options) {
  const target = manifestPath(options);
  const launcher = nativeHostLauncherPath();
  if (options.uninstall) {
    if (options.dryRun) {
      return { action: "uninstall", target, launcher };
    }
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    if (fs.existsSync(launcher)) {
      fs.unlinkSync(launcher);
    }
    if (fs.existsSync(nativeHostRuntimeDirectory())) {
      fs.rmSync(nativeHostRuntimeDirectory(), { recursive: true, force: true });
    }
    return { action: "uninstall", target, launcher };
  }

  const manifest = createHostManifest(options.extensionId, launcher);
  if (options.dryRun) {
    return { action: "install", target, launcher, manifest };
  }

  fs.mkdirSync(bridgeDirectory(), { recursive: true, mode: 0o700 });
  fs.chmodSync(bridgeDirectory(), 0o700);
  const installedHost = installNativeHostRuntime();
  const temporaryLauncher = `${launcher}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryLauncher, createLauncher(process.execPath, installedHost), { mode: 0o700 });
  fs.renameSync(temporaryLauncher, launcher);
  fs.chmodSync(launcher, 0o700);

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporaryTarget = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryTarget, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryTarget, target);
  return { action: "install", target, manifest };
}

function quoteForDisplay(value) {
  return value.includes(" ") ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (!options.uninstall && !options.extensionId) {
      options.extensionId = extensionIdFromManifest();
    }
    const result = install(options);
    if (result.action === "uninstall") {
      process.stdout.write(`${options.dryRun ? "Would remove" : "Removed"} ${result.target}\n`);
      process.stdout.write(`${options.dryRun ? "Would remove" : "Removed"} ${result.launcher}\n`);
      return;
    }

    process.stdout.write(`${options.dryRun ? "Would install" : "Installed"} ${result.target}\n`);
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
    } else {
      const mcpServerPath = quoteForDisplay(path.join(projectRoot, "server", "mcp-server.js"));
      const cliPath = quoteForDisplay(path.join(projectRoot, "cli", "latch.js"));
      process.stdout.write("\nLatch is ready. Register it with whichever agents you use:\n\n");
      process.stdout.write(`  Codex        codex mcp add latch -- node ${mcpServerPath}\n`);
      process.stdout.write(`  Claude Code  claude mcp add latch -- node ${mcpServerPath}\n`);
      process.stdout.write(`  Gemini       gemini mcp add latch -- node ${mcpServerPath}\n`);
      process.stdout.write(`  Any other    node ${mcpServerPath}   (stdio MCP server)\n\n`);
      process.stdout.write(`Or drive it from a shell with the CLI:\n\n  node ${cliPath} --agent \"My Agent\" status\n\n`);
      process.stdout.write("Each agent names itself with --agent (or LATCH_AGENT); that name\n");
      process.stdout.write("becomes the title of the Chrome tab group holding its tabs.\n\n");
      process.stdout.write("Then restart Chrome.\n");
    }
  } catch (error) {
    process.stderr.write(`Setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
