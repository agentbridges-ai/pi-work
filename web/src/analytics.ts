export function isAnalyticsEnabled(): boolean {
  return false;
}

export function getTelemetryPreferenceEnabled(): boolean {
  return false;
}

export function setTelemetryPreferenceEnabled(_enabled: boolean): void {
  // Telemetry is intentionally disabled in the local-first workbench.
}

export function initAnalytics(): boolean {
  return false;
}

export function captureEvent(_event: string, _properties?: Record<string, unknown>): void {
  // No-op: avoid sending usage data from local workspaces.
}

export function captureException(_error: unknown, _properties?: Record<string, unknown>): void {
  // No-op: errors stay local.
}

export function capturePageView(_path: string): void {
  // No-op: page views stay local.
}
