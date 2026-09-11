import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const NATIVE_HOST_NAME = "com.local.latch";
export const BRIDGE_DIRECTORY_NAME = ".latch";

/** Set LATCH_HOME to relocate the socket and launcher (mainly for tests). */
export function bridgeDirectory() {
  const override = process.env.LATCH_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), BRIDGE_DIRECTORY_NAME);
}

/**
 * Windows has no filesystem-backed Unix socket, so the bridge listens on a
 * named pipe instead. Pipe names live in a machine-wide namespace, so this
 * derives a name from bridgeDirectory() (which already carries the user's
 * profile path or a test's LATCH_HOME override) to keep users and parallel
 * test runs from colliding on the same pipe.
 */
export function namedPipePath() {
  const suffix = crypto.createHash("sha256").update(bridgeDirectory()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\latch-${suffix}`;
}

export function isWindows(platform = process.platform) {
  return platform === "win32";
}

export function bridgeSocketPath({ platform = process.platform } = {}) {
  return isWindows(platform) ? namedPipePath() : path.join(bridgeDirectory(), "bridge.sock");
}
