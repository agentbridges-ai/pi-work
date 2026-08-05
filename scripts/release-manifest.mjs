import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultManifestPath = resolve(rootDir, "release/piwork-compose-release-manifest.json");
const imageNames = ["caddy", "web", "runtime", "postgres"];

function fail(message) {
  console.error(`[piwork-release] ${message}`);
  process.exit(1);
}

function readManifest(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("release manifest must contain a JSON object");
  }
  if (value.format !== "piwork-compose-release-v1") {
    fail("unsupported Piwork Compose release manifest format");
  }
  if (
    typeof value.releaseId !== "string" ||
    !value.releaseId ||
    value.releaseId.includes("REPLACE")
  ) {
    fail("releaseId must be populated");
  }
  if (
    typeof value.createdAt !== "string" ||
    !value.createdAt ||
    value.createdAt.includes("REPLACE")
  ) {
    fail("createdAt must be populated");
  }
  if (!value.images || typeof value.images !== "object" || Array.isArray(value.images)) {
    fail("images must be an object");
  }
  for (const name of imageNames) {
    const image = value.images[name];
    if (
      typeof image !== "string" ||
      !/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(image) ||
      image.includes("REPLACE")
    ) {
      fail(`${name} image must be an immutable repository@sha256:digest reference`);
    }
  }
  return value;
}

const command = process.argv[2] || "validate";
const manifestPath = resolve(process.argv[3] || defaultManifestPath);
const manifest = readManifest(manifestPath);

if (command === "validate") {
  console.log(
    JSON.stringify({
      format: manifest.format,
      releaseId: manifest.releaseId,
      createdAt: manifest.createdAt,
      images: imageNames,
      manifest: manifestPath,
    }),
  );
} else if (command === "get") {
  const name = process.argv[4];
  if (!imageNames.includes(name)) fail(`unknown release image: ${name || "(missing)"}`);
  console.log(manifest.images[name]);
} else {
  fail(`unknown command: ${command}`);
}
