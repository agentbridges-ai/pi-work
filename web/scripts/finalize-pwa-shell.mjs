import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const token = "__PIWORK_SHELL_REVISION__";

export async function finalizePwaShell(distRoot = resolve(import.meta.dirname, "../dist")) {
  const workerPath = resolve(distRoot, "piwork-sw.js");
  const manifestPath = resolve(distRoot, ".vite/manifest.json");
  const indexPath = resolve(distRoot, "index.html");
  const [worker, manifest, index] = await Promise.all([
    readFile(workerPath, "utf8"),
    readFile(manifestPath),
    readFile(indexPath),
  ]);

  if (!worker.includes(token)) {
    throw new Error(`Piwork Service Worker is missing the ${token} build token`);
  }

  const revision = createHash("sha256").update(manifest).update(index).digest("hex").slice(0, 16);
  await writeFile(workerPath, worker.replaceAll(token, revision));
  console.log(`Piwork shell revision: ${revision}`);
  return revision;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await finalizePwaShell();
}
