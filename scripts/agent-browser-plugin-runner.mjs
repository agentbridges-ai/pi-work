#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const protocol = "agent-browser.plugin.v1";

try {
  const pluginPath = process.argv[2];
  if (!pluginPath) throw new Error("Chrome extension provider module path is required");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const module = await import(pathToFileURL(pluginPath).href);
  if (typeof module.handlePluginRequest !== "function") {
    throw new Error("Chrome extension provider does not export handlePluginRequest");
  }
  process.stdout.write(JSON.stringify(await module.handlePluginRequest(request)));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      protocol,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
