#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { bridgeDirectory, bridgeSocketPath, NATIVE_HOST_NAME } from "./bridge-path.js";
import {
  encodeJsonLine,
  encodeNativeMessage,
  JsonLineDecoder,
  NativeMessageDecoder,
} from "./native-protocol.js";

const socketPath = bridgeSocketPath();
const pending = new Map();
const nativeDecoder = new NativeMessageDecoder();
let shuttingDown = false;

function log(message) {
  process.stderr.write(`[latch-host] ${message}\n`);
}

function writeNative(message) {
  process.stdout.write(encodeNativeMessage(message));
}

function replyToClient(client, message) {
  if (!client.destroyed) {
    client.write(encodeJsonLine(message));
  }
}

function queueBrowserRequest(request, respond, source = "local") {
  if (!request || typeof request.id !== "string" || typeof request.method !== "string") {
    respond({
      id: request?.id ?? null,
      error: { code: "INVALID_REQUEST", message: "Expected string id and method" },
    });
    return null;
  }
  const bridgeId = `${source}:${crypto.randomUUID()}:${request.id}`;
  pending.set(bridgeId, { clientRequestId: request.id, respond });
  writeNative({
    type: "bridge_request",
    id: bridgeId,
    method: request.method,
    params: request.params ?? {},
  });
  return bridgeId;
}

function handleNativeMessage(message) {
  if (message?.type !== "bridge_response" || typeof message.id !== "string") {
    return;
  }

  const request = pending.get(message.id);
  if (!request) {
    return;
  }
  pending.delete(message.id);
  request.respond({
    id: request.clientRequestId,
    ...(message.error ? { error: message.error } : { result: message.result }),
  });
}

process.stdin.on("data", (chunk) => {
  try {
    for (const message of nativeDecoder.push(chunk)) {
      handleNativeMessage(message);
    }
  } catch (error) {
    log(`Invalid native message: ${error.message}`);
  }
});

process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", (error) => {
  log(`Native input failed: ${error.message}`);
  shutdown(1);
});

function handleClient(client) {
  const decoder = new JsonLineDecoder();
  const connectionId = crypto.randomUUID();
  const requestIds = new Set();

  client.on("data", (chunk) => {
    try {
      for (const request of decoder.push(chunk)) {
        const bridgeId = queueBrowserRequest(
          request,
          (response) => replyToClient(client, response),
          `local:${connectionId}`,
        );
        if (bridgeId) requestIds.add(bridgeId);
      }
    } catch (error) {
      replyToClient(client, {
        id: null,
        error: { code: "INVALID_JSON", message: error.message },
      });
    }
  });

  const releaseRequests = () => {
    for (const requestId of requestIds) {
      pending.delete(requestId);
    }
  };
  client.on("close", releaseRequests);
  client.on("error", releaseRequests);
}

async function socketIsActive(candidatePath) {
  return new Promise((resolve) => {
    const probe = net.createConnection(candidatePath);
    const timer = setTimeout(() => {
      probe.destroy();
      resolve(false);
    }, 250);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

fs.mkdirSync(bridgeDirectory(), { recursive: true, mode: 0o700 });
fs.chmodSync(bridgeDirectory(), 0o700);
if (fs.existsSync(socketPath)) {
  if (await socketIsActive(socketPath)) {
    log(`Another bridge is already listening at ${socketPath}`);
    process.exit(1);
  }
  fs.unlinkSync(socketPath);
}

const server = net.createServer(handleClient);
server.on("error", (error) => {
  log(`Socket server failed: ${error.message}`);
  shutdown(1);
});
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  writeNative({
    type: "host_ready",
    host: NATIVE_HOST_NAME,
    protocolVersion: 1,
  });
});

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const request of pending.values()) {
    request.respond({
      id: request.clientRequestId,
      error: { code: "HOST_SHUTDOWN", message: "Browser bridge stopped" },
    });
  }
  pending.clear();
  server.close(() => {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
