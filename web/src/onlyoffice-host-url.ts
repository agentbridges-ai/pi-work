import type { OfficeHostUrlContext } from "@agentbridges-ai/onlyoffice-browser";

const ONLYOFFICE_SHARED_ASSET_ORIGIN = "https://onlyoffice.getpi.work/";

export function resolvePiworkOnlyOfficeHostUrl(
  context: OfficeHostUrlContext,
  releaseId?: string | null,
): string {
  const sessionLabel = officeHostSessionLabel(context.sessionId);
  const path = releaseId
    ? `/r/${encodeURIComponent(releaseId)}/office-host.html`
    : "/office-host.html";
  return `https://${sessionLabel}.getpi.work${path}`;
}

export function resolvePiworkOnlyOfficeAssetBaseUrl(): string {
  return ONLYOFFICE_SHARED_ASSET_ORIGIN;
}

export function resolveOnlyOfficeAssetBaseUrl(hostUrl: URL, fallbackOrigin: string): string {
  if (
    hostUrl.hostname === "onlyoffice.getpi.work" ||
    /^office-editor-[a-z0-9-]+\.getpi\.work$/.test(hostUrl.hostname)
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
    .replace(/^-|-$/g, "");
  const suffix = normalized || "session";
  const sessionLabel = suffix.startsWith("office-editor-") ? suffix : `office-editor-${suffix}`;
  return sessionLabel.slice(0, 63);
}
