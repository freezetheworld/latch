import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createLauncher,
  createHostManifest,
  extensionIdFromManifest,
  install,
  installNativeHostRuntime,
  manifestPath,
  nativeHostLauncherPath,
  nativeMessagingDirectory,
  nativeMessagingRegistryKey,
  parseArguments,
} from "../scripts/install-native-host.js";
import fs from "node:fs";
import os from "node:os";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";

test("installer parses explicit extension and browser options", () => {
  assert.deepEqual(parseArguments(["--extension-id", extensionId, "--browser=chromium", "--dry-run"]), {
    browser: "chromium",
    dryRun: true,
    extensionId,
    uninstall: false,
  });
});

test("bundled public key gives the unpacked extension a stable ID", () => {
  assert.equal(extensionIdFromManifest(), "negoahcokogjggjcccibffdnognlfbkm");
});

test("native host manifest permits only the selected extension", () => {
  assert.deepEqual(createHostManifest(extensionId, "/tmp/native-host"), {
    name: "com.local.latch",
    description: "Local native-messaging bridge between Chrome and any local coding agent",
    path: "/tmp/native-host",
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });
});

test("launcher pins the Node executable so Chrome does not depend on shell PATH", () => {
  assert.equal(
    createLauncher(
      "/opt/local/bin/node",
      "/Users/tester/Latch/server/native-host.js",
      "/Users/tester/.latch/native-host.log",
      "linux",
    ),
    "#!/bin/sh\n" +
      "printf '%s native host invoked\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> '/Users/tester/.latch/native-host.log'\n" +
      "exec '/opt/local/bin/node' '/Users/tester/Latch/server/native-host.js' \"$@\" 2>> '/Users/tester/.latch/native-host.log'\n",
  );
});

test("installer stages a self-contained host outside protected project folders", (context) => {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "latch-source-"));
  const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "latch-runtime-"));
  context.after(() => {
    fs.rmSync(sourceDirectory, { recursive: true, force: true });
    fs.rmSync(targetDirectory, { recursive: true, force: true });
  });
  for (const file of ["bridge-path.js", "native-host.js", "native-protocol.js"]) {
    fs.writeFileSync(path.join(sourceDirectory, file), `// ${file}\n`);
  }

  const installedHost = installNativeHostRuntime({ sourceDirectory, targetDirectory });

  assert.equal(installedHost, path.join(targetDirectory, "native-host.js"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(targetDirectory, "package.json"), "utf8")), {
    private: true,
    type: "module",
  });
  assert.equal(fs.readFileSync(installedHost, "utf8"), "// native-host.js\n");
});

test("extension IDs are validated", () => {
  assert.throws(() => createHostManifest("not-an-extension-id"), /32-character ID/);
});

test("macOS host directory targets the selected Chrome channel", () => {
  assert.equal(
    nativeMessagingDirectory({ browser: "chrome-beta", platform: "darwin", home: "/Users/tester" }),
    path.join(
      "/Users/tester",
      "Library",
      "Application Support",
      "Google",
      "Chrome Beta",
      "NativeMessagingHosts",
    ),
  );
});

test("Windows has no NativeMessagingHosts folder to compute", () => {
  assert.throws(
    () => nativeMessagingDirectory({ browser: "chrome", platform: "win32", home: "C:\\Users\\tester" }),
    /Registry/,
  );
});

test("Windows native messaging hosts are registered through the registry, not a folder", () => {
  assert.equal(
    nativeMessagingRegistryKey("chrome"),
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.local.latch",
  );
  assert.equal(
    nativeMessagingRegistryKey("chrome-beta"),
    "HKCU\\Software\\Google\\Chrome Beta\\NativeMessagingHosts\\com.local.latch",
  );
  assert.equal(
    nativeMessagingRegistryKey("chromium"),
    "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.local.latch",
  );
  assert.throws(() => nativeMessagingRegistryKey("firefox"), /Unsupported browser on Windows/);
});

test("the Windows launcher is a batch file pinning the Node executable", () => {
  assert.equal(
    createLauncher(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\tester\\.latch\\runtime\\native-host.js",
      "C:\\Users\\tester\\.latch\\native-host.log",
      "win32",
    ),
    "@echo off\r\n" +
      '>> "C:\\Users\\tester\\.latch\\native-host.log" echo %DATE% %TIME% native host invoked\r\n' +
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\.latch\\runtime\\native-host.js" %* 2>> "C:\\Users\\tester\\.latch\\native-host.log"\r\n',
  );
  assert.ok(nativeHostLauncherPath("win32").endsWith(".bat"));
  assert.ok(!nativeHostLauncherPath("linux").endsWith(".bat"));
});

test("the Windows manifest lives in the bridge directory, not a browser-specific folder", () => {
  const target = manifestPath({ browser: "chrome" }, "win32");
  assert.equal(path.basename(target), "com.local.latch.json");
  assert.equal(path.dirname(target), path.dirname(nativeHostLauncherPath("win32")));
});

test("a Windows dry run reports the registry key without touching the registry or disk", (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "latch-win-install-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const previous = process.env.LATCH_HOME;
  process.env.LATCH_HOME = testHome;
  try {
    const result = install({
      browser: "chrome",
      dryRun: true,
      extensionId,
      uninstall: false,
      platform: "win32",
    });
    assert.equal(result.action, "install");
    assert.equal(result.registryKey, "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.local.latch");
    assert.equal(result.manifest.allowed_origins[0], `chrome-extension://${extensionId}/`);
    assert.equal(fs.existsSync(result.target), false, "dry run must not write the manifest");
    assert.equal(fs.readdirSync(testHome).length, 0, "dry run must not touch the bridge directory");
  } finally {
    if (previous === undefined) delete process.env.LATCH_HOME;
    else process.env.LATCH_HOME = previous;
  }
});
