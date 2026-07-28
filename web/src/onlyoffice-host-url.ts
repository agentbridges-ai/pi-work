import type { OfficeHostUrlContext } from "@agentbridges-ai/onlyoffice-browser";

const ONLYOFFICE_SHARED_ASSET_ORIGIN = "https://onlyoffice.getpi.work/";

export function resolvePiworkOnlyOfficeHostUrl(context: OfficeHostUrlContext): string {
  const sessionLabel = officeHostSessionLabel(context.sessionId);
  return `https://${sessionLabel}.onlyoffice.getpi.work/office-host.html`;
}

export function resolvePiworkOnlyOfficeAssetBaseUrl(): string {
  return ONLYOFFICE_SHARED_ASSET_ORIGIN;
}

export function resolveOnlyOfficeAssetBaseUrl(hostUrl: URL, fallbackOrigin: string): string {
  if (
    hostUrl.hostname === "onlyoffice.getpi.work" ||
    /^[a-z0-9-]+\.onlyoffice\.getpi\.work$/.test(hostUrl.hostname)
  ) {
    return ONLYOFFICE_SHARED_ASSET_ORIGIN;
  }
  return fallbackOrigin;
}

function officeHostSessionLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/^office-editor-/, "");
  return normalized.slice(0, 48) || "office";
}
