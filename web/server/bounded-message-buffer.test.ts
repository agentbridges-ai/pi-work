import { describe, expect, it } from "vitest";
import { BoundedMessageBuffer, utf8JsonByteLength } from "./bounded-message-buffer.js";

describe("BoundedMessageBuffer", () => {
  it("evicts oldest items to satisfy count and UTF-8 byte budgets", () => {
    const items: string[] = [];
    const buffer = new BoundedMessageBuffer(items, { maxItems: 3, maxBytes: 6 }, (item) =>
      Buffer.byteLength(item, "utf-8"),
    );

    buffer.append("aa");
    buffer.append("bb");
    const result = buffer.append("ccc");

    expect(result.dropped).toEqual(["aa"]);
    expect(items).toEqual(["bb", "ccc"]);
    expect(buffer.byteLength()).toBe(5);
  });

  it("measures multibyte text as UTF-8 bytes", () => {
    expect(utf8JsonByteLength({ content: "你" })).toBe(
      Buffer.byteLength(JSON.stringify({ content: "你" }), "utf-8"),
    );
  });

  it("rejects a single item larger than the complete buffer budget", () => {
    const items = ["ok"];
    const buffer = new BoundedMessageBuffer(items, { maxItems: 2, maxBytes: 4 }, (item) =>
      Buffer.byteLength(item, "utf-8"),
    );

    expect(buffer.append("oversized").accepted).toBe(false);
    expect(items).toEqual(["ok"]);
  });

  it("trims restored buffers during construction", () => {
    const items = ["a", "bb", "ccc"];
    const buffer = new BoundedMessageBuffer(items, { maxItems: 10, maxBytes: 4 }, (item) =>
      Buffer.byteLength(item, "utf-8"),
    );

    expect(items).toEqual(["ccc"]);
    expect(buffer.byteLength()).toBe(3);
  });

  it("keeps accounting correct across remove, take and replace", () => {
    const items = ["a", "bb"];
    const buffer = new BoundedMessageBuffer(items, { maxItems: 3, maxBytes: 5 }, (item) =>
      Buffer.byteLength(item, "utf-8"),
    );

    expect(buffer.removeAt(0)).toBe("a");
    expect(buffer.byteLength()).toBe(2);
    expect(buffer.takeAll()).toEqual(["bb"]);
    expect(buffer.byteLength()).toBe(0);
    buffer.replace(["cc", "ddd"]);
    expect(items).toEqual(["cc", "ddd"]);
    expect(buffer.byteLength()).toBe(5);
  });
});
