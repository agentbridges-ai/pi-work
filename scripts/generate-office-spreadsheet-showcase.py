#!/usr/bin/env python3
"""Generate the deterministic spreadsheet preview showcase corpus."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import xlsxwriter


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "demo-user-space" / "office"
XLSX_PATH = OUT_DIR / "ONLYOFFICE Spreadsheet Preview Showcase.xlsx"
CSV_PATH = OUT_DIR / "ONLYOFFICE Spreadsheet Preview Showcase.csv"
ICON_PATH = ROOT / "web" / "public" / "icons" / "piwork-512.png"

NAVY = "#12304A"
BLUE = "#2F75B5"
TEAL = "#00A6A6"
GOLD = "#F2B134"
CORAL = "#E76F51"
PALE_BLUE = "#EAF3F8"
PALE_GOLD = "#FFF4D6"
PALE_GREEN = "#E7F5EF"
GRID = "#D7E0E7"
INK = "#18313F"
MUTED = "#607785"


DATA_ROWS = [
    ["2026-01-05", "North", "Document", 128, 74, 0.94, "Healthy"],
    ["2026-01-12", "South", "Spreadsheet", 156, 82, 0.91, "Healthy"],
    ["2026-01-19", "East", "Presentation", 118, 69, 0.88, "Watch"],
    ["2026-01-26", "West", "Document", 172, 91, 0.96, "Healthy"],
    ["2026-02-02", "North", "Spreadsheet", 184, 95, 0.92, "Healthy"],
    ["2026-02-09", "South", "Presentation", 143, 77, 0.86, "Watch"],
    ["2026-02-16", "East", "Document", 201, 108, 0.97, "Healthy"],
    ["2026-02-23", "West", "Spreadsheet", 194, 102, 0.90, "Healthy"],
    ["2026-03-02", "North", "Presentation", 167, 88, 0.84, "Risk"],
    ["2026-03-09", "South", "Document", 219, 116, 0.98, "Healthy"],
    ["2026-03-16", "East", "Spreadsheet", 208, 111, 0.93, "Healthy"],
    ["2026-03-23", "West", "Presentation", 181, 97, 0.89, "Watch"],
]


def add_formats(workbook: xlsxwriter.Workbook) -> dict[str, xlsxwriter.format.Format]:
    return {
        "title": workbook.add_format(
            {"font_name": "Aptos Display", "font_size": 24, "bold": True, "font_color": NAVY}
        ),
        "subtitle": workbook.add_format(
            {"font_name": "Aptos", "font_size": 11, "font_color": MUTED}
        ),
        "section": workbook.add_format(
            {
                "font_name": "Aptos Display",
                "font_size": 14,
                "bold": True,
                "font_color": "#FFFFFF",
                "bg_color": BLUE,
                "align": "left",
                "valign": "vcenter",
            }
        ),
        "label": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "bold": True, "font_color": MUTED}
        ),
        "metric": workbook.add_format(
            {
                "font_name": "Aptos Display",
                "font_size": 18,
                "bold": True,
                "font_color": NAVY,
                "bg_color": PALE_BLUE,
                "align": "center",
                "valign": "vcenter",
                "border": 1,
                "border_color": GRID,
            }
        ),
        "body": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "font_color": INK, "valign": "vcenter"}
        ),
        "wrapped": workbook.add_format(
            {
                "font_name": "Aptos",
                "font_size": 10,
                "font_color": INK,
                "text_wrap": True,
                "valign": "vcenter",
            }
        ),
        "cell": workbook.add_format(
            {
                "font_name": "Aptos",
                "font_size": 10,
                "font_color": INK,
                "valign": "vcenter",
                "border": 1,
                "border_color": GRID,
            }
        ),
        "cell_wrapped": workbook.add_format(
            {
                "font_name": "Aptos",
                "font_size": 10,
                "font_color": INK,
                "text_wrap": True,
                "valign": "vcenter",
                "border": 1,
                "border_color": GRID,
            }
        ),
        "date": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "font_color": INK, "num_format": "yyyy-mm-dd"}
        ),
        "time": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "font_color": INK, "num_format": "h:mm AM/PM"}
        ),
        "percent": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "font_color": INK, "num_format": "0.0%"}
        ),
        "currency": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "font_color": INK, "num_format": "$#,##0.00"}
        ),
        "scientific": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "font_color": INK, "num_format": "0.00E+00"}
        ),
        "header": workbook.add_format(
            {
                "font_name": "Aptos",
                "font_size": 10,
                "bold": True,
                "font_color": "#FFFFFF",
                "bg_color": NAVY,
                "align": "center",
                "valign": "vcenter",
                "border": 1,
                "border_color": "#FFFFFF",
            }
        ),
        "input": workbook.add_format(
            {
                "font_name": "Aptos",
                "font_size": 10,
                "font_color": INK,
                "bg_color": PALE_GOLD,
                "border": 1,
                "border_color": GOLD,
            }
        ),
        "formula": workbook.add_format(
            {
                "font_name": "Aptos",
                "font_size": 10,
                "font_color": NAVY,
                "bg_color": PALE_GREEN,
                "border": 1,
                "border_color": TEAL,
            }
        ),
        "link": workbook.add_format(
            {"font_name": "Aptos", "font_size": 10, "font_color": "#0563C1", "underline": True}
        ),
        "rtl": workbook.add_format(
            {"font_name": "Arial", "font_size": 13, "font_color": NAVY, "align": "right"}
        ),
        "cjk": workbook.add_format(
            {"font_name": "PingFang SC", "font_size": 13, "font_color": NAVY, "align": "right"}
        ),
    }


def configure_sheet(sheet: xlsxwriter.worksheet.Worksheet, tab_color: str) -> None:
    sheet.set_tab_color(tab_color)
    sheet.hide_gridlines(2)
    sheet.set_margins(0.35, 0.35, 0.55, 0.55)
    sheet.set_header("&LONLYOFFICE Preview Showcase&C&F&RPage &P of &N")
    sheet.set_footer("&LGenerated fixture&CStatic preview corpus&R2026")
    sheet.set_landscape()
    sheet.fit_to_pages(1, 0)
    sheet.repeat_rows(0, 1)


def write_overview(
    workbook: xlsxwriter.Workbook,
    formats: dict[str, xlsxwriter.format.Format],
) -> None:
    sheet = workbook.add_worksheet("Overview")
    configure_sheet(sheet, BLUE)
    sheet.freeze_panes(6, 1)
    sheet.set_column("A:A", 2.5)
    sheet.set_column("B:B", 18)
    sheet.set_column("C:F", 15)
    sheet.set_column("G:G", 3)
    sheet.set_column("H:L", 13)
    sheet.set_row(1, 34)

    sheet.merge_range("B2:F2", "Spreadsheet Preview Showcase", formats["title"])
    sheet.merge_range(
        "B3:F3",
        "Typed cells, formulas, validation, conditional formats, charts, drawings and print metadata",
        formats["subtitle"],
    )
    if ICON_PATH.exists():
        sheet.insert_image("H2", str(ICON_PATH), {"x_scale": 0.13, "y_scale": 0.13, "description": "Piwork mark"})

    sheet.merge_range("B5:L5", "Live KPI formulas", formats["section"])
    metrics = [
        ("B6:C6", "Total opens", "=SUM(DataTable[Opens])", 2091),
        ("D6:E6", "Total saves", "=SUM(DataTable[Saves])", 1110),
        ("F6:G6", "Average fidelity", "=AVERAGE(DataTable[Fidelity])", 0.915),
        ("H6:I6", "Healthy rows", '=COUNTIF(DataTable[Status],"Healthy")', 8),
    ]
    for cell_range, label, formula, cached in metrics:
        first, last = cell_range.split(":")
        row, col = xlsxwriter.utility.xl_cell_to_rowcol(first)
        _, last_col = xlsxwriter.utility.xl_cell_to_rowcol(last)
        sheet.merge_range(row, col, row, last_col, label, formats["label"])
        sheet.merge_range(row + 1, col, row + 1, last_col, "", formats["metric"])
        sheet.write_formula(row + 1, col, formula, formats["metric"], cached)

    sheet.merge_range("B10:F10", "Input and validation", formats["section"])
    sheet.write("B11", "Format", formats["label"])
    sheet.write("C11", "Document", formats["input"])
    sheet.data_validation("C11", {"validate": "list", "source": ["Document", "Spreadsheet", "Presentation"]})
    sheet.write("B12", "Threshold", formats["label"])
    sheet.write_number("C12", 0.9, formats["percent"])
    sheet.data_validation("C12", {"validate": "decimal", "criteria": "between", "minimum": 0.5, "maximum": 1})
    sheet.write("B13", "Review date", formats["label"])
    sheet.write_datetime("C13", datetime(2026, 4, 30), formats["date"])
    sheet.data_validation("C13", {"validate": "date", "criteria": "between", "minimum": datetime(2026, 1, 1), "maximum": datetime(2026, 12, 31)})

    sheet.merge_range("B15:F15", "Formula coverage", formats["section"])
    formula_rows = [
        ("Arithmetic", "=ROUND(SUM(Data!D2:D13)/12,1)", 174.3),
        ("Logical", '=IF(C12>=0.9,"PASS","REVIEW")', "PASS"),
        ("Text", '=TEXTJOIN(" · ",TRUE,C11,"preview")', "Document · preview"),
        ("Date", '=NETWORKDAYS(DATE(2026,1,1),C13)', 86),
        ("Lookup", '=XLOOKUP(C11,{"Document","Spreadsheet","Presentation"},{"Word","Cell","Slide"})', "Word"),
        ("Cross-sheet", "=SUM(RegionalTotals)", 2091),
    ]
    for index, (label, formula, cached) in enumerate(formula_rows, 16):
        sheet.write(index - 1, 1, label, formats["label"])
        sheet.write_formula(index - 1, 2, formula, formats["formula"], cached)

    sheet.write_url("B24", "https://github.com/ONLYOFFICE/DocumentServer", formats["link"], "Authoritative upstream")
    sheet.write_comment("C11", "S12 comment marker: validation choice used by the preview test.", {"author": "Piwork QA"})
    sheet.insert_textbox(
        "H10",
        "S13 TEXT BOX\nDrawing objects must remain selectable and readable.",
        {
            "width": 320,
            "height": 90,
            "font": {"name": "Aptos", "size": 11, "color": NAVY},
            "fill": {"color": PALE_BLUE},
            "line": {"color": BLUE, "width": 1.5},
            "align": {"vertical": "middle", "horizontal": "center"},
        },
    )
    sheet.autofilter("B26:F30")
    sheet.write_row("B26", ["Filter ID", "Owner", "State", "Score", "Note"], formats["header"])
    for row, values in enumerate(
        [
            [1, "Avery", "Ready", 98, "visible"],
            [2, "Chen", "Review", 84, "visible"],
            [3, "Fatima", "Ready", 93, "visible"],
            [4, "Mateo", "Hold", 71, "visible"],
        ],
        27,
    ):
        sheet.write_row(row - 1, 1, values, formats["body"])

    sheet.conditional_format("D27:D30", {"type": "data_bar", "bar_color": BLUE})
    sheet.print_area("B2:L30")


def write_data(
    workbook: xlsxwriter.Workbook,
    formats: dict[str, xlsxwriter.format.Format],
) -> None:
    sheet = workbook.add_worksheet("Data")
    configure_sheet(sheet, TEAL)
    sheet.freeze_panes(1, 2)
    sheet.set_column("A:A", 13)
    sheet.set_column("B:C", 16)
    sheet.set_column("D:E", 11)
    sheet.set_column("F:F", 12)
    sheet.set_column("G:G", 13)
    headers = ["Date", "Region", "Format", "Opens", "Saves", "Fidelity", "Status"]
    for row_index, values in enumerate(DATA_ROWS, 1):
        sheet.write_datetime(row_index, 0, datetime.fromisoformat(values[0]), formats["date"])
        sheet.write_row(row_index, 1, values[1:5], formats["body"])
        sheet.write_number(row_index, 5, values[5], formats["percent"])
        sheet.write(row_index, 6, values[6], formats["body"])
    sheet.add_table(
        0,
        0,
        len(DATA_ROWS) + 1,
        len(headers) - 1,
        {
            "name": "DataTable",
            "style": "Table Style Medium 2",
            "columns": [
                {"header": "Date"},
                {"header": "Region"},
                {"header": "Format"},
                {"header": "Opens", "total_function": "sum"},
                {"header": "Saves", "total_function": "sum"},
                {"header": "Fidelity", "total_function": "average"},
                {"header": "Status", "total_function": "count"},
            ],
            "total_row": True,
        },
    )
    workbook.define_name("RegionalTotals", "=Data!$D$2:$D$13")
    sheet.conditional_format("F2:F13", {"type": "3_color_scale", "min_color": CORAL, "mid_color": GOLD, "max_color": TEAL})
    sheet.conditional_format("G2:G13", {"type": "text", "criteria": "containing", "value": "Risk", "format": workbook.add_format({"bg_color": "#FDE2E2", "font_color": "#9B1C1C"})})
    sheet.conditional_format("D2:D13", {"type": "icon_set", "icon_style": "3_traffic_lights"})
    sheet.conditional_format("E2:E13", {"type": "formula", "criteria": "=$E2>$D2", "format": workbook.add_format({"bg_color": PALE_GOLD})})
    sheet.set_row(0, 24)
    sheet.print_area("A1:G14")
    sheet.protect("preview", {"select_locked_cells": True, "select_unlocked_cells": True})


def write_formats(
    workbook: xlsxwriter.Workbook,
    formats: dict[str, xlsxwriter.format.Format],
) -> None:
    sheet = workbook.add_worksheet("Formats")
    configure_sheet(sheet, GOLD)
    sheet.set_column("A:A", 2.5)
    sheet.set_column("B:B", 22)
    sheet.set_column("C:E", 20)
    sheet.merge_range("B2:E2", "Cell types and formatting", formats["title"])
    sheet.write_row("B4", ["Type", "Value", "Displayed result", "Marker"], formats["header"])
    cases = [
        ("Text", "Hello 世界", "Hello 世界", formats["cell"]),
        ("Integer", 123456, "123456", formats["cell"]),
        ("Currency", 9876.5, "$9,876.50", formats["currency"]),
        ("Percentage", 0.875, "87.5%", formats["percent"]),
        ("Scientific", 0.00001234, "1.23E-05", formats["scientific"]),
        ("Date", datetime(2026, 7, 22), "Jul 22, 2026", formats["date"]),
        ("Time", datetime(2026, 7, 22, 14, 35), "2:35 PM", formats["time"]),
        ("Boolean", True, "TRUE", formats["cell"]),
        ("Blank", None, "", formats["cell"]),
    ]
    for row, (kind, value, display, cell_format) in enumerate(cases, 4):
        sheet.write(row, 1, kind, formats["cell"])
        if isinstance(value, datetime):
            sheet.write_datetime(row, 2, value, cell_format)
        else:
            sheet.write(row, 2, value, cell_format)
        sheet.write(row, 3, display, formats["cell_wrapped"])
        sheet.write(row, 4, f"S02-{row - 3:02d}", formats["cell"])
    sheet.write_formula("C14", "=1/0", formats["cell"], "#DIV/0!")
    sheet.write("B14", "Error", formats["cell"])
    sheet.write("D14", "#DIV/0!", formats["cell"])
    sheet.merge_range("B16:E16", "Merged heading", formats["section"])
    sheet.set_row(15, 28)
    sheet.set_column("C:C", 22)
    sheet.write_rich_string(
        "B18",
        workbook.add_format({"bold": True, "font_color": BLUE}),
        "Bold blue",
        " · ",
        workbook.add_format({"italic": True, "font_color": CORAL}),
        "italic coral",
        " · rich string",
        formats["wrapped"],
    )
    rotated = workbook.add_format({"rotation": 30, "bg_color": PALE_BLUE, "border": 1, "align": "center"})
    sheet.write("D18", "Rotated 30°", rotated)
    sheet.set_row(17, 42)
    sheet.print_area("B2:E20")


def write_charts(workbook: xlsxwriter.Workbook) -> None:
    sheet = workbook.add_worksheet("Charts")
    configure_sheet(sheet, CORAL)
    sheet.set_column("A:A", 2)
    sheet.set_column("B:M", 11)
    sheet.write_row("B2", ["Month", "Document", "Spreadsheet", "Presentation", "Target"])
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
    values = [
        [120, 105, 92, 100],
        [138, 118, 101, 110],
        [151, 132, 116, 120],
        [169, 147, 128, 130],
        [188, 164, 143, 145],
        [212, 183, 157, 160],
    ]
    for row, month in enumerate(months, 2):
        sheet.write(row, 1, month)
        sheet.write_row(row, 2, values[row - 2])

    def series(chart, column, name):
        chart.add_series({"name": name, "categories": "=Charts!$B$3:$B$8", "values": f"=Charts!${column}$3:${column}$8"})

    column_chart = workbook.add_chart({"type": "column"})
    series(column_chart, "C", "Document")
    series(column_chart, "D", "Spreadsheet")
    column_chart.set_title({"name": "Column"})
    column_chart.set_style(10)
    sheet.insert_chart("B10", column_chart, {"x_scale": 0.83, "y_scale": 0.75})

    line_chart = workbook.add_chart({"type": "line"})
    series(line_chart, "C", "Document")
    series(line_chart, "E", "Presentation")
    line_chart.set_title({"name": "Line"})
    line_chart.set_style(13)
    sheet.insert_chart("H10", line_chart, {"x_scale": 0.83, "y_scale": 0.75})

    pie_chart = workbook.add_chart({"type": "pie"})
    pie_chart.add_series({"name": "June mix", "categories": "=Charts!$C$2:$E$2", "values": "=Charts!$C$8:$E$8", "data_labels": {"percentage": True}})
    pie_chart.set_title({"name": "Pie"})
    pie_chart.set_style(10)
    sheet.insert_chart("B25", pie_chart, {"x_scale": 0.83, "y_scale": 0.75})

    area_chart = workbook.add_chart({"type": "area", "subtype": "stacked"})
    series(area_chart, "C", "Document")
    series(area_chart, "D", "Spreadsheet")
    area_chart.set_title({"name": "Area"})
    area_chart.set_style(12)
    sheet.insert_chart("H25", area_chart, {"x_scale": 0.83, "y_scale": 0.75})

    scatter_chart = workbook.add_chart({"type": "scatter", "subtype": "straight_with_markers"})
    scatter_chart.add_series({"name": "Saves vs opens", "categories": "=Data!$D$2:$D$13", "values": "=Data!$E$2:$E$13"})
    scatter_chart.set_title({"name": "Scatter"})
    scatter_chart.set_style(11)
    sheet.insert_chart("B40", scatter_chart, {"x_scale": 0.83, "y_scale": 0.75})

    combo_column = workbook.add_chart({"type": "column"})
    series(combo_column, "C", "Document")
    combo_line = workbook.add_chart({"type": "line"})
    series(combo_line, "F", "Target")
    combo_column.combine(combo_line)
    combo_column.set_title({"name": "Combo"})
    combo_column.set_style(10)
    sheet.insert_chart("H40", combo_column, {"x_scale": 0.83, "y_scale": 0.75})
    sheet.print_area("B2:M54")


def write_sparklines(workbook: xlsxwriter.Workbook, formats: dict[str, xlsxwriter.format.Format]) -> None:
    sheet = workbook.add_worksheet("Sparklines")
    configure_sheet(sheet, TEAL)
    sheet.set_column("A:A", 2)
    sheet.set_column("B:B", 18)
    sheet.set_column("C:H", 10)
    sheet.set_column("I:K", 18)
    sheet.merge_range("B2:K2", "Sparkline types", formats["title"])
    sheet.write_row("B4", ["Series", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Line", "Column", "Win/Loss"], formats["header"])
    spark_rows = [
        ["Document", 12, 18, 16, 24, 28, 31],
        ["Spreadsheet", 9, 13, 15, 14, 22, 26],
        ["Presentation", -4, 7, -2, 9, 11, -1],
    ]
    for row, values in enumerate(spark_rows, 4):
        sheet.write_row(row, 1, values, formats["body"])
        excel_row = row + 1
        sheet.add_sparkline(row, 8, {"range": f"C{excel_row}:H{excel_row}", "type": "line", "markers": True})
        sheet.add_sparkline(row, 9, {"range": f"C{excel_row}:H{excel_row}", "type": "column"})
        sheet.add_sparkline(row, 10, {"range": f"C{excel_row}:H{excel_row}", "type": "win_loss"})
    sheet.set_row(4, 28)
    sheet.set_row(5, 28)
    sheet.set_row(6, 28)
    sheet.print_area("B2:K9")


def write_rtl(workbook: xlsxwriter.Workbook, formats: dict[str, xlsxwriter.format.Format]) -> None:
    sheet = workbook.add_worksheet("RTL & CJK")
    configure_sheet(sheet, NAVY)
    sheet.right_to_left()
    sheet.set_column("A:A", 2)
    sheet.set_column("B:F", 22)
    sheet.merge_range("B2:F2", "多语言与从右到左布局", formats["cjk"])
    sheet.merge_range("B4:F4", "简体中文：预览必须保持字形与颜色。", formats["cjk"])
    sheet.merge_range("B6:F6", "العربية: يجب أن يبقى اتجاه النص من اليمين إلى اليسار.", formats["rtl"])
    sheet.merge_range("B8:F8", "עברית: תצוגה מקדימה בכיוון מימין לשמאל.", formats["rtl"])
    sheet.merge_range("B10:F10", "日本語：セルの折り返しと配置を確認します。", formats["cjk"])
    sheet.print_area("B2:F12")


def write_hidden_reference(workbook: xlsxwriter.Workbook) -> None:
    sheet = workbook.add_worksheet("Reference")
    sheet.write_row("A1", ["Code", "Label"])
    sheet.write_row("A2", ["DOC", "Document"])
    sheet.write_row("A3", ["CELL", "Spreadsheet"])
    sheet.write_row("A4", ["SLIDE", "Presentation"])
    sheet.hide()


def write_csv() -> None:
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["Date", "Region", "Format", "Opens", "Saves", "Fidelity", "Status"])
        writer.writerows(DATA_ROWS)


def contains_native_excel_objects(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        with ZipFile(path) as archive:
            return any(
                name.startswith(("xl/pivotTables/", "xl/slicers/", "xl/slicerCaches/"))
                for name in archive.namelist()
            )
    except BadZipFile:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-only",
        action="store_true",
        help="explicitly replace the native-Excel-enriched workbook with the generated base",
    )
    args = parser.parse_args()
    if contains_native_excel_objects(XLSX_PATH) and not args.base_only:
        raise SystemExit(
            f"Refusing to overwrite native PivotTable/slicer objects in {XLSX_PATH}. "
            "Pass --base-only only when intentionally regenerating the pre-enrichment base."
        )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    workbook = xlsxwriter.Workbook(XLSX_PATH)
    workbook.set_properties(
        {
            "title": "ONLYOFFICE Spreadsheet Preview Showcase",
            "subject": "Deterministic spreadsheet rendering and document-model fixture",
            "author": "Piwork",
            "company": "agentbridges-ai",
            "comments": "Generated by scripts/generate-office-spreadsheet-showcase.py",
            "created": datetime(2026, 7, 22, 0, 0, 0),
        }
    )
    formats = add_formats(workbook)
    write_overview(workbook, formats)
    write_data(workbook, formats)
    write_formats(workbook, formats)
    write_charts(workbook)
    write_sparklines(workbook, formats)
    write_rtl(workbook, formats)
    write_hidden_reference(workbook)
    workbook.close()
    write_csv()
    print(XLSX_PATH)
    print(CSV_PATH)


if __name__ == "__main__":
    main()
