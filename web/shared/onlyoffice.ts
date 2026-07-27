export const ONLYOFFICE_PLUGIN_GUID = "asc.{7F1B98C4-21D8-4D6B-A7F0-9E8506E23A10}";

export type OnlyOfficeDocumentType = "word" | "cell" | "slide";

export type OnlyOfficeFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  colorHex?: string;
  highlightHex?: string;
};

export type OnlyOfficeCellValue = string | number | boolean;

export type OnlyOfficeOperation =
  | { type: "get_document_text"; maxChars?: number }
  | { type: "get_selected_text" }
  | { type: "get_selection_format" }
  | {
      type: "search_text";
      query: string;
      matchCase?: boolean;
      wholeWords?: boolean;
      maxResults?: number;
      contextChars?: number;
    }
  | { type: "count_text"; searchText: string; matchCase?: boolean; wholeWords?: boolean }
  | {
      type: "replace_all_text";
      searchText: string;
      replaceText: string;
      matchCase?: boolean;
      trackChanges: true;
    }
  | { type: "insert_text_at_cursor"; text: string; trackChanges: true }
  | { type: "prepend_text"; text: string; trackChanges: true }
  | { type: "append_text"; text: string; trackChanges: true }
  | ({ type: "format_selection"; trackChanges: true } & OnlyOfficeFormat)
  | { type: "add_comment"; text: string }
  | { type: "get_workbook_info" }
  | { type: "get_range_values"; sheet?: string; range: string }
  | { type: "get_charts_info"; sheet?: string }
  | {
      type: "set_range_values";
      sheet?: string;
      range: string;
      values: OnlyOfficeCellValue | OnlyOfficeCellValue[] | OnlyOfficeCellValue[][];
    }
  | { type: "set_cell_formula"; sheet?: string; cell: string; formula: string }
  | ({
      type: "format_range";
      sheet?: string;
      range: string;
      numberFormat?: string;
    } & OnlyOfficeFormat)
  | {
      type: "insert_chart";
      sheet?: string;
      dataRange: string;
      chartType: "bar" | "bar3D" | "lineNormal" | "line3D" | "pie" | "pie3D" | "area" | "scatter";
      title?: string;
      inRows?: boolean;
      styleIndex?: number;
      widthMm?: number;
      heightMm?: number;
      anchorCell?: string;
      fromCol?: number;
      fromRow?: number;
    }
  | { type: "get_presentation_info"; maxSlides?: number; maxCharsPerSlide?: number }
  | { type: "get_slide_text"; slideIndex: number; maxChars?: number }
  | { type: "append_slide"; title?: string; body?: string; notes?: string }
  | { type: "save_document"; reason: "task_completed" };

export type OnlyOfficeDocumentDescriptor = {
  leaseId: string;
  editorInstanceId: string;
  title: string;
  mountId: string;
  path: string;
  fileType: string;
  documentType: OnlyOfficeDocumentType;
  writable: boolean;
  pluginReady: boolean;
  foreground: boolean;
};

export type OnlyOfficeOperationTarget = {
  mountId: string;
  path: string;
  closeAfter?: boolean;
};

export type OnlyOfficeBrowserRequest = {
  type: "onlyoffice_request";
  request_id: string;
  lease_id?: string;
  editor_instance_id?: string;
  target?: OnlyOfficeOperationTarget;
  operation: OnlyOfficeOperation;
};

export type OnlyOfficeBrowserResponse = {
  type: "onlyoffice_response";
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  client_msg_id?: string;
};

export type OnlyOfficeBrowserStatus = {
  type: "onlyoffice_status";
  document: OnlyOfficeDocumentDescriptor | null;
  client_msg_id?: string;
};

const operationTypes = new Set<OnlyOfficeOperation["type"]>([
  "get_document_text",
  "get_selected_text",
  "get_selection_format",
  "search_text",
  "count_text",
  "replace_all_text",
  "insert_text_at_cursor",
  "prepend_text",
  "append_text",
  "format_selection",
  "add_comment",
  "get_workbook_info",
  "get_range_values",
  "get_charts_info",
  "set_range_values",
  "set_cell_formula",
  "format_range",
  "insert_chart",
  "get_presentation_info",
  "get_slide_text",
  "append_slide",
  "save_document",
]);

const chartTypes = new Set([
  "bar",
  "bar3D",
  "lineNormal",
  "line3D",
  "pie",
  "pie3D",
  "area",
  "scatter",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasTrackedChanges(value: Record<string, unknown>): boolean {
  return value.trackChanges === true;
}

function validRange(value: unknown): value is string {
  return hasText(value) && value.length <= 200;
}

function validColor(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value));
}

function validOptionalInteger(value: unknown, min: number, max: number): boolean {
  return (
    value === undefined || (Number.isInteger(value) && Number(value) >= min && Number(value) <= max)
  );
}

function validOptionalNumber(value: unknown, min: number, max: number): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max)
  );
}

function validAnchorCell(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(value.trim());
  if (!match) return false;
  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  const row = Number(match[2]);
  return column >= 1 && column <= 16_384 && row >= 1 && row <= 1_048_576;
}

function validCellValues(value: unknown): boolean {
  const validCell = (cell: unknown) =>
    typeof cell === "string" ||
    (typeof cell === "number" && Number.isFinite(cell)) ||
    typeof cell === "boolean";
  if (validCell(value)) return true;
  if (!Array.isArray(value) || value.length > 10_000) return false;
  return value.every((row) => {
    if (validCell(row)) return true;
    return Array.isArray(row) && row.length <= 10_000 && row.every(validCell);
  });
}

export function isOnlyOfficeWriteOperation(operation: OnlyOfficeOperation): boolean {
  return ![
    "get_document_text",
    "get_selected_text",
    "get_selection_format",
    "search_text",
    "count_text",
    "get_workbook_info",
    "get_range_values",
    "get_charts_info",
    "get_presentation_info",
    "get_slide_text",
  ].includes(operation.type);
}

export function parseOnlyOfficeOperation(value: unknown): OnlyOfficeOperation {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !operationTypes.has(value.type as OnlyOfficeOperation["type"])
  ) {
    throw new Error("Unsupported ONLYOFFICE operation.");
  }
  switch (value.type) {
    case "search_text":
      if (!hasText(value.query)) throw new Error("search_text requires query.");
      break;
    case "count_text":
      if (!hasText(value.searchText)) throw new Error("count_text requires searchText.");
      break;
    case "replace_all_text":
      if (
        !hasText(value.searchText) ||
        typeof value.replaceText !== "string" ||
        !hasTrackedChanges(value)
      ) {
        throw new Error(
          "replace_all_text requires searchText, replaceText, and trackChanges=true.",
        );
      }
      break;
    case "insert_text_at_cursor":
    case "prepend_text":
    case "append_text":
      if (!hasText(value.text) || !hasTrackedChanges(value)) {
        throw new Error(`${value.type} requires text and trackChanges=true.`);
      }
      break;
    case "format_selection":
      if (!hasTrackedChanges(value))
        throw new Error("format_selection requires trackChanges=true.");
      if (!validColor(value.colorHex) || !validColor(value.highlightHex)) {
        throw new Error("format_selection colors must be six-digit hex values.");
      }
      if (
        ![
          "bold",
          "italic",
          "underline",
          "fontFamily",
          "fontSizePt",
          "colorHex",
          "highlightHex",
        ].some((key) => value[key] !== undefined)
      ) {
        throw new Error("format_selection requires at least one formatting property.");
      }
      break;
    case "add_comment":
      if (!hasText(value.text)) throw new Error("add_comment requires text.");
      break;
    case "get_range_values":
      if (!validRange(value.range)) throw new Error("get_range_values requires range.");
      break;
    case "set_range_values":
      if (!validRange(value.range) || !validCellValues(value.values)) {
        throw new Error(
          'set_range_values requires range and values containing only strings, finite numbers, or booleans; null is unsupported (use "" for an empty cell).',
        );
      }
      break;
    case "set_cell_formula":
      if (!validRange(value.cell) || !hasText(value.formula)) {
        throw new Error("set_cell_formula requires cell and formula.");
      }
      break;
    case "format_range":
      if (!validRange(value.range)) throw new Error("format_range requires range.");
      if (!validColor(value.colorHex) || !validColor(value.highlightHex)) {
        throw new Error("format_range colors must be six-digit hex values.");
      }
      if (
        ![
          "bold",
          "italic",
          "underline",
          "fontFamily",
          "fontSizePt",
          "colorHex",
          "highlightHex",
          "numberFormat",
        ].some((key) => value[key] !== undefined)
      ) {
        throw new Error("format_range requires at least one formatting property.");
      }
      break;
    case "insert_chart":
      if (!validRange(value.dataRange) || !chartTypes.has(String(value.chartType))) {
        throw new Error("insert_chart requires dataRange and a supported chartType.");
      }
      if (
        (value.title !== undefined &&
          (typeof value.title !== "string" || value.title.length > 500)) ||
        (value.inRows !== undefined && typeof value.inRows !== "boolean") ||
        !validOptionalInteger(value.styleIndex, 1, 48) ||
        !validOptionalNumber(value.widthMm, 20, 500) ||
        !validOptionalNumber(value.heightMm, 20, 500) ||
        !validAnchorCell(value.anchorCell) ||
        !validOptionalInteger(value.fromCol, 0, 16_383) ||
        !validOptionalInteger(value.fromRow, 0, 1_048_575)
      ) {
        throw new Error("insert_chart has invalid title, layout, size, style, or anchor values.");
      }
      break;
    case "get_presentation_info":
      if (
        !validOptionalInteger(value.maxSlides, 1, 500) ||
        !validOptionalInteger(value.maxCharsPerSlide, 1, 100_000)
      ) {
        throw new Error("get_presentation_info limits must be bounded positive integers.");
      }
      break;
    case "get_slide_text":
      if (
        !validOptionalInteger(value.slideIndex, 0, 9_999) ||
        value.slideIndex === undefined ||
        !validOptionalInteger(value.maxChars, 1, 100_000)
      ) {
        throw new Error("get_slide_text requires a bounded zero-based slideIndex.");
      }
      break;
    case "append_slide":
      if (
        ![value.title, value.body, value.notes].some(hasText) ||
        [value.title, value.body, value.notes].some(
          (part) => part !== undefined && (typeof part !== "string" || part.length > 100_000),
        )
      ) {
        throw new Error("append_slide requires bounded title, body, or notes text.");
      }
      break;
    case "save_document":
      if (value.reason !== "task_completed") {
        throw new Error("save_document reason must be task_completed.");
      }
      break;
  }
  return value as OnlyOfficeOperation;
}
