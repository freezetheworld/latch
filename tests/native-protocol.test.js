import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeJsonLine,
  encodeNativeMessage,
  JsonLineDecoder,
  NativeMessageDecoder,
} from "../server/native-protocol.js";

test("native protocol decodes fragmented and consecutive messages", () => {
  const first = encodeNativeMessage({ type: "first", value: 1 });
  const second = encodeNativeMessage({ type: "second", value: 2 });
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { type: "first", value: 1 },
    { type: "second", value: 2 },
  ]);
});

test("native protocol rejects oversized messages before allocation", () => {
  const frame = Buffer.alloc(4);
  frame.writeUInt32LE(100, 0);
  const decoder = new NativeMessageDecoder({ maxMessageSize: 16 });
  assert.throws(() => decoder.push(frame), /exceeds 16 bytes/);
});

test("JSON line protocol handles fragmented lines", () => {
  const decoder = new JsonLineDecoder();
  const encoded = encodeJsonLine({ id: "one", ok: true });
  assert.deepEqual(decoder.push(encoded.slice(0, 4)), []);
  assert.deepEqual(decoder.push(encoded.slice(4)), [{ id: "one", ok: true }]);
});
