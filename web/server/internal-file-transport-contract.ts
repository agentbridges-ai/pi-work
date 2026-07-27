export const INTERNAL_FILE_TRANSPORT_HOST = "user-space.piwork.internal";

export function isInternalFileConnectTarget(authority: string, tlsPort: number): boolean {
  const value = authority.trim();
  if (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65_535) return false;
  if (!value || /[\s/@]/.test(value)) return false;
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return false;
  const host = value.slice(0, separator).toLowerCase();
  const rawPort = value.slice(separator + 1);
  return (
    /^\d{1,5}$/.test(rawPort) &&
    Number(rawPort) === tlsPort &&
    host === INTERNAL_FILE_TRANSPORT_HOST
  );
}

export function internalFileTransportBaseUrl(tlsPort: number, sessionId: string): string {
  if (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65_535) {
    throw new Error("Internal file transport TLS port is invalid");
  }
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error("Invalid session id");
  return (
    `https://${INTERNAL_FILE_TRANSPORT_HOST}:${tlsPort}` +
    `/internal/user-space-transfer/${sessionId.toLowerCase()}`
  );
}
