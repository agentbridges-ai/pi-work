import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  transpilePackages: ["@piwork/design-tokens", "@piwork/ui", "@piwork/ui-patterns"],
  turbopack: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolveAlias: {
      "@piwork/design-tokens": "./packages/design-tokens/src/index.ts",
      "@piwork/design-tokens/theme.css": "./packages/design-tokens/src/theme.css",
      "@piwork/ui": "./packages/ui/src/index.ts",
      "@piwork/ui-patterns": "./packages/ui-patterns/src/index.ts",
    },
  },
};

export default nextConfig;
