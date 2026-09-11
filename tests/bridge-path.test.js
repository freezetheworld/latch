import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { bridgeDirectory, bridgeSocketPath, isWindows } from "../server/bridge-path.js";

test("isWindows recognizes only the win32 platform string", () => {
  assert.equal(isWindows("win32"), true);
  assert.equal(isWindows("linux"), false);
  assert.equal(isWindows("darwin"), false);
});

test("POSIX platforms get a socket file inside the bridge directory", () => {
  assert.equal(
    bridgeSocketPath({ platform: "linux" }),
    path.join(bridgeDirectory(), "bridge.sock"),
  );
  assert.equal(
    bridgeSocketPath({ platform: "darwin" }),
    path.join(bridgeDirectory(), "bridge.sock"),
  );
});

test("Windows gets a named pipe path instead of a socket file", () => {
  const socketPath = bridgeSocketPath({ platform: "win32" });
  assert.match(socketPath, /^\\\\\.\\pipe\\latch-[0-9a-f]{16}$/);
});

test("the named pipe path is stable for a given LATCH_HOME and differs across homes", () => {
  const previous = process.env.LATCH_HOME;
  try {
    process.env.LATCH_HOME = "/home/alice/.latch";
    const alice = bridgeSocketPath({ platform: "win32" });
    assert.equal(bridgeSocketPath({ platform: "win32" }), alice, "same LATCH_HOME should yield the same pipe name");

    process.env.LATCH_HOME = "/home/bob/.latch";
    const bob = bridgeSocketPath({ platform: "win32" });
    assert.notEqual(bob, alice, "different LATCH_HOME should yield different pipe names");
  } finally {
    if (previous === undefined) delete process.env.LATCH_HOME;
    else process.env.LATCH_HOME = previous;
  }
});
