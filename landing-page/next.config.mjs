import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  transpilePackages: ["@piwork/design-tokens", "@piwork/ui", "@piwork/ui-patterns"],
  turbopack: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    resolveAlias: {
      "@piwork/design-tokens": "./node_modules/@piwork/design-tokens/src/index.ts",
      "@piwork/design-tokens/theme.css": "./node_modules/@piwork/design-tokens/src/theme.css",
      "@piwork/ui": "./node_modules/@piwork/ui/src/index.ts",
      "@piwork/ui-patterns": "./node_modules/@piwork/ui-patterns/src/index.ts",
    },
  },
};

export default nextConfig;
