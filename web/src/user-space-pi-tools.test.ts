import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { applyTextEditsLikePi, readTextLikePi } from "./user-space-pi-tools.js";

describe("User Space pi tool compatibility", () => {
  it("reads offset and limit with pi continuation notices", () => {
    const text = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join("\n");
    const result = readTextLikePi(text, "lines.txt", 41, 20);

    expect(result.content).toContain("Line 41");
    expect(result.content).toContain("Line 60");
    expect(result.content).not.toContain("Line 61");
    expect(result.content).toContain("[40 more lines in file. Use offset=61 to continue.]");
    expect(result.nextOffset).toBe(61);
  });

  it("reports an offset beyond the file exactly like pi", () => {
    expect(() => readTextLikePi("one\ntwo\nthree", "short.txt", 100)).toThrow(
      "Offset 100 is beyond end of file (3 lines total)",
    );
  });

  it("truncates at pi's 50KB byte limit without returning partial lines", () => {
    const text = Array.from(
      { length: 500 },
      (_, index) => `Line ${index + 1}: ${"x".repeat(200)}`,
    ).join("\n");
    const result = readTextLikePi(text, "large.txt");

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.content).toMatch(
      /\[Showing lines 1-\d+ of 500 \(50\.0KB limit\)\.\nUse offset=\d+ to continue\.\]/,
    );
  });

  it("rejects non-unique and overlapping edits", () => {
    expect(() =>
      applyTextEditsLikePi("foo foo foo", [{ oldText: "foo", newText: "bar" }], "dup.txt"),
    ).toThrow("Found 3 occurrences");
    expect(() =>
      applyTextEditsLikePi(
        "one\ntwo\nthree\n",
        [
          { oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
          { oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
        ],
        "overlap.txt",
      ),
    ).toThrow("overlap");
  });

  it("matches disjoint edits against the original content atomically", () => {
    const result = applyTextEditsLikePi(
      "foo\nbar\nbaz\n",
      [
        { oldText: "foo\n", newText: "foo bar\n" },
        { oldText: "bar\n", newText: "BAR\n" },
      ],
      "multi.txt",
    );

    expect(result.content).toBe("foo bar\nBAR\nbaz\n");
    expect(result.patch).toContain("@@");
    expect(applyPatch("foo\nbar\nbaz\n", result.patch)).toBe(result.content);
  });

  it("preserves untouched fuzzy lines, BOM, and CRLF endings", () => {
    const original = "\uFEFFconsole.log(‘hello’);  \r\nkeep  \r\n";
    const result = applyTextEditsLikePi(
      original,
      [{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" }],
      "fuzzy.txt",
    );

    expect(result.content).toBe("\uFEFFconsole.log('world');\r\nkeep  \r\n");
    expect(applyPatch("console.log(‘hello’);  \nkeep  \n", result.patch)).toBe(
      "console.log('world');\nkeep  \n",
    );
  });

  it("rejects edits that make no change", () => {
    expect(() =>
      applyTextEditsLikePi("hello\n", [{ oldText: "hello", newText: "hello" }], "same.txt"),
    ).toThrow("No changes made to same.txt");
  });
});
