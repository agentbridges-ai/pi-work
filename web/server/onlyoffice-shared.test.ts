import { describe, expect, it } from "vitest";
import { isOnlyOfficeWriteOperation, parseOnlyOfficeOperation } from "../shared/onlyoffice.js";

describe("OnlyOffice shared operation validation", () => {
  it("accepts read operations and identifies writes", () => {
    expect(
      isOnlyOfficeWriteOperation(parseOnlyOfficeOperation({ type: "get_document_text" })),
    ).toBe(false);
    expect(
      isOnlyOfficeWriteOperation(
        parseOnlyOfficeOperation({ type: "get_slide_text", slideIndex: 0 }),
      ),
    ).toBe(false);
    expect(
      isOnlyOfficeWriteOperation(
        parseOnlyOfficeOperation({ type: "save_document", reason: "task_completed" }),
      ),
    ).toBe(true);
  });

  it("validates text, formatting, range, chart, and presentation operations", () => {
    const valid = [
      { type: "search_text", query: "needle" },
      { type: "count_text", searchText: "needle" },
      { type: "replace_all_text", searchText: "old", replaceText: "new", trackChanges: true },
      { type: "append_text", text: "text", trackChanges: true },
      { type: "format_selection", trackChanges: true, bold: true, colorHex: "#ffffff" },
      { type: "add_comment", text: "comment" },
      { type: "get_range_values", range: "Sheet1!A1:B2" },
      { type: "set_range_values", range: "A1", values: [["x", 1, true]] },
      { type: "set_cell_formula", cell: "A1", formula: "=SUM(B1)" },
      { type: "format_range", range: "A1", numberFormat: "0.00" },
      { type: "insert_chart", dataRange: "A1:B2", chartType: "bar", anchorCell: "C3" },
      { type: "get_presentation_info", maxSlides: 10, maxCharsPerSlide: 1000 },
      { type: "get_slide_text", slideIndex: 0, maxChars: 1000 },
      { type: "append_slide", title: "Title" },
    ];
    for (const operation of valid) expect(parseOnlyOfficeOperation(operation)).toEqual(operation);
  });

  it("rejects malformed operations and unsafe bounds", () => {
    const invalid = [
      undefined,
      { type: "unknown" },
      { type: "search_text", query: "" },
      { type: "replace_all_text", searchText: "old", replaceText: "new" },
      { type: "format_selection", trackChanges: true },
      { type: "set_range_values", range: "A1", values: [[null]] },
      { type: "insert_chart", dataRange: "A1", chartType: "not-a-chart" },
      { type: "get_slide_text", slideIndex: -1 },
      { type: "save_document", reason: "manual" },
    ];
    for (const operation of invalid) expect(() => parseOnlyOfficeOperation(operation)).toThrow();
  });
});
