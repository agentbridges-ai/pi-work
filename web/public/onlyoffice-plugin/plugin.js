/* global Api, Asc */
(function () {
  "use strict";

  const protocol = "onlyoffice-browser-plugin/v1";
  const pluginGuid = "asc.{7F1B98C4-21D8-4D6B-A7F0-9E8506E23A10}";
  const pluginInstanceId = createPluginInstanceId();
  const bridgeHost = window.parent.parent;
  const completed = new Map();
  const maxCompleted = 512;
  let readyPosted = false;

  window.Asc.plugin.init = function () {
    announceReady();
  };
  window.Asc.plugin.button = function () {};

  const readyPoll = window.setInterval(function () {
    if (announceReady()) window.clearInterval(readyPoll);
  }, 100);
  window.setTimeout(function () {
    window.clearInterval(readyPoll);
  }, 30_000);

  function announceReady() {
    const editorType = String((window.Asc.plugin.info && window.Asc.plugin.info.editorType) || "");
    if (readyPosted || !editorType || typeof window.Asc.plugin.executeMethod !== "function") {
      return readyPosted;
    }
    readyPosted = true;
    post({
      type: "READY",
      editorType: editorType,
    });
    return true;
  }

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (
      event.source !== bridgeHost ||
      event.origin !== window.location.origin ||
      !message ||
      message.protocol !== protocol ||
      message.pluginGuid !== pluginGuid ||
      message.pluginInstanceId !== pluginInstanceId ||
      message.type !== "INVOKE" ||
      typeof message.requestId !== "string"
    ) {
      return;
    }

    let operation = completed.get(message.requestId);
    if (!operation) {
      operation = executeOperation(message.payload);
      completed.set(message.requestId, operation);
      while (completed.size > maxCompleted) completed.delete(completed.keys().next().value);
    }
    operation
      .then(function (result) {
        post({ type: "RESULT", requestId: message.requestId, ok: true, result: result });
      })
      .catch(function (error) {
        post({
          type: "RESULT",
          requestId: message.requestId,
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      });
  });

  async function executeOperation(operation) {
    if (!operation || typeof operation.type !== "string")
      throw new Error("Invalid Office operation");
    const editorType = String((window.Asc.plugin.info && window.Asc.plugin.info.editorType) || "");
    if (operation.type === "save_document") return { saved: true };
    if (editorType === "cell") return executeSpreadsheetOperation(operation);
    if (editorType === "slide") return executePresentationOperation(operation);
    if (editorType !== "word")
      throw new Error("This Office editor type is not supported yet: " + editorType);

    switch (operation.type) {
      case "get_document_text":
        return getDocumentText(operation.maxChars);
      case "get_selected_text":
        return executeMethod("GetSelectedText", null).then(function (text) {
          return { text: String(text || "") };
        });
      case "get_selection_format":
        return wordCommand(operation);
      case "search_text":
        return searchText(operation);
      case "count_text":
        return countText(operation);
      case "replace_all_text":
        await enableTrackChanges();
        return replaceAllText(operation);
      case "insert_text_at_cursor":
        await enableTrackChanges();
        return executeMethod("PasteText", [operation.text]);
      case "prepend_text":
        await enableTrackChanges();
        await executeMethod("MoveCursorToStart", []);
        return executeMethod("PasteText", [operation.text + "\n"]);
      case "append_text":
        await enableTrackChanges();
        await executeMethod("MoveCursorToEnd", []);
        return executeMethod("PasteText", ["\n" + operation.text]);
      case "format_selection":
        await enableTrackChanges();
        return wordCommand(operation);
      case "add_comment":
        return executeMethod("AddComment", [
          {
            UserName: "Piwork",
            UserId: "piwork-assistant",
            Text: operation.text,
            Time: String(Date.now()),
            Solved: false,
          },
        ]);
      default:
        throw new Error("Unsupported Word operation: " + operation.type);
    }
  }

  function executeSpreadsheetOperation(operation) {
    window.Asc.scope.piworkOperation = operation;
    return callCommand(function () {
      const op = Asc.scope.piworkOperation;
      const sheet = op.sheet ? Api.GetSheet(op.sheet) : Api.GetActiveSheet();
      if (!sheet) return { ok: false, error: "Worksheet not found: " + String(op.sheet || "") };

      function color(value) {
        const hex = String(value || "").replace(/^#/, "");
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
        return Api.CreateColorFromRGB(
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        );
      }

      switch (op.type) {
        case "get_workbook_info": {
          const sheets = Api.GetSheets();
          return {
            activeSheet: Api.GetActiveSheet().GetName(),
            sheets: sheets.map(function (item) {
              const used = item.GetUsedRange && item.GetUsedRange();
              return {
                name: item.GetName(),
                usedRange: used && used.GetAddress ? used.GetAddress() : null,
              };
            }),
          };
        }
        case "get_range_values": {
          const range = sheet.GetRange(op.range);
          if (!range) return { ok: false, error: "Range not found: " + op.range };
          return {
            sheet: sheet.GetName(),
            range: range.GetAddress ? range.GetAddress() : op.range,
            values: range.GetValue(),
            formulas: range.GetFormula ? range.GetFormula() : null,
            text: range.GetText ? range.GetText() : null,
          };
        }
        case "get_charts_info": {
          const charts = sheet.GetAllCharts ? sheet.GetAllCharts() : [];
          return {
            sheet: sheet.GetName(),
            count: charts.length,
            charts: charts.map(function (chart, index) {
              return {
                index: index,
                name: chart.GetName ? chart.GetName() : null,
                chartType: chart.GetChartType ? chart.GetChartType() : null,
                title: chart.GetTitle ? chart.GetTitle() : null,
                widthMm: chart.GetWidth ? chart.GetWidth() / 36000 : null,
                heightMm: chart.GetHeight ? chart.GetHeight() / 36000 : null,
              };
            }),
          };
        }
        case "set_range_values": {
          const range = sheet.GetRange(op.range);
          if (!range || range.SetValue(op.values) === false) {
            return { ok: false, error: "Unable to set range values" };
          }
          return { ok: true, sheet: sheet.GetName(), range: op.range };
        }
        case "set_cell_formula": {
          const range = sheet.GetRange(op.cell);
          if (!range || range.SetFormula(op.formula) === false) {
            return { ok: false, error: "Unable to set cell formula" };
          }
          return { ok: true, sheet: sheet.GetName(), cell: op.cell, formula: op.formula };
        }
        case "format_range": {
          const range = sheet.GetRange(op.range);
          if (!range) return { ok: false, error: "Range not found: " + op.range };
          const applied = [];
          if (typeof op.bold === "boolean") {
            range.SetBold(op.bold);
            applied.push("bold");
          }
          if (typeof op.italic === "boolean") {
            range.SetItalic(op.italic);
            applied.push("italic");
          }
          if (typeof op.underline === "boolean") {
            range.SetUnderline(op.underline ? "single" : "none");
            applied.push("underline");
          }
          if (op.fontFamily) {
            range.SetFontName(op.fontFamily);
            applied.push("fontFamily");
          }
          if (typeof op.fontSizePt === "number") {
            range.SetFontSize(op.fontSizePt);
            applied.push("fontSizePt");
          }
          if (op.colorHex) {
            range.SetFontColor(color(op.colorHex));
            applied.push("colorHex");
          }
          if (op.highlightHex) {
            range.SetFillColor(color(op.highlightHex));
            applied.push("highlightHex");
          }
          if (op.numberFormat) {
            range.SetNumberFormat(op.numberFormat);
            applied.push("numberFormat");
          }
          return { ok: true, sheet: sheet.GetName(), range: op.range, applied: applied };
        }
        case "insert_chart": {
          let fromCol = typeof op.fromCol === "number" ? op.fromCol : 0;
          let fromRow = typeof op.fromRow === "number" ? op.fromRow : 5;
          let anchorCell = null;
          if (op.anchorCell) {
            const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(String(op.anchorCell).trim());
            if (!match) return { ok: false, error: "Invalid chart anchor cell: " + op.anchorCell };
            fromCol = 0;
            const letters = match[1].toUpperCase();
            for (let index = 0; index < letters.length; index += 1) {
              fromCol = fromCol * 26 + letters.charCodeAt(index) - 64;
            }
            fromCol -= 1;
            fromRow = Number(match[2]) - 1;
            anchorCell = letters + match[2];
          }
          const sheetName = sheet.GetName().replace(/'/g, "''");
          const source =
            op.dataRange.indexOf("!") >= 0 ? op.dataRange : "'" + sheetName + "'!" + op.dataRange;
          const chart = sheet.AddChart(
            source,
            op.inRows !== false,
            op.chartType,
            typeof op.styleIndex === "number" ? op.styleIndex : 2,
            (typeof op.widthMm === "number" ? op.widthMm : 120) * 36000,
            (typeof op.heightMm === "number" ? op.heightMm : 80) * 36000,
            fromCol,
            0,
            fromRow,
            0,
          );
          if (!chart) return { ok: false, error: "Unable to insert chart" };
          if (op.title && chart.SetTitle) chart.SetTitle(op.title, 13);
          return {
            ok: true,
            sheet: sheet.GetName(),
            dataRange: source,
            chartType: op.chartType,
            anchorCell: anchorCell,
            fromCol: fromCol,
            fromRow: fromRow,
            widthMm: typeof op.widthMm === "number" ? op.widthMm : 120,
            heightMm: typeof op.heightMm === "number" ? op.heightMm : 80,
          };
        }
        default:
          return { ok: false, error: "Unsupported spreadsheet operation: " + op.type };
      }
    });
  }

  function executePresentationOperation(operation) {
    window.Asc.scope.piworkOperation = operation;
    return callCommand(function () {
      const op = Asc.scope.piworkOperation;
      const presentation = Api.GetPresentation();
      const slides = presentation.GetAllSlides();

      function readSlide(slide, index, maxChars) {
        const shapes = slide && slide.GetAllShapes ? slide.GetAllShapes() : [];
        const text = shapes
          .map(function (shape) {
            const content = shape && shape.GetContent ? shape.GetContent() : null;
            return content && content.GetText ? String(content.GetText() || "") : "";
          })
          .filter(Boolean)
          .join("\n")
          .trim();
        const notesPage = slide && slide.GetNotesPage ? slide.GetNotesPage() : null;
        const notes =
          notesPage && notesPage.GetBodyShapeText
            ? String(notesPage.GetBodyShapeText() || "").trim()
            : "";
        const limit = Number(maxChars);
        const bounded = Number.isFinite(limit) && limit > 0 ? text.slice(0, limit) : text;
        return {
          index: index,
          text: bounded,
          textLength: text.length,
          truncated: bounded.length < text.length,
          notes: notes,
          visible: slide && slide.GetVisible ? slide.GetVisible() : true,
        };
      }

      switch (op.type) {
        case "get_presentation_info": {
          const limit = Math.min(Number(op.maxSlides) || 100, 500);
          return {
            slideCount: slides.length,
            returned: Math.min(slides.length, limit),
            truncated: slides.length > limit,
            slides: slides.slice(0, limit).map(function (slide, index) {
              return readSlide(slide, index, op.maxCharsPerSlide);
            }),
          };
        }
        case "get_slide_text": {
          const index = Number(op.slideIndex);
          if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
            return { ok: false, error: "Slide index is out of range: " + String(op.slideIndex) };
          }
          return readSlide(slides[index], index, op.maxChars);
        }
        case "append_slide": {
          const slide = Api.CreateSlide();
          slide.SetBackground(Api.CreateSolidFill(Api.RGB(255, 255, 255)));
          const noFill = Api.CreateNoFill();
          const noStroke = Api.CreateStroke(0, noFill);
          if (op.title) {
            const title = Api.CreateShape("rect", 220 * 36000, 30 * 36000, noFill, noStroke);
            title.SetPosition(17 * 36000, 15 * 36000);
            const titleParagraph = title.GetContent().GetElement(0);
            titleParagraph.AddText(op.title);
            titleParagraph.SetFontSize(48);
            titleParagraph.SetBold(true);
            slide.AddObject(title);
          }
          if (op.body) {
            const body = Api.CreateShape("rect", 220 * 36000, 115 * 36000, noFill, noStroke);
            body.SetPosition(17 * 36000, 55 * 36000);
            const bodyParagraph = body.GetContent().GetElement(0);
            bodyParagraph.AddText(op.body);
            bodyParagraph.SetFontSize(32);
            slide.AddObject(body);
          }
          if (op.notes) slide.AddNotesText(op.notes);
          presentation.AddSlide(slide);
          return { ok: true, slideIndex: slides.length, slideCount: slides.length + 1 };
        }
        default:
          return { ok: false, error: "Unsupported presentation operation: " + op.type };
      }
    });
  }

  function wordCommand(operation) {
    window.Asc.scope.piworkOperation = operation;
    return callCommand(function () {
      const op = Asc.scope.piworkOperation;
      const range = Api.GetDocument().GetRangeBySelect();
      if (!range) return { ok: false, error: "No selected range" };
      if (op.type === "get_selection_format") {
        const textPr = range.GetTextPr ? range.GetTextPr() : null;
        return {
          ok: true,
          text: range.GetText ? range.GetText() : "",
          textPr: textPr && textPr.ToJSON ? textPr.ToJSON() : textPr,
        };
      }
      const applied = [];
      if (typeof op.bold === "boolean" && range.SetBold) {
        range.SetBold(op.bold);
        applied.push("bold");
      }
      if (typeof op.italic === "boolean" && range.SetItalic) {
        range.SetItalic(op.italic);
        applied.push("italic");
      }
      if (typeof op.underline === "boolean" && range.SetUnderline) {
        range.SetUnderline(op.underline);
        applied.push("underline");
      }
      if (op.fontFamily && range.SetFontFamily) {
        range.SetFontFamily(op.fontFamily);
        applied.push("fontFamily");
      }
      if (typeof op.fontSizePt === "number" && range.SetFontSize) {
        range.SetFontSize(op.fontSizePt);
        applied.push("fontSizePt");
      }
      if (op.colorHex && range.SetColor) {
        const value = rgb(op.colorHex);
        range.SetColor(Api.CreateRGBColor(value.r, value.g, value.b));
        applied.push("colorHex");
      }
      if (op.highlightHex && range.SetShd) {
        const value = rgb(op.highlightHex);
        range.SetShd("clear", Api.CreateRGBColor(value.r, value.g, value.b));
        applied.push("highlightHex");
      }
      return { ok: true, applied: applied, text: range.GetText ? range.GetText() : "" };

      function rgb(value) {
        const hex = String(value || "").replace(/^#/, "");
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
        };
      }
    });
  }

  async function replaceAllText(operation) {
    const before = await getDocumentText();
    const beforeCount = countOccurrences(
      before.text,
      operation.searchText,
      operation.matchCase === true,
      false,
    );
    const result = await executeMethod("SearchAndReplace", [
      {
        searchString: operation.searchText,
        replaceString: operation.replaceText,
        matchCase: operation.matchCase === true,
      },
    ]);
    const after = await getDocumentText();
    const afterCount = countOccurrences(
      after.text,
      operation.searchText,
      operation.matchCase === true,
      false,
    );
    if (beforeCount > 0 && before.text === after.text) {
      throw new Error("Replacement could not be verified against the resulting document text.");
    }
    return { ok: true, result: result, beforeCount: beforeCount, afterCount: afterCount };
  }

  async function countText(operation) {
    const snapshot = await getDocumentText();
    return {
      searchText: operation.searchText,
      matchCase: operation.matchCase === true,
      wholeWords: operation.wholeWords === true,
      count: countOccurrences(
        snapshot.text,
        operation.searchText,
        operation.matchCase === true,
        operation.wholeWords === true,
      ),
    };
  }

  async function searchText(operation) {
    const snapshot = await getDocumentText();
    const maxResults = Math.min(positiveInt(operation.maxResults, 10), 50);
    const contextChars = Math.min(positiveInt(operation.contextChars, 80), 500);
    const results = findOccurrences(
      snapshot.text,
      operation.query,
      operation.matchCase === true,
      operation.wholeWords === true,
      maxResults,
      contextChars,
    );
    return {
      query: operation.query,
      total: countOccurrences(
        snapshot.text,
        operation.query,
        operation.matchCase === true,
        operation.wholeWords === true,
      ),
      returned: results.length,
      results: results,
    };
  }

  function getDocumentText(maxChars) {
    return executeMethod("GetFileHTML", null).then(function (html) {
      const text = htmlToText(String(html || ""));
      const limit = Number(maxChars);
      const limited = Number.isFinite(limit) && limit > 0 ? text.slice(0, limit) : text;
      return { text: limited, length: text.length, truncated: limited.length < text.length };
    });
  }

  function enableTrackChanges() {
    return callCommand(function () {
      const document = Api.GetDocument();
      if (document && document.SetTrackRevisions) document.SetTrackRevisions(true);
      return { ok: true };
    });
  }

  function callCommand(command) {
    return new Promise(function (resolve, reject) {
      try {
        window.Asc.plugin.callCommand(command, false, true, function (result) {
          if (result && result.ok === false)
            reject(new Error(result.error || "ONLYOFFICE command failed"));
          else resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function executeMethod(name, args) {
    return new Promise(function (resolve, reject) {
      try {
        window.Asc.plugin.executeMethod(name, args == null ? null : args, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  function post(payload) {
    bridgeHost.postMessage(
      Object.assign(
        { protocol: protocol, pluginGuid: pluginGuid, pluginInstanceId: pluginInstanceId },
        payload,
      ),
      window.location.origin,
    );
  }

  function createPluginInstanceId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, function (byte) {
        return byte.toString(16).padStart(2, "0");
      }).join("");
    }
    return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  function htmlToText(html) {
    const container = document.createElement("div");
    container.innerHTML = html;
    return String(container.innerText || container.textContent || "")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  function countOccurrences(text, query, matchCase, wholeWords) {
    return findOccurrences(text, query, matchCase, wholeWords, Number.MAX_SAFE_INTEGER, 0).length;
  }

  function findOccurrences(text, query, matchCase, wholeWords, maxResults, contextChars) {
    if (!query) return [];
    const source = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
    const results = [];
    let offset = 0;
    while (offset <= source.length - needle.length && results.length < maxResults) {
      const index = source.indexOf(needle, offset);
      if (index < 0) break;
      const before = index === 0 ? "" : source[index - 1];
      const after = index + needle.length >= source.length ? "" : source[index + needle.length];
      const boundary =
        !wholeWords || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after));
      if (boundary) {
        results.push({
          index: index,
          context: text.slice(
            Math.max(0, index - contextChars),
            Math.min(text.length, index + needle.length + contextChars),
          ),
        });
      }
      offset = index + Math.max(needle.length, 1);
    }
    return results;
  }
})();
