import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  buildPreview,
  DOCX_PREVIEW_ARCHIVE_LIMITS,
  PRESENTATION_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  WORD_EXTENSIONS,
} from "./preview-builder.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const ASSOCIATED_OFFICE_FORMATS = [
  ["document.doc", "application/msword", "word"],
  ["document.docx", DOCX_MIME, "word"],
  ["document.odt", "application/vnd.oasis.opendocument.text", "word"],
  ["document.rtf", "application/rtf", "word"],
  ["workbook.xls", "application/vnd.ms-excel", "spreadsheet"],
  [
    "workbook.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "spreadsheet",
  ],
  ["workbook.ods", "application/vnd.oasis.opendocument.spreadsheet", "spreadsheet"],
  ["workbook.csv", "text/csv", "spreadsheet"],
  ["slides.ppt", "application/vnd.ms-powerpoint", "presentation"],
  [
    "slides.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "presentation",
  ],
  ["slides.odp", "application/vnd.oasis.opendocument.presentation", "presentation"],
] as const;

describe("OnlyOffice file associations", () => {
  it.each(ASSOCIATED_OFFICE_FORMATS)(
    "routes %s to the Office preview with its declared MIME type",
    async (name, mimeType, family) => {
      const file = new File([new Uint8Array([1, 2, 3])], name);

      const preview = await buildPreview(file, name);

      expect(preview.kind).toBe("office");
      if (preview.kind !== "office") throw new Error("Expected an Office preview.");
      expect(preview.officeFile).toBeInstanceOf(File);
      expect(preview.officeFile?.type).toBe(mimeType);
      const extension = name.split(".").pop() || "";
      expect(
        family === "word"
          ? WORD_EXTENSIONS.has(extension)
          : family === "spreadsheet"
            ? SPREADSHEET_EXTENSIONS.has(extension)
            : PRESENTATION_EXTENSIONS.has(extension),
      ).toBe(true);
    },
  );

  it("keeps TXT in the text preview instead of associating it with OnlyOffice", async () => {
    const file = new File(["plain text"], "notes.txt", { type: "text/plain" });

    const preview = await buildPreview(file, file.name);

    expect(preview.kind).toBe("text");
  });
});

function docxFile(bytes: Uint8Array, name = "report.docx"): File {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const file = new File([copy.buffer], name, { type: DOCX_MIME });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => bytes.slice().buffer,
  });
  return file;
}

describe("DOCX preview archive limits", () => {
  it("normalizes a small valid DOCX archive", async () => {
    const bytes = zipSync({
      "word/document.xml": strToU8('<w:rFonts w:eastAsia="Calibri"/>'),
    });
    const file = docxFile(bytes);

    const preview = await buildPreview(file, file.name);

    expect(preview.kind).toBe("office");
    if (preview.kind !== "office") throw new Error("Expected an Office preview.");
    expect(preview.officeFile).not.toBe(file);
  });

  it("rejects an oversized compressed input before reading its bytes", async () => {
    const file = docxFile(new Uint8Array([80, 75, 3, 4]));
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperty(file, "size", {
      configurable: true,
      value: DOCX_PREVIEW_ARCHIVE_LIMITS.compressedBytes + 1,
    });
    Object.defineProperty(file, "arrayBuffer", { configurable: true, value: arrayBuffer });

    const preview = await buildPreview(file, file.name);

    expect(preview.kind).toBe("office");
    if (preview.kind !== "office") throw new Error("Expected an Office preview.");
    expect(preview.officeFile).toBe(file);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects a high-ratio DOCX zip bomb before inflating it", async () => {
    const highlyCompressibleXml = `<w:rFonts w:eastAsia="Calibri"/>${"A".repeat(512 * 1024)}`;
    const bytes = zipSync({ "word/document.xml": strToU8(highlyCompressibleXml) }, { level: 9 });
    expect(highlyCompressibleXml.length / bytes.byteLength).toBeGreaterThan(
      DOCX_PREVIEW_ARCHIVE_LIMITS.compressionRatio,
    );
    const file = docxFile(bytes);

    const preview = await buildPreview(file, file.name);

    expect(preview.kind).toBe("office");
    if (preview.kind !== "office") throw new Error("Expected an Office preview.");
    expect(preview.officeFile).toBe(file);
  });

  it("rejects archives with excessive central-directory entries", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: DOCX_PREVIEW_ARCHIVE_LIMITS.entryCount + 1 }, (_, index) => [
        `word/empty-${index}.xml`,
        new Uint8Array(),
      ]),
    );
    entries["word/document.xml"] = strToU8('<w:rFonts w:eastAsia="Calibri"/>');
    const file = docxFile(zipSync(entries));

    const preview = await buildPreview(file, file.name);

    expect(preview.kind).toBe("office");
    if (preview.kind !== "office") throw new Error("Expected an Office preview.");
    expect(preview.officeFile).toBe(file);
  });
});
