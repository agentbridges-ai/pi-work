import type { OfficeHostUrlContext } from "@agentbridges-ai/onlyoffice-browser";

const ONLYOFFICE_SHARED_ASSET_ORIGIN = "https://onlyoffice.getpi.work/";
const OFFICE_EDITOR_SLOTS = [
  "aries",
  "taurus",
  "gemini",
  "cancer",
  "leo",
  "virgo",
  "libra",
  "scorpio",
  "sagittarius",
  "capricorn",
  "aquarius",
  "pisces",
] as const;
const OFFICE_EDITOR_SLOT_SET = new Set<string>(OFFICE_EDITOR_SLOTS);
const OFFICE_EDITOR_HOSTNAMES = new Set(OFFICE_EDITOR_SLOTS.map((slot) => `${slot}.getpi.work`));

export function resolvePiworkOnlyOfficeHostUrl(
  context: OfficeHostUrlContext,
  releaseId?: string | null,
): string {
  if (!OFFICE_EDITOR_SLOT_SET.has(context.hostSlot)) {
    throw new Error("OnlyOffice host slot is outside the fixed constellation pool");
  }
  const path = releaseId
    ? `/r/${encodeURIComponent(releaseId)}/office-host.html`
    : "/office-host.html";
  return `https://${context.hostSlot}.getpi.work${path}`;
}

export function resolvePiworkOnlyOfficeAssetBaseUrl(): string {
  return ONLYOFFICE_SHARED_ASSET_ORIGIN;
}

export function resolveOnlyOfficeAssetBaseUrl(hostUrl: URL, fallbackOrigin: string): string {
  if (
    hostUrl.hostname === "onlyoffice.getpi.work" ||
    OFFICE_EDITOR_HOSTNAMES.has(hostUrl.hostname.toLowerCase())
  ) {
    return ONLYOFFICE_SHARED_ASSET_ORIGIN;
  }
  return fallbackOrigin;
}
