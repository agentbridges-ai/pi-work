#!/usr/bin/env node

import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officeDir = join(root, "demo-user-space/office");
const x2tSourceDir = join(root, "onlyoffice-browser/public/wasm/x2t");
const runtimeDir = mkdtempSync(join(tmpdir(), "piwork-x2t-fixtures-"));
const x2tPath = join(runtimeDir, "x2t.cjs");
copyFileSync(join(x2tSourceDir, "x2t.js"), x2tPath);
copyFileSync(join(x2tSourceDir, "x2t.wasm"), join(runtimeDir, "x2t.wasm"));
process.on("exit", () => rmSync(runtimeDir, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const x2t = require(x2tPath);

const conversions = [
  {
    source: join(runtimeDir, "Example Title.rtf-source.docx"),
    target: join(officeDir, "Example Title.rtf"),
    sourceFormat: 65,
    targetFormat: 68,
  },
  {
    source: join(officeDir, "Example Title.pptx"),
    target: join(officeDir, "Example Title.odp"),
    sourceFormat: 129,
    targetFormat: 131,
  },
];

function prepareRtfSource() {
  const result = spawnSync(
    process.env.PYTHON || "python3",
    [
      join(root, "scripts/prepare-office-rtf-source.py"),
      join(officeDir, "Example Title.docx"),
      conversions[0].source,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to prepare the static-chart RTF source:\n${result.stderr || result.stdout}`,
    );
  }
}

function removeTree(path) {
  if (!x2t.FS.analyzePath(path).exists) return;
  if (x2t.FS.isDir(x2t.FS.stat(path).mode)) {
    for (const entry of x2t.FS.readdir(path)) {
      if (entry !== "." && entry !== "..") removeTree(`${path}/${entry}`);
    }
    if (path !== "/") x2t.FS.rmdir(path);
    return;
  }
  x2t.FS.unlink(path);
}

function resetWorkingDirectory() {
  removeTree("/working");
  x2t.FS.mkdir("/working");
  x2t.FS.mkdir("/working/media");
}

function convert({ source, target, sourceFormat, targetFormat }) {
  resetWorkingDirectory();
  const inputName = basename(source);
  const outputName = basename(target);
  const inputPath = `/working/${inputName}`;
  const outputPath = `/working/${outputName}`;
  x2t.FS.writeFile(inputPath, readFileSync(source));
  x2t.FS.writeFile(
    "/working/params.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <m_sFileFrom>${inputPath}</m_sFileFrom>
  <m_sFileTo>${outputPath}</m_sFileTo>
  <m_nFormatFrom>${sourceFormat}</m_nFormatFrom>
  <m_nFormatTo>${targetFormat}</m_nFormatTo>
  <m_bIsNoBase64>false</m_bIsNoBase64>
</TaskQueueDataConvert>`,
  );
  const result = x2t.ccall("main1", "number", ["string"], ["/working/params.xml"]);
  if (result !== 0) {
    throw new Error(
      `x2t conversion failed (${result}): ${basename(source)} -> ${basename(target)}`,
    );
  }
  const temporary = `${target}.tmp${extname(target)}`;
  writeFileSync(temporary, x2t.FS.readFile(outputPath));
  renameSync(temporary, target);
  process.stdout.write(`${source} -> ${target}\n`);
}

function run() {
  prepareRtfSource();
  for (const conversion of conversions) convert(conversion);
}

if (x2t.calledRun) {
  run();
} else {
  x2t.onRuntimeInitialized = run;
}
