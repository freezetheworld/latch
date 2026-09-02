import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  encodeJsonLine,
  encodeNativeMessage,
  JsonLineDecoder,
  NativeMessageDecoder,
} from "../server/native-protocol.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

test("native host relays a socket request to Chrome and its response back", async (context) => {
  // Keep the Unix-socket path short and allocate it inside the process-scoped temp root.
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cbb-test-"));
  const socketPath = path.join(testDirectory, "bridge.sock");
  const child = spawn(process.execPath, [path.join(projectRoot, "server", "native-host.js")], {
    env: { ...process.env, LATCH_HOME: testDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childErrorOutput = "";
  child.stderr.on("data", (chunk) => {
    childErrorOutput += chunk.toString("utf8");
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      try {
        await withTimeout(exited, 1_000, "native host did not stop after SIGTERM");
      } catch {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const nativeDecoder = new NativeMessageDecoder();
  const nativeMessages = [];
  const nativeWaiters = [];
  child.stdout.on("data", (chunk) => {
    for (const message of nativeDecoder.push(chunk)) {
      nativeMessages.push(message);
      nativeWaiters.splice(0).forEach((resolve) => resolve());
    }
  });

  async function nextNativeMessage(predicate) {
    while (true) {
      const index = nativeMessages.findIndex(predicate);
      if (index >= 0) {
        return nativeMessages.splice(index, 1)[0];
      }
      await new Promise((resolve) => nativeWaiters.push(resolve));
    }
  }

  let ready;
  try {
    ready = await withTimeout(
      nextNativeMessage((message) => message.type === "host_ready"),
      2_000,
      "native host did not become ready",
    );
  } catch (error) {
    throw new Error(
      `${error.message}; exit=${child.exitCode}, signal=${child.signalCode}, stderr=${childErrorOutput || "<empty>"}`,
    );
  }
  assert.equal(ready.protocolVersion, 1);
  assert.equal(fs.existsSync(socketPath), true);

  const socket = net.createConnection(socketPath);
  const lineDecoder = new JsonLineDecoder();
  const responsePromise = new Promise((resolve) => {
    socket.on("data", (chunk) => {
      const [message] = lineDecoder.push(chunk);
      if (message) resolve(message);
    });
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(encodeJsonLine({ id: "client-1", method: "browser_status", params: {} }));

  const request = await withTimeout(
    nextNativeMessage((message) => message.type === "bridge_request"),
    2_000,
    "native host did not relay the request",
  );
  assert.equal(request.method, "browser_status");
  child.stdin.write(
    encodeNativeMessage({
      type: "bridge_response",
      id: request.id,
      result: { connected: true },
    }),
  );

  assert.deepEqual(
    await withTimeout(responsePromise, 2_000, "native host did not relay the response"),
    { id: "client-1", result: { connected: true } },
  );
  socket.destroy();
});
