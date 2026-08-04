export interface NetworkExposureSettings {
  host: string;
  publicOrigin?: string;
  registrationEnabled: boolean;
  sessionSandbox: string | undefined;
  requireSessionSandbox: boolean;
  /** The process is reachable only through the fixed local reverse proxy. */
  internalProxyOnly?: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized
      .split(".")
      .slice(1)
      .every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * A remotely reachable digital-agent runtime must be closed-registration
 * and fail closed when its process sandbox is unavailable.
 */
export function assertSecureNetworkExposure(settings: NetworkExposureSettings): void {
  if (isLoopbackHost(settings.host)) return;
  const failures: string[] = [];
  if (settings.internalProxyOnly) {
    if (settings.sessionSandbox !== "srt" || !settings.requireSessionSandbox) {
      failures.push("the SRT session sandbox is not configured and required");
    }
    if (failures.length) {
      throw new Error(
        `Refusing internal proxy listener HOST=${settings.host}: ${failures.join("; ")}. ` +
          "The fixed proxy path requires an available SRT sandbox.",
      );
    }
    return;
  }
  try {
    const origin = new URL(settings.publicOrigin || "");
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin !== settings.publicOrigin?.replace(/\/$/, "")
    ) {
      failures.push("BETTER_AUTH_URL is not an exact HTTPS origin");
    }
  } catch {
    failures.push("BETTER_AUTH_URL is not an exact HTTPS origin");
  }
  if (settings.registrationEnabled) failures.push("public registration is enabled");
  if (settings.sessionSandbox !== "srt" || !settings.requireSessionSandbox) {
    failures.push("the SRT session sandbox is not configured and required");
  }
  if (failures.length) {
    throw new Error(
      `Refusing non-loopback HOST=${settings.host}: ${failures.join("; ")}. ` +
        "Bind HOST=127.0.0.1, or configure an exact HTTPS BETTER_AUTH_URL, disable registration, and require an available SRT sandbox.",
    );
  }
}
