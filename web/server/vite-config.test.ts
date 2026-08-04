import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { Plugin, PluginOption, ProxyOptions, UserConfig } from "vite";
import config from "../vite.config";

function flattenPlugins(plugins: PluginOption[] | undefined): unknown[] {
  const flattened: unknown[] = [];
  const visit = (plugin: PluginOption): void => {
    if (Array.isArray(plugin)) {
      plugin.forEach(visit);
      return;
    }
    flattened.push(plugin);
  };
  plugins?.forEach(visit);
  return flattened;
}

function isPlugin(value: unknown): value is Plugin {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "name" in value;
}

function pluginNames(plugins: PluginOption[] | undefined): string[] {
  return flattenPlugins(plugins)
    .filter(isPlugin)
    .map((plugin) => plugin.name);
}

function proxyOptions(value: string | ProxyOptions | undefined): ProxyOptions {
  if (!value || typeof value === "string") {
    throw new Error("Expected configured Vite proxy options");
  }
  return value;
}

describe("Vite runtime configuration", () => {
  const viteConfig = config as UserConfig;

  it("uses the installed OnlyOffice client package without local runtime plugins", () => {
    expect(viteConfig.publicDir).toBe(resolve(process.cwd(), "public"));
    expect(viteConfig.esbuild).toMatchObject({ jsx: "automatic" });
    expect(viteConfig.optimizeDeps?.exclude).toContain("@agentbridges-ai/onlyoffice-browser");
    expect(pluginNames(viteConfig.plugins)).toContain(
      "piwork-onlyoffice-browser-dev-module-cache-guard",
    );
    expect(pluginNames(viteConfig.plugins)).not.toEqual(
      expect.arrayContaining([
        "piwork-onlyoffice-browser-development-identity",
        "piwork-onlyoffice-browser-fonts",
        "piwork-onlyoffice-browser-runtime",
      ]),
    );
  });

  it("assembles HTTP and WebSocket proxies with origin-preserving WS options", () => {
    const proxy = viteConfig.server?.proxy;
    const api = proxyOptions(proxy?.["/api"]);
    const browser = proxyOptions(proxy?.["/ws/browser"]);

    expect(viteConfig.server).toMatchObject({
      host: "127.0.0.1",
      strictPort: true,
    });
    expect(Object.keys(proxy ?? {})).toEqual(["/api", "/ws/browser"]);
    expect(api).toMatchObject({ changeOrigin: true });
    expect(api).not.toHaveProperty("ws");
    expect(api).not.toHaveProperty("rewriteWsOrigin");
    expect(browser).toMatchObject({
      target: api.target,
      changeOrigin: true,
      ws: true,
      rewriteWsOrigin: false,
    });
    expect(api.configure).toEqual(expect.any(Function));
    expect(browser.configure).toEqual(expect.any(Function));
  });
});
