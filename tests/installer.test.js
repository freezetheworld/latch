import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createLauncher,
  createHostManifest,
  extensionIdFromManifest,
  installNativeHostRuntime,
  nativeMessagingDirectory,
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
