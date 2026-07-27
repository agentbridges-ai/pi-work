#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ONLYOFFICE_BROWSER_DIR="${PIWORK_ONLYOFFICE_BROWSER_DIR:-$ROOT_DIR/onlyoffice-browser}"
FONT_ASSETS_DIR="${PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR:-$ONLYOFFICE_BROWSER_DIR/.onlyoffice-font-assets}"
FONT_SET="${PIWORK_ONLYOFFICE_BROWSER_FONT_SET:-zh-core}"
SOURCE_CACHE_CONFIGURED="${PIWORK_ONLYOFFICE_FONT_SOURCE_CACHE_DIR:-}"
if [[ -n "$SOURCE_CACHE_CONFIGURED" ]]; then
  FONT_SOURCE_DIR="$SOURCE_CACHE_CONFIGURED"
  CLEAN_FONT_SOURCE=0
else
  FONT_SOURCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/piwork-onlyoffice-font-source.XXXXXX")"
  CLEAN_FONT_SOURCE=1
fi

log() {
  printf '[onlyoffice-fonts] %s\n' "$*"
}

copy_font() {
  local source="$1"
  [[ -f "$source" ]] || return 0

  local base target stem ext counter
  base="$(basename "$source")"
  stem="${base%.*}"
  ext="${base##*.}"
  if [[ "$stem" == "$base" ]]; then
    ext=""
  else
    ext=".$ext"
  fi

  target="$FONT_SOURCE_DIR/$base"
  counter=1
  while [[ -e "$target" ]]; do
    if cmp -s "$source" "$target"; then
      return 0
    fi
    target="$FONT_SOURCE_DIR/${stem}-${counter}${ext}"
    counter=$((counter + 1))
  done

  cp "$source" "$target"
}

copy_matches() {
  local root="$1"
  shift
  [[ -d "$root" ]] || return 0

  local find_args=()
  local pattern
  for pattern in "$@"; do
    if [[ "${#find_args[@]}" -gt 0 ]]; then
      find_args+=(-o)
    fi
    find_args+=(-iname "$pattern")
  done

  while IFS= read -r -d '' font_file; do
    copy_font "$font_file"
  done < <(find "$root" -type f \( "${find_args[@]}" \) -print0 2>/dev/null || true)
}

write_manifest() {
  local manifest="$FONT_SOURCE_DIR/manifest.txt"
  {
    printf 'Piwork local OnlyOffice font source cache\n'
    printf 'Generated at: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'Source directory: %s\n' "$FONT_SOURCE_DIR"
    printf 'Generated assets: %s\n\n' "$FONT_ASSETS_DIR"
    printf 'Requested families:\n'
    printf '%s\n' '- Aptos'
    printf '%s\n' '- Calibri'
    printf '%s\n' '- Arial'
    printf '%s\n' '- Times New Roman'
    printf '%s\n' '- Cambria'
    printf '%s\n' '- Microsoft YaHei / 微软雅黑'
    printf '%s\n' '- SimSun / 宋体'
    printf '%s\n' '- DengXian / 等线'
    printf '%s\n' '- SimHei / 黑体'
    printf '%s\n\n' '- KaiTi / 楷体'
    printf 'Collected files:\n'
    find "$FONT_SOURCE_DIR" -maxdepth 1 -type f ! -name 'manifest.txt' -print | sort | sed "s#^#- #"
  } >"$manifest"
}

filter_visible_fonts() {
  local all_fonts="$FONT_ASSETS_DIR/sdkjs/common/AllFonts.js"
  [[ -f "$all_fonts" ]] || return 0

  local source_map="$FONT_ASSETS_DIR/onlyoffice-browser-font-source-map.json"

  node - "$all_fonts" "$source_map" <<'NODE'
const fs = require("node:fs");

const allFontsPath = process.argv[2];
const sourceMapPath = process.argv[3];
const visibleNames = [
  "Aptos",
  "Calibri",
  "Arial",
  "Times New Roman",
  "Cambria",
  "Microsoft YaHei",
  "SimSun",
  "DengXian",
  "SimHei",
  "KaiTi",
];

const source = fs.readFileSync(allFontsPath, "utf8");
const infosMatch = source.match(/window\["__fonts_infos"\]\s*=\s*(\[[\s\S]*?\]);/);
if (!infosMatch) {
  throw new Error("Unable to locate __fonts_infos in generated AllFonts.js");
}

const fontInfos = JSON.parse(infosMatch[1]);
const availableNames = new Set(fontInfos.map((info) => info?.[0]).filter(Boolean));
const filteredVisibleNames = visibleNames.filter((name) => availableNames.has(name));
if (filteredVisibleNames.length !== visibleNames.length) {
  const missing = visibleNames.filter((name) => !availableNames.has(name));
  throw new Error(`Generated OnlyOffice fonts are missing visible fonts: ${missing.join(", ")}`);
}

const replacement = `window["__fonts_visible_names"] = ${JSON.stringify(filteredVisibleNames, null, 0)};`;
const pattern = /window\["__fonts_visible_names"\]\s*=\s*\[[\s\S]*?\];/;
const nextSource = pattern.test(source)
  ? source.replace(pattern, replacement)
  : `${replacement}\n${source}`;
fs.writeFileSync(allFontsPath, nextSource);

if (sourceMapPath && fs.existsSync(sourceMapPath)) {
  const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
  sourceMap.visibleFamilies = filteredVisibleNames;
  fs.writeFileSync(sourceMapPath, `${JSON.stringify(sourceMap, null, 2)}\n`);
}
NODE
}

mkdir -p "$FONT_SOURCE_DIR" "$FONT_ASSETS_DIR"
cleanup() {
  if [[ "$CLEAN_FONT_SOURCE" == "1" ]]; then
    rm -rf "$FONT_SOURCE_DIR"
  fi
}
trap cleanup EXIT

if [[ "${PIWORK_ONLYOFFICE_REFRESH_FONT_SOURCE:-0}" == "1" ]]; then
  log "refreshing font source cache: $FONT_SOURCE_DIR"
  find "$FONT_SOURCE_DIR" -maxdepth 1 -type f -delete
fi

font_roots=(
  "/Applications/Microsoft Word.app/Contents/Resources/DFonts"
  "/Applications/Microsoft Excel.app/Contents/Resources/DFonts"
  "/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts"
  "$HOME/Library/Fonts"
  "/Library/Fonts"
  "/System/Library/Fonts"
  "/System/Library/Fonts/Supplemental"
  "/System/Library/AssetsV2/com_apple_MobileAsset_Font8"
)

for root in "${font_roots[@]}"; do
  copy_matches "$root" \
    '*Aptos*' \
    '*Calibri*' \
    '*Arial*' \
    '*Times New Roman*' \
    '*Cambria*' \
    '*Consola*' \
    '*Microsoft YaHei*' \
    '*msyh*' \
    '*SimSun*' \
    '*SimSong*' \
    '*Simsun*' \
    '*simsunb*' \
    '*Deng*' \
    '*SimHei*' \
    '*STXIHEI*' \
    '*Hei.ttf' \
    '*KaiTi*' \
    '*Kaiti*' \
    '*Kai.ttf' \
    '*FangSong*' \
    '*Fangsong*' \
    '*Songti*' \
    '*STHeiti*' \
    '*Symbol*' \
    '*Wingdings*' \
    '*Webdings*' \
    '*Marlett*' \
    '*MTEXTRA*' \
    '*MonotypeSorts*' \
    '*MS Reference Specialty*' \
    '*msgothic*' \
    '*MS Gothic*' \
    '*seguisym*'
done

if ! find "$FONT_SOURCE_DIR" -maxdepth 1 -type f \( -iname '*.ttf' -o -iname '*.tte' -o -iname '*.otf' -o -iname '*.otc' -o -iname '*.ttc' -o -iname '*.woff' -o -iname '*.woff2' \) -print -quit | grep -q .; then
  printf '[onlyoffice-fonts] No supported font files were collected into %s\n' "$FONT_SOURCE_DIR" >&2
  exit 1
fi

write_manifest

log "collected $(find "$FONT_SOURCE_DIR" -maxdepth 1 -type f ! -name 'manifest.txt' | wc -l | tr -d ' ') font file(s)"
log "generating OnlyOffice assets into $FONT_ASSETS_DIR"
rm -rf "$FONT_ASSETS_DIR"
mkdir -p "$FONT_ASSETS_DIR"
PIWORK_ONLYOFFICE_BROWSER_FONT_SOURCE_DIR="$FONT_SOURCE_DIR" \
PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR="$FONT_ASSETS_DIR" \
PIWORK_ONLYOFFICE_BROWSER_FONT_SET="$FONT_SET" \
PIWORK_ONLYOFFICE_SKIP_FONT_POLICY=1 \
  "$ROOT_DIR/scripts/ensure-onlyoffice-browser.sh"
filter_visible_fonts
node "$ONLYOFFICE_BROWSER_DIR/scripts/verify-onlyoffice-font-assets.mjs" --input "$FONT_ASSETS_DIR"
PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR="$FONT_ASSETS_DIR" \
  "$ROOT_DIR/scripts/ensure-onlyoffice-browser.sh"

log "ready"
