import os from "node:os";
import path from "node:path";

export const NATIVE_HOST_NAME = "com.local.latch";
export const BRIDGE_DIRECTORY_NAME = ".latch";

/** Set LATCH_HOME to relocate the socket and launcher (mainly for tests). */
export function bridgeDirectory() {
  const override = process.env.LATCH_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), BRIDGE_DIRECTORY_NAME);
}

export function bridgeSocketPath() {
  return path.join(bridgeDirectory(), "bridge.sock");
}
