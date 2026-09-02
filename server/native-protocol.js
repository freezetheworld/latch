const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  constructor({ maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE } = {}) {
    this.maxMessageSize = maxMessageSize;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxMessageSize) {
        throw new Error(`Native message exceeds ${this.maxMessageSize} bytes`);
      }
      if (this.buffer.length < length + 4) {
        break;
      }

      const body = this.buffer.subarray(4, length + 4).toString("utf8");
      this.buffer = this.buffer.subarray(length + 4);
      messages.push(JSON.parse(body));
    }

    return messages;
  }
}

export function encodeJsonLine(message) {
  return `${JSON.stringify(message)}\n`;
}

export class JsonLineDecoder {
  constructor({ maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE } = {}) {
    this.maxMessageSize = maxMessageSize;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxMessageSize) {
      throw new Error(`JSON line exceeds ${this.maxMessageSize} bytes`);
    }

    const messages = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        messages.push(JSON.parse(line));
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return messages;
  }
}
