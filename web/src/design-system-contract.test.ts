import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  componentTokens,
  primitiveTokens,
  semanticTokens,
} from "../../packages/design-tokens/src/index.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(webRoot, "..");

function collectFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => collectFiles(join(path, entry)));
}

function productionSourceFiles(root: string): string[] {
  return collectFiles(root).filter(
    (path) =>
      /\.(?:css|ts|tsx)$/.test(path) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(path) &&
      !path.includes("/node_modules/") &&
      !path.includes("/.next/") &&
      !path.includes("/out/"),
  );
}

describe("Piwork design system workspace contract", () => {
  it("exposes tokens, components, and patterns as workspace packages", () => {
    const rootPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    const landingPackage = JSON.parse(
      readFileSync(resolve(repositoryRoot, "landing-page/package.json"), "utf8"),
    );
    expect(rootPackage.workspaces).toContain("packages/*");
    expect(rootPackage.workspaces).toContain("landing-page");

    for (const [path, name] of [
      ["packages/design-tokens/package.json", "@piwork/design-tokens"],
      ["packages/ui/package.json", "@piwork/ui"],
      ["packages/ui-patterns/package.json", "@piwork/ui-patterns"],
    ]) {
      const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
      expect(manifest.name).toBe(name);
      expect(manifest.private).toBe(true);
    }

    for (const name of ["@piwork/design-tokens", "@piwork/ui", "@piwork/ui-patterns"]) {
      expect(landingPackage.dependencies[name], name).toBe("workspace:*");
    }
  });

  it("installs the landing workspace and its local packages before deployment", () => {
    const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/deploy.yml"), "utf8");
    expect(workflow).toContain(
      "bun install --filter piwork-landing-page --backend copyfile --linker hoisted",
    );
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("if: github.event_name != 'pull_request'");
  });

  it("keeps the public token layers semantic and CSS-variable based", () => {
    expect(primitiveTokens.color.light.page).toMatch(/^oklch\(/);
    expect(semanticTokens.color.background).toBe("var(--background)");
    expect(semanticTokens.color.action).toBe("var(--primary)");
    expect(componentTokens.button.radius).toBe("var(--piwork-control-radius)");
    expect(componentTokens.composer.background).toBe("var(--piwork-composer-background)");
  });

  it("makes both product applications consume the shared theme", () => {
    for (const path of ["web/src/index.css", "landing-page/styles/globals.css"]) {
      expect(readFileSync(resolve(repositoryRoot, path), "utf8"), path).toContain(
        '@import "@piwork/design-tokens/theme.css";',
      );
    }
  });

  it("keeps HeroUI behind the shared component package", () => {
    const applicationFiles = [
      ...productionSourceFiles(resolve(repositoryRoot, "web/src")),
      ...productionSourceFiles(resolve(repositoryRoot, "landing-page/app")),
      ...productionSourceFiles(resolve(repositoryRoot, "landing-page/components")),
    ];
    const violations = applicationFiles
      .filter((path) => /["']@heroui\/react["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(repositoryRoot, path));
    expect(violations).toEqual([]);
  });

  it("keeps the former Web UI folder as a narrow compatibility boundary", () => {
    expect(readdirSync(resolve(webRoot, "src/components/ui")).sort()).toEqual([
      "heroui.ts",
      "index.ts",
      "ui.test.tsx",
    ]);
  });

  it("prevents landing-page regressions to raw colors, elevation, and native buttons", () => {
    const files = [
      ...productionSourceFiles(resolve(repositoryRoot, "landing-page/app")),
      ...productionSourceFiles(resolve(repositoryRoot, "landing-page/components")),
    ];
    const violations: string[] = [];
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      const name = relative(repositoryRoot, path);
      if (/#[0-9a-fA-F]{3,8}/.test(source)) violations.push(`${name}: raw color`);
      if (/\bbackdrop-blur(?:-[a-z0-9]+)?\b/.test(source))
        violations.push(`${name}: backdrop blur`);
      if (/(?:^|[\s"'`])shadow(?:-[a-z0-9[\]-]+)?(?=$|[\s"'`])/m.test(source))
        violations.push(`${name}: elevation shadow`);
      if (/<button\b/.test(source)) violations.push(`${name}: native button`);
      if (/\btext-(?:muted|accent)(?![-\w])/.test(source))
        violations.push(`${name}: surface token used as text`);
    }
    expect(violations).toEqual([]);
  });
});
