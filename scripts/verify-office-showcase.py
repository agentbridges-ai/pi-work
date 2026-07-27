#!/usr/bin/env python3
"""Verify semantic package content for the deterministic Office preview corpus."""

from __future__ import annotations

from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
OFFICE = ROOT / "demo-user-space" / "office"


def read(archive: ZipFile, name: str) -> str:
    return archive.read(name).decode("utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def verify_word() -> None:
    path = OFFICE / "ONLYOFFICE Word Preview Showcase.docx"
    with ZipFile(path) as archive:
        names = set(archive.namelist())
        document = read(archive, "word/document.xml")
        rels = read(archive, "word/_rels/document.xml.rels")
        chart = read(archive, "word/charts/chart1.xml")
        content_types = read(archive, "[Content_Types].xml")
        for marker in ("W01", "W02", "W03", "W04", "W05", "W06", "W07", "W08", "W09", "W10", "W11", "W12", "W13", "W14", "W15", "W16", "W17/W19", "W18", "W20", "W21"):
            require(marker in document, f"Word marker missing: {marker}")
        require(document.count("<w:sdt") >= 2, "Word content controls missing")
        require("<m:oMath" in document, "Word equation object missing")
        require("<wp:anchor" in document and "wrapSquare" in document, "Word floating image metadata missing")
        require("<v:roundrect" in document and "w:txbxContent" in document, "Word text box missing")
        require("w:footnoteReference" in document and "w:endnoteReference" in document, "Word note references missing")
        require("w:commentRangeStart" in document and "comments" in rels, "Word comment range/relationship missing")
        require(document.count("<w:sectPr") >= 2 and 'w:orient="landscape"' in document and 'w:num="2"' in document, "Word section geometry missing")
        require("word/media/showcase-vector.svg" in names and "image/svg+xml" in content_types, "Word SVG part or content type missing")
        require(chart.count("<c:ser>") == 5, "Word native chart must contain five series")
        require(chart.count("<a:gradFill>") == 5 and chart.count("<a:gs ") >= 10, "Word chart gradients missing")
        require("word/footnotes.xml" in names and "W16 footnote" in read(archive, "word/footnotes.xml"), "Word footnote resource missing")
        require("word/endnotes.xml" in names and "W16 endnote" in read(archive, "word/endnotes.xml"), "Word endnote resource missing")


def verify_presentation() -> None:
    path = OFFICE / "ONLYOFFICE Presentation Preview Showcase.pptx"
    with ZipFile(path) as archive:
        names = set(archive.namelist())
        slides = sorted(name for name in names if name.startswith("ppt/slides/slide") and name.endswith(".xml"))
        charts = sorted(name for name in names if name.startswith("ppt/charts/chart") and name.endswith(".xml"))
        require(len(slides) == 9, f"Presentation expected 9 slides, found {len(slides)}")
        slide_xml = [read(archive, name) for name in slides]
        joined = "".join(slide_xml)
        for marker in ("P01", "P02/P03", "P04/P05", "P06", "P07", "P08", "P09/P10", "P11/P12", "P13"):
            require(marker in joined, f"Presentation marker missing: {marker}")
        require(sum("<p:transition" in xml for xml in slide_xml) == 9, "Presentation transitions missing")
        require("<p:timing" in slide_xml[7] and "animEffect" in slide_xml[7], "Presentation animation timing missing")
        require("<p:grpSp" in slide_xml[2] and "<p:grpSp" in slide_xml[8], "Presentation grouped diagrams missing")
        require("<a:tbl>" in slide_xml[4] and "gridSpan" in slide_xml[4], "Presentation merged table missing")
        require(len(charts) == 3, f"Presentation expected 3 charts, found {len(charts)}")
        require(any(name.endswith(".svg") for name in names if name.startswith("ppt/media/")), "Presentation SVG media part missing")
        note_parts = sorted(name for name in names if name.startswith("ppt/notesSlides/notesSlide") and name.endswith(".xml"))
        require(note_parts and any("P11 speaker notes" in read(archive, name) for name in note_parts), "Presentation notes missing")
        require("hyperlink" in read(archive, "ppt/slides/_rels/slide7.xml.rels"), "Presentation hyperlink relationships missing")


def verify_spreadsheet() -> None:
    path = OFFICE / "ONLYOFFICE Spreadsheet Preview Showcase.xlsx"
    with ZipFile(path) as archive:
        names = set(archive.namelist())
        workbook = read(archive, "xl/workbook.xml")
        sheets = sorted(name for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"))
        charts = sorted(name for name in names if name.startswith("xl/charts/chart") and name.endswith(".xml"))
        require(len(sheets) == 8, f"Spreadsheet expected 8 sheets, found {len(sheets)}")
        require(
            'state="hidden"' in workbook
            and "RegionalTotals" in workbook
            and "Native PivotTable and Slicer" in workbook,
            "Spreadsheet hidden/reference/native-object sheet metadata missing",
        )
        joined = "".join(read(archive, name) for name in sheets)
        require(joined.count("<dataValidation") >= 3, "Spreadsheet data validation rules missing")
        require("<conditionalFormatting" in joined and "dataBar" in joined and "colorScale" in joined and "iconSet" in joined, "Spreadsheet conditional formats missing")
        require("<sheetProtection" in joined, "Spreadsheet protection metadata missing")
        require('rightToLeft="1"' in joined, "Spreadsheet RTL view missing")
        require("sparklineGroups" in joined, "Spreadsheet sparklines missing")
        require(len(charts) == 6, f"Spreadsheet expected 6 charts, found {len(charts)}")
        require("xl/tables/table1.xml" in names, "Spreadsheet source table missing")
        totals_table = read(archive, "xl/tables/table2.xml")
        require(
            'name="TotalsDemo"' in totals_table
            and 'totalsRowCount="1"' in totals_table
            and totals_table.count('totalsRowFunction="sum"') == 2,
            "Spreadsheet independent table total-row example missing",
        )
        pivot = read(archive, "xl/pivotTables/pivotTable1.xml")
        pivot_cache = read(archive, "xl/pivotCache/pivotCacheDefinition1.xml")
        pivot_records = read(archive, "xl/pivotCache/pivotCacheRecords1.xml")
        slicer = read(archive, "xl/slicers/slicer1.xml")
        slicer_cache = read(archive, "xl/slicerCaches/slicerCache1.xml")
        status_field = pivot_cache.split('<cacheField name="Status"', 1)[1].split("</cacheField>", 1)[0]
        require(
            'name="数据透视表汇总"' in pivot
            and '<rowFields count="1">' in pivot
            and '<colFields count="2">' in pivot
            and '<pageFields count="1">' in pivot
            and '<dataFields count="3">' in pivot,
            "Spreadsheet native pivot layout is incomplete",
        )
        require(
            'recordCount="12"' in pivot_cache
            and '<worksheetSource ref="A1:G13" sheet="Data"/>' in pivot_cache
            and 'count="12"' in pivot_records
            and "containsNumber" not in status_field
            and '<n v="12"/>' not in pivot_records,
            "Spreadsheet pivot cache includes the table total row or bogus Status value",
        )
        require(
            'name="区域筛选"' in slicer
            and 'caption="区域 Region"' in slicer
            and 'sourceName="Region"' in slicer_cache
            and '<items count="4">' in slicer_cache,
            "Spreadsheet native Region slicer is incomplete",
        )
        require(any(name.startswith("xl/comments") for name in names), "Spreadsheet comment resource missing")
        require(any(name.startswith("xl/drawings/drawing") for name in names), "Spreadsheet drawing resource missing")
        require("_xlnm.Print_Area" in workbook and "_xlnm.Print_Titles" in workbook, "Spreadsheet print metadata missing")


def verify_legacy_fixtures() -> None:
    expected = {
        "Example Title.doc",
        "Example Title.docx",
        "Example Title.odt",
        "Example Title.rtf",
        "Example Title.ppt",
        "Example Title.pptx",
        "Example Title.odp",
    }
    actual = {path.name for path in OFFICE.glob("Example Title.*")}
    require(expected <= actual, f"Example Title fixtures missing: {sorted(expected - actual)}")
    require(not list(OFFICE.glob("Example Document Title.*")), "Old Example Document Title fixtures remain")

    odp_path = OFFICE / "Example Title.odp"
    with ZipFile(odp_path) as archive:
        content = read(archive, "content.xml")
        root = ElementTree.fromstring(content)
        pages = root.findall(".//{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}page")
        text = "".join(root.itertext())
        require(len(pages) == 8, f"Example Title.odp expected 8 slides, found {len(pages)}")
        require("How They Throw Out" in text, "Example Title.odp opening title missing")
        require("ONLYOFFICE stands for Peace" in text, "Example Title.odp closing title missing")

    rtf = (OFFICE / "Example Title.rtf").read_bytes()
    require(rtf.startswith(b"{\\rtf"), "Example Title.rtf has an invalid RTF header")
    require(len(rtf) > 500_000, "Example Title.rtf is unexpectedly small")
    require(b"\\pict" in rtf, "Example Title.rtf has no static chart picture")
    require(b"\\object" not in rtf, "Example Title.rtf unexpectedly contains an OLE object")
    require(b"\\objdata" not in rtf, "Example Title.rtf unexpectedly contains embedded OLE data")
    require(b"Excel.Chart" not in rtf, "Example Title.rtf contains an Excel.Chart placeholder")


def main() -> None:
    verify_word()
    verify_presentation()
    verify_spreadsheet()
    verify_legacy_fixtures()
    print("Verified Word, Presentation, Spreadsheet and Example Title package semantics.")


if __name__ == "__main__":
    main()
