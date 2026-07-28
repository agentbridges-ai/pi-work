import type { OfficeHostUrlContext } from "@agentbridges-ai/onlyoffice-browser";
import { clientEnvironment } from "./environment.js";
import { uiCopy } from "./ui-copy.js";

const ONLYOFFICE_HOST_URL_TEMPLATE = clientEnvironment.onlyOfficeHostUrlTemplate;

export function resolvePiworkOnlyOfficeHostUrl(context: OfficeHostUrlContext): string {
  const currentUrl = new URL(window.location.href);
  const sessionLabel = officeHostSessionLabel(context.sessionId);
  if (ONLYOFFICE_HOST_URL_TEMPLATE) {
    return ONLYOFFICE_HOST_URL_TEMPLATE.replaceAll("{sessionId}", sessionLabel)
      .replaceAll("{rawSessionId}", encodeURIComponent(context.sessionId))
      .replaceAll("{hostname}", currentUrl.hostname)
      .replaceAll("{origin}", currentUrl.origin)
      .replaceAll("{protocol}", currentUrl.protocol.replace(/:$/, ""))
      .replaceAll("{port}", currentUrl.port);
  }

  return resolveDefaultPiworkOnlyOfficeHostUrl(currentUrl, sessionLabel);
}

export function resolvePiworkOnlyOfficeAssetBaseUrl(): string {
  const hostUrl = new URL(
    resolvePiworkOnlyOfficeHostUrl({
      sessionId: "resource-manager",
      fileName: "resource-manager.docx",
      fileType: "docx",
      mode: "preview",
    }),
  );
  return resolveOnlyOfficeAssetBaseUrl(hostUrl, window.location.origin);
}

export function resolveOnlyOfficeAssetBaseUrl(hostUrl: URL, fallbackOrigin: string): string {
  if (hostUrl.hostname.endsWith(".office.localhost")) {
    hostUrl.hostname = "assets.office.localhost";
    hostUrl.pathname = "/";
    hostUrl.search = "";
    hostUrl.hash = "";
    return hostUrl.href;
  }
  if (
    hostUrl.hostname === "onlyoffice.getpi.work" ||
    /^office-[a-z0-9-]+\.getpi\.work$/.test(hostUrl.hostname)
  ) {
    return "https://onlyoffice.getpi.work/";
  }
  return fallbackOrigin;
}

export function resolveDefaultPiworkOnlyOfficeHostUrl(
  currentUrl: URL,
  sessionLabel = "office",
): string {
  const hostUrl = new URL("/office-host.html", currentUrl);
  if (isLocalOnlyOfficeParentHost(currentUrl.hostname)) {
    hostUrl.hostname = `host-${officeHostSessionLabel(sessionLabel)}.office.localhost`;
    return hostUrl.href;
  }
  if (isIpAddress(currentUrl.hostname)) {
    throw new Error(uiCopy.userSpace.office.remoteIpHostRequiresTemplate);
  }
  hostUrl.hostname = `${officeHostSessionLabel(sessionLabel)}.office-host.${currentUrl.hostname}`;
  return hostUrl.href;
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function officeHostSessionLabel(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "office"
  );
}

function isLocalOnlyOfficeParentHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
