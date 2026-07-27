# Office preview demo capability matrix

This directory is a deterministic preview corpus, not a collection of unrelated sample files. The comprehensive Word, PowerPoint, and Excel documents are authored OOXML sources. The retained `Example Title.*` family covers legacy Microsoft and OpenDocument imports through the maintained `onlyoffice-x2t-wasm` path. Export-format coverage is tested separately and is not misrepresented as a comprehensive static fixture.

The matrix follows the document features advertised by the authoritative `ONLYOFFICE/DocumentServer` product surface. It covers static document content and document-model metadata that can be verified after the editor iframe loads. Collaboration, macros, mail merge execution, presenter mode, Solver execution, spell-checking, protection passwords, and other runtime workflows are intentionally outside a static preview corpus.

This file is also the implementation checklist. W01–W20, P01–P13, and S01–S21 have authored sources and executable package assertions. W20 remains a focused legacy-DOC regression. The spreadsheet source is generated deterministically, then enriched in native Microsoft Excel with a PivotTable and slicer; the generator refuses to overwrite that enriched artifact unless `--base-only` is passed explicitly. True SmartArt/diagram parts and custom sheet views remain explicitly pending below; grouped editable shapes are not mislabeled as SmartArt.

## Word family

Comprehensive source: `ONLYOFFICE Word Preview Showcase.docx`\
Focused regressions retained separately: the `Example Title.*` series.

| ID  | Supported preview element                                         | Stable acceptance signal                         |
| --- | ----------------------------------------------------------------- | ------------------------------------------------ |
| W01 | Title, subtitle, headings, body styles                            | Named styles and marker text                     |
| W02 | Bold, italic, underline, strike, color, highlight                 | Distinct formatted runs                          |
| W03 | Superscript, subscript, symbols, CJK and RTL text                 | Marker runs retained                             |
| W04 | Paragraph alignment, indents, spacing, borders and shading        | Paragraph properties retained                    |
| W05 | Bulleted, numbered and multilevel lists                           | Numbering definitions and list paragraphs        |
| W06 | Table with header row, merged cells, borders, fills and alignment | Table dimensions and marker cells                |
| W07 | Inline raster image with alternative text                         | Decoded image with non-zero dimensions           |
| W08 | SVG image                                                         | Decoded SVG with non-zero dimensions             |
| W09 | Floating image and text wrapping                                  | Anchored drawing and wrap metadata               |
| W10 | Autoshape and text box                                            | Drawing objects and marker text                  |
| W11 | Native chart with multiple colored series                         | Chart object, series count and non-black brushes |
| W12 | Equation                                                          | Math object and equation marker                  |
| W13 | External hyperlink and internal bookmark link                     | Hyperlink targets and bookmark retained          |
| W14 | Rich-text and checkbox content controls                           | Content-control types and marker text            |
| W15 | Comment                                                           | Comment range and comment text                   |
| W16 | Footnote and endnote                                              | Note references and note text                    |
| W17 | Header, footer and page number field                              | Header/footer content and field retained         |
| W18 | Page break, section break, columns and landscape section          | Section count and geometry                       |
| W19 | Table of contents and caption/cross-reference fields              | Field instructions and cached display text       |
| W20 | Embedded OLE chart fallback in legacy DOC                         | `COleObject` preview SVG decodes above `0×0`     |
| W21 | SmartArt diagram — pending source fixture                         | Diagram parts, relationships and rendered model  |

## PowerPoint family

Comprehensive source: `ONLYOFFICE Presentation Preview Showcase.pptx`; focused legacy PPT and ODP inputs remain in the `Example Title.*` series.

| ID  | Supported preview element                          | Stable acceptance signal                    |
| --- | -------------------------------------------------- | ------------------------------------------- |
| P01 | Theme, slide master, layouts and background        | Master/layout references and slide geometry |
| P02 | Text hierarchy and rich run formatting             | Marker text and distinct runs               |
| P03 | Bulleted and numbered lists                        | Paragraph bullet properties                 |
| P04 | Autoshapes, fills, gradients, outlines and shadows | Named shapes and fill/line model            |
| P05 | Connectors, alignment, ordering and grouping       | Connector/group drawing objects             |
| P06 | Raster and SVG images with alternative text        | Decoded images with non-zero dimensions     |
| P07 | Table with merged cells and styled header          | Table dimensions and marker cells           |
| P08 | Native charts with multiple chart types and series | Chart types, series and colors              |
| P09 | Equation and symbols                               | Math/text marker retained                   |
| P10 | Hyperlinks to URL, email and another slide         | Relationship targets retained               |
| P11 | Speaker notes, footer, date and slide number       | Notes and placeholder metadata              |
| P12 | Slide transitions and object animations            | Transition/timing nodes retained            |
| P13 | Grouped process diagram; true SmartArt pending     | Group and child drawing objects             |

## Excel family

Comprehensive source: `ONLYOFFICE Spreadsheet Preview Showcase.xlsx`; focused legacy XLS and ODS inputs remain in the `Example Title.*` series, and `ONLYOFFICE Spreadsheet Preview Showcase.csv` is the deliberately data-only interchange case.

| ID  | Supported preview element                                                  | Stable acceptance signal                                                 |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S01 | Multiple visible/hidden sheets and tab colors                              | Sheet count, state and tab colors                                        |
| S02 | Text, numbers, dates, times, percentages, currency and scientific formats  | Typed cell values and number formats                                     |
| S03 | Font styles, fills, gradients, borders, alignment, wrapping and rotation   | Distinct cell style records                                              |
| S04 | Merged cells, row heights and column widths                                | Merge ranges and dimensions                                              |
| S05 | Arithmetic, logical, text, date, lookup and aggregate formulas             | Formula text and cached results                                          |
| S06 | Cross-sheet formulas and named ranges                                      | Defined names and formula references                                     |
| S07 | Formatted table and total row                                              | Table object, style and totals formulas                                  |
| S08 | Sorting and autofilter metadata                                            | Filter range and sort state                                              |
| S09 | Freeze panes and outline groups                                            | Pane and outline metadata                                                |
| S10 | Data validation list, number and date rules                                | Validation records and target ranges                                     |
| S11 | Conditional formatting: value, formula, data bar, color scale and icon set | Rule types and ranges                                                    |
| S12 | Cell comments/notes and external hyperlink                                 | Comment text and hyperlink target                                        |
| S13 | Raster image and text box                                                  | Drawing objects and decoded image                                        |
| S14 | Column, line, pie, area, scatter and combo charts                          | Chart objects and series counts                                          |
| S15 | Column, line and win/loss sparklines                                       | Sparkline groups and locations                                           |
| S16 | Error, blank, boolean and rich-string cases                                | Cell types and displayed values                                          |
| S17 | Sheet protection metadata                                                  | Protection flags retained                                                |
| S18 | Print area, repeating rows, margins, orientation, headers and footers      | Page setup and defined names                                             |
| S19 | Right-to-left sheet and CJK text                                           | Sheet view direction and marker text                                     |
| S20 | Legacy XLS and ODS palette fidelity                                        | Selected cell fills match source RGB values                              |
| S21 | Native PivotTable and Region slicer                                        | 12-record cache, row/column/data/filter fields and slicer parts retained |
| S22 | Custom sheet-view metadata — pending source fixture                        | Custom sheet-view parts retained                                         |
| S23 | SmartArt diagram and equation — pending source fixture                     | Diagram/math drawing objects retained                                    |

## Acceptance layers

1. Package structure: inspect OOXML/ODF/legacy conversion outputs for the parts named above.
2. Converter regression: run x2t and assert semantic XML/model content, not only exit code.
3. Browser model: load each fixture and inspect the corresponding ONLYOFFICE editor iframe model for marker text, object types, counts, colors, decoded media dimensions, formulas, and relationships.
4. Rendering smoke: retain screenshots only as failure artifacts; they are diagnostic evidence, not the primary pass condition.
