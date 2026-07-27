#!/usr/bin/env python3
"""Create a DOCX source whose charts are static pictures for RTF export.

RTF has no DrawingML chart representation. Converting the showcase DOCX
directly makes x2t preserve the chart workbook as an editable Excel OLE object,
whose RTF result preview is only an ``Excel.Chart`` placeholder. This helper
keeps the authored chart data but renders it as SVG before the x2t RTF pass.
The original DOCX remains unchanged and retains its native editable chart.
"""

from __future__ import annotations

import argparse
import html
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
PICTURE_URI = NS["pic"]
IMAGE_REL = f"{NS['r']}/image"


def chart_text(node: ElementTree.Element | None, fallback: str) -> str:
    if node is None:
        return fallback
    text = "".join(value.text or "" for value in node.findall(".//a:t", NS))
    if not text:
        text = "".join(value.text or "" for value in node.findall(".//c:v", NS))
    return text.strip() or fallback


def cached_values(series: ElementTree.Element) -> list[float]:
    return [float(value.text or "0") for value in series.findall(".//c:val//c:pt/c:v", NS)]


def cached_categories(series: ElementTree.Element) -> list[str]:
    return [value.text or "" for value in series.findall(".//c:cat//c:pt/c:v", NS)]


def make_chart_svg(chart_xml: bytes) -> bytes:
    root = ElementTree.fromstring(chart_xml)
    series_nodes = root.findall(".//c:barChart/c:ser", NS)
    if not series_nodes:
        raise ValueError("The RTF source chart has no clustered bar series")

    categories = cached_categories(series_nodes[0])
    series = [
        (chart_text(item.find("c:tx", NS), f"Series {index + 1}"), cached_values(item))
        for index, item in enumerate(series_nodes)
    ]
    if not categories or any(len(values) != len(categories) for _, values in series):
        raise ValueError("The RTF source chart cache is incomplete")

    title = chart_text(root.find(".//c:chart/c:title", NS), "Sample Chart")
    value_axis = chart_text(root.find(".//c:valAx/c:title", NS), "Sales in $ Mn")
    width, height = 1152, 496
    plot_left, plot_top, plot_right, plot_bottom = 120, 90, 1110, 390
    plot_width = plot_right - plot_left
    plot_height = plot_bottom - plot_top
    maximum = max(value for _, values in series for value in values)
    axis_max = max(100, ((int(maximum) + 99) // 100) * 100)
    palette = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5"]

    pieces = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="1152" height="496" fill="#ffffff"/>',
        f'<text x="576" y="48" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="700">{html.escape(title)}</text>',
    ]
    for tick in range(0, axis_max + 1, 100):
        y = plot_bottom - (tick / axis_max) * plot_height
        pieces.extend([
            f'<line x1="{plot_left}" y1="{y:.2f}" x2="{plot_right}" y2="{y:.2f}" stroke="#d9e2f3" stroke-width="1"/>',
            f'<text x="{plot_left - 18}" y="{y + 6:.2f}" text-anchor="end" font-family="Arial,sans-serif" font-size="16" fill="#44546a">{tick}</text>',
        ])

    group_width = plot_width / len(categories)
    bar_gap = 3
    bar_width = min(28, (group_width - 36) / len(series))
    for category_index, category in enumerate(categories):
        bars_width = len(series) * bar_width + (len(series) - 1) * bar_gap
        group_x = plot_left + category_index * group_width + (group_width - bars_width) / 2
        for series_index, (_, values) in enumerate(series):
            value = values[category_index]
            bar_height = value / axis_max * plot_height
            x = group_x + series_index * (bar_width + bar_gap)
            y = plot_bottom - bar_height
            pieces.append(
                f'<rect x="{x:.2f}" y="{y:.2f}" width="{bar_width:.2f}" height="{bar_height:.2f}" fill="{palette[series_index % len(palette)]}"/>'
            )
        center = plot_left + (category_index + 0.5) * group_width
        pieces.append(
            f'<text x="{center:.2f}" y="425" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" fill="#44546a">{html.escape(category)}</text>'
        )

    pieces.extend(
        [
            f'<text x="34" y="240" text-anchor="middle" transform="rotate(-90 34 240)" font-family="Arial,sans-serif" font-size="20" font-weight="700">{html.escape(value_axis)}</text>',
            "</svg>",
        ]
    )
    return "".join(pieces).encode("utf-8")


def prepare(source: Path, target: Path) -> None:
    with ZipFile(source) as archive:
        entries = {info.filename: archive.read(info.filename) for info in archive.infolist()}

    # Do not serialize the entire Word document with ElementTree: doing so
    # renames namespace prefixes referenced by mc:Choice/@Requires. Patch only
    # the chart nodes so all authored compatibility markup stays byte-for-byte.
    document = entries["word/document.xml"].decode("utf-8")
    relationships = entries["word/_rels/document.xml.rels"].decode("utf-8")
    chart_pattern = re.compile(
        r'<a:graphicData\s+uri="http://schemas\.openxmlformats\.org/drawingml/2006/chart">'
        r'<c:chart[^>]*\br:id="([^"]+)"[^>]*/>'
        r'</a:graphicData>'
    )
    matches = list(chart_pattern.finditer(document))
    if not matches:
        raise ValueError("No DrawingML charts were found in the RTF source DOCX")

    replacement_index = 0

    def replace_chart(match: re.Match[str]) -> str:
        nonlocal relationships, replacement_index
        replacement_index += 1
        chart_relationship_id = match.group(1)
        relationship_match = re.search(
            rf'<Relationship\s+Id="{re.escape(chart_relationship_id)}"[^>]*\sTarget="([^"]+)"[^>]*/>',
            relationships,
        )
        if relationship_match is None:
            raise ValueError(f"Chart relationship {chart_relationship_id} is missing")
        chart_path = f"word/{relationship_match.group(1)}"
        preview_name = f"rtf-chart-preview-{replacement_index}.svg"
        preview_relationship_id = f"rIdRtfChartPreview{replacement_index}"
        entries[f"word/media/{preview_name}"] = make_chart_svg(entries[chart_path])
        relationship = (
            f'<Relationship Id="{preview_relationship_id}" Type="{IMAGE_REL}" '
            f'Target="media/{preview_name}"/>'
        )
        relationships = relationships.replace("</Relationships>", f"{relationship}</Relationships>")
        return (
            f'<a:graphicData uri="{PICTURE_URI}">'
            f'<pic:pic xmlns:pic="{PICTURE_URI}">'
            '<pic:nvPicPr><pic:cNvPr id="3" name="Static chart preview"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{preview_relationship_id}"/>'
            '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6152511" cy="2649216"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            '</pic:pic></a:graphicData>'
        )

    document = chart_pattern.sub(replace_chart, document)
    content_types = entries["[Content_Types].xml"].decode("utf-8")
    if 'Extension="svg"' not in content_types:
        content_types = content_types.replace(
            "</Types>", '<Default Extension="svg" ContentType="image/svg+xml"/></Types>'
        )

    entries["word/document.xml"] = document.encode("utf-8")
    entries["word/_rels/document.xml.rels"] = relationships.encode("utf-8")
    entries["[Content_Types].xml"] = content_types.encode("utf-8")

    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(target, "w", ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    prepare(args.source, args.target)


if __name__ == "__main__":
    main()
