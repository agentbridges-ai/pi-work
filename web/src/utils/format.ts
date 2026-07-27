/**
 * Format an elapsed duration in milliseconds as "Xs" or "Xm Ys".
 */
export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/**
 * Format a countdown from a future ISO-8601 timestamp to a compact "Xd Yh Zm" string.
 * Returns "now" if the timestamp is in the past.
 */
export function formatResetTime(resetsAt: string): string {
  try {
    const diffMs = new Date(resetsAt).getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return "N/A";
    if (diffMs <= 0) return "now";
    return formatCountdownMs(diffMs);
  } catch {
    return "N/A";
  }
}

function formatCountdownMs(diffMs: number): string {
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}
