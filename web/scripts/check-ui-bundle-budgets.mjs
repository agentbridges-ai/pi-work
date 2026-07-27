import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(webRoot, "dist");
const manifestPath = resolve(distRoot, ".vite/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function matchingEntries(matcher) {
  return Object.entries(manifest)
    .filter(([key, entry]) =>
      [key, entry.src || "", entry.name || ""].some((value) => matcher.test(value)),
    )
    .map(([key]) => key);
}

function findEntry(label, matcher) {
  const keys = matchingEntries(matcher);
  if (keys.length !== 1) {
    throw new Error(
      `${label}: expected one manifest entry, found ${keys.length}: ${keys.join(", ") || "none"}`,
    );
  }
  return keys[0];
}

function findOptionalEntry(label, matcher) {
  const keys = matchingEntries(matcher);
  if (keys.length > 1) {
    throw new Error(
      `${label}: expected at most one manifest entry, found ${keys.length}: ${keys.join(", ")}`,
    );
  }
  return keys[0] || null;
}

function collectStaticKeys(entryKeys) {
  const collected = new Set();
  const queue = [...entryKeys];
  while (queue.length > 0) {
    const key = queue.pop();
    if (!key || collected.has(key)) continue;
    const entry = manifest[key];
    if (!entry) throw new Error(`Manifest entry not found: ${key}`);
    collected.add(key);
    queue.push(...(entry.imports || []));
  }
  return collected;
}

function filesForKeys(keys, extension) {
  const files = new Set();
  for (const key of keys) {
    const entry = manifest[key];
    if (entry.file?.endsWith(extension)) files.add(entry.file);
    for (const file of entry.css || []) {
      if (file.endsWith(extension)) files.add(file);
    }
  }
  return files;
}

async function gzipBytes(files) {
  let total = 0;
  for (const file of files) {
    total += gzipSync(await readFile(resolve(distRoot, file)), { level: 9 }).byteLength;
  }
  return total;
}

function union(...sets) {
  return new Set(sets.flatMap((set) => [...set]));
}

function directDynamicKeys(keys, matcher = /./) {
  return [...new Set([...keys].flatMap((key) => manifest[key].dynamicImports || []))].filter(
    (key) => matcher.test(key),
  );
}

const indexEntry = findEntry("login entry", /^index\.html$/);
const wsRuntimeEntry = findEntry("WebSocket runtime", /^ws$/);
const userSpaceRuntimeEntry = findEntry("User Space runtime", /^user-space$/);
const userSpaceBashEntry = findEntry(
  "User Space Bash runtime",
  /node_modules\/just-bash\/dist\/bundle\/browser\.(?:js|mjs)$/,
);
const userSpaceEntry = findEntry(
  "User Space",
  /(?:src\/components\/)?UserSpaceExplorer(?:\.(?:tsx|js))?$/,
);
// Rollup may fold ChatView into the entry when its shared shell dependencies dominate.
const explicitChatEntry = findOptionalEntry(
  "workbench shell",
  /(?:src\/components\/)?ChatView(?:\.(?:tsx|js))?$/,
);
const chatEntry =
  explicitChatEntry ||
  (manifest[indexEntry].dynamicImports || []).find((key) =>
    (manifest[key]?.dynamicImports || []).includes(userSpaceEntry),
  ) ||
  null;
const textEditorEntry = findEntry(
  "text editor",
  /(?:src\/components\/user-space-preview\/)?TextEditorSurface(?:\.(?:tsx|js))?$/,
);
const markdownEditorEntry = findEntry(
  "Markdown editor",
  /(?:src\/components\/user-space-preview\/)?MarkdownEditorSurface(?:\.(?:tsx|js))?$/,
);
const officeEntry = findEntry("Office preview", /src\/office-host-adapter\.(?:ts|js)$/);
const imageEntry = findEntry("image editor", /src\/components\/ImageEditorSurface\.(?:tsx|js)$/);

const loginKeys = collectStaticKeys([indexEntry]);
const workbenchKeys = chatEntry ? union(loginKeys, collectStaticKeys([chatEntry])) : loginKeys;
const userSpaceKeys = collectStaticKeys([userSpaceEntry]);
const userSpaceBashKeys = collectStaticKeys([userSpaceBashEntry]);
const textEditorKeys = collectStaticKeys([textEditorEntry]);
const markdownBaseKeys = collectStaticKeys([markdownEditorEntry]);
const markdownLanguageKeys = directDynamicKeys(
  markdownBaseKeys,
  /@codemirror\/lang-markdown/,
).flatMap((key) => [...collectStaticKeys([key])]);
const markdownCrepeKeys = directDynamicKeys(markdownBaseKeys, /@milkdown\/crepe/).flatMap((key) => [
  ...collectStaticKeys([key]),
]);
const markdownKeys = union(
  markdownBaseKeys,
  new Set([...markdownLanguageKeys, ...markdownCrepeKeys]),
);
const officeKeys = collectStaticKeys([officeEntry]);
const imageKeys = collectStaticKeys([imageEntry]);
const incrementalWorkbenchFeatureKeys = (keys) =>
  new Set([...keys].filter((key) => !workbenchKeys.has(key)));
const incrementalUserSpaceFeatureKeys = (keys) =>
  new Set([...keys].filter((key) => !workbenchKeys.has(key) && !userSpaceKeys.has(key)));

for (const runtimeEntry of [wsRuntimeEntry, userSpaceRuntimeEntry]) {
  if (loginKeys.has(runtimeEntry)) {
    throw new Error(`${runtimeEntry} is statically reachable from the login entry`);
  }
}

if (
  loginKeys.has(userSpaceBashEntry) ||
  workbenchKeys.has(userSpaceBashEntry) ||
  userSpaceKeys.has(userSpaceBashEntry)
) {
  throw new Error(`${userSpaceBashEntry} must remain on-demand behind the User Space runtime`);
}
if (!directDynamicKeys(userSpaceKeys).includes(userSpaceBashEntry)) {
  throw new Error(`${userSpaceBashEntry} is no longer dynamically owned by User Space`);
}

for (const forbidden of [officeEntry, userSpaceEntry]) {
  if (loginKeys.has(forbidden) || workbenchKeys.has(forbidden)) {
    throw new Error(`${forbidden} is statically reachable before its feature is opened`);
  }
}

const budgets = [
  ["登录入口", filesForKeys(loginKeys, ".js"), 140],
  ["工作台壳层", filesForKeys(workbenchKeys, ".js"), 450],
  ["User Space 初始", filesForKeys(incrementalWorkbenchFeatureKeys(userSpaceKeys), ".js"), 150],
  [
    "User Space Bash（按需）",
    filesForKeys(
      new Set(
        [...userSpaceBashKeys].filter((key) => !workbenchKeys.has(key) && !userSpaceKeys.has(key)),
      ),
      ".js",
    ),
    350,
  ],
  ["文本编辑器", filesForKeys(incrementalUserSpaceFeatureKeys(textEditorKeys), ".js"), 250],
  // Crepe intentionally restores the complete lazy-loaded WYSIWYG surface,
  // including GFM, code blocks, math, and language metadata.
  ["Markdown 预览与编辑", filesForKeys(incrementalUserSpaceFeatureKeys(markdownKeys), ".js"), 500],
  ["Office 预览", filesForKeys(incrementalUserSpaceFeatureKeys(officeKeys), ".js"), 350],
  ["图片编辑", filesForKeys(incrementalUserSpaceFeatureKeys(imageKeys), ".js"), 110],
  ["全局 CSS", filesForKeys(loginKeys, ".css"), 50],
];

let failed = false;
console.log("\nUI bundle budgets (gzip)");
for (const [label, files, limitKiB] of budgets) {
  const bytes = await gzipBytes(files);
  const kib = bytes / 1024;
  const passed = kib <= limitKiB;
  failed ||= !passed;
  console.log(`${passed ? "PASS" : "FAIL"} ${label}: ${kib.toFixed(2)} KiB / ${limitKiB} KiB`);
}

if (failed) process.exitCode = 1;
