export type ClientPlatform = "desktop-chromium" | "mobile" | "safari" | "firefox" | "other";

export type PwaCapabilityIssue = "insecure-context" | "service-worker-unavailable";

export interface UserAgentBrand {
  brand: string;
  version?: string;
}

export interface UserAgentDataSnapshot {
  brands?: readonly UserAgentBrand[];
  mobile?: boolean;
}

/**
 * A serializable snapshot of the browser signals used for product support.
 * Keeping this separate from Navigator makes detection deterministic in tests
 * and avoids treating user-agent sniffing as a security boundary.
 */
export interface PlatformSupportInput {
  userAgent?: string;
  userAgentData?: UserAgentDataSnapshot | null;
  platform?: string;
  maxTouchPoints?: number;
  isSecureContext?: boolean;
  hasServiceWorker?: boolean;
}

/**
 * Technical PWA prerequisites only. This state is deliberately independent of
 * the product platform gate: a desktop Chromium user can keep using the normal
 * workbench even when the current origin cannot register a Service Worker.
 */
export interface PwaCapabilityState {
  available: boolean;
  secureContext: boolean;
  serviceWorker: boolean;
  issues: readonly PwaCapabilityIssue[];
}

export interface PlatformSupportResult {
  platform: ClientPlatform;
  supported: boolean;
  pwa: PwaCapabilityState;
}

const MOBILE_USER_AGENT = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i;
const FIREFOX_USER_AGENT = /Firefox\/|FxiOS\//i;
const SAFARI_USER_AGENT = /Safari\//i;
const SAFARI_EXCLUSIONS =
  /Chrome\/|Chromium\/|CriOS\/|Edg(?:A|iOS)?\/|OPR\/|OPiOS\/|Vivaldi\/|YaBrowser\/|SamsungBrowser\/|Brave\//i;
const CHROMIUM_USER_AGENT =
  /Chrome\/|Chromium\/|CriOS\/|Edg(?:A|iOS)?\/|OPR\/|Vivaldi\/|YaBrowser\/|SamsungBrowser\/|Brave\//i;
const EMBEDDED_CHROMIUM_USER_AGENT = /Electron\//i;

const CHROMIUM_BRANDS = new Set(["chromium", "google chrome", "microsoft edge", "opera", "brave"]);

function isMobile(input: PlatformSupportInput, userAgent: string): boolean {
  if (input.userAgentData?.mobile === true) return true;
  if (MOBILE_USER_AGENT.test(userAgent)) return true;

  // iPadOS can request a desktop site and expose a Macintosh user agent.
  const platform = input.platform || "";
  return (
    input.maxTouchPoints !== undefined &&
    input.maxTouchPoints > 1 &&
    (/Macintosh/i.test(userAgent) || /^MacIntel$/i.test(platform))
  );
}

function isChromium(input: PlatformSupportInput, userAgent: string): boolean {
  if (EMBEDDED_CHROMIUM_USER_AGENT.test(userAgent)) return false;

  const hasChromiumBrand =
    input.userAgentData?.brands?.some(({ brand }) =>
      CHROMIUM_BRANDS.has(brand.trim().toLowerCase()),
    ) ?? false;

  return hasChromiumBrand || CHROMIUM_USER_AGENT.test(userAgent);
}

function classifyPlatform(input: PlatformSupportInput): ClientPlatform {
  const userAgent = input.userAgent || "";

  if (isMobile(input, userAgent)) return "mobile";
  if (FIREFOX_USER_AGENT.test(userAgent)) return "firefox";
  if (isChromium(input, userAgent)) return "desktop-chromium";
  if (SAFARI_USER_AGENT.test(userAgent) && !SAFARI_EXCLUSIONS.test(userAgent)) return "safari";
  return "other";
}

function detectPwaCapabilities(input: PlatformSupportInput): PwaCapabilityState {
  const secureContext = input.isSecureContext === true;
  const serviceWorker = input.hasServiceWorker === true;
  const issues: PwaCapabilityIssue[] = [];

  if (!secureContext) issues.push("insecure-context");
  if (!serviceWorker) issues.push("service-worker-unavailable");

  return {
    available: issues.length === 0,
    secureContext,
    serviceWorker,
    issues,
  };
}

export function detectPlatformSupport(input: PlatformSupportInput): PlatformSupportResult {
  const platform = classifyPlatform(input);
  return {
    platform,
    supported: platform === "desktop-chromium",
    pwa: detectPwaCapabilities(input),
  };
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: UserAgentDataSnapshot;
}

export function collectPlatformSupport(
  windowObject: Window = window,
  navigatorObject: Navigator = navigator,
): PlatformSupportResult {
  const navigatorWithUaData = navigatorObject as NavigatorWithUserAgentData;
  return detectPlatformSupport({
    userAgent: navigatorObject.userAgent,
    userAgentData: navigatorWithUaData.userAgentData,
    platform: navigatorObject.platform,
    maxTouchPoints: navigatorObject.maxTouchPoints,
    isSecureContext: windowObject.isSecureContext === true,
    hasServiceWorker: "serviceWorker" in navigatorObject,
  });
}
