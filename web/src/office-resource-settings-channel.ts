type OfficeResourceSettingsListener = () => void;

const listeners = new Set<OfficeResourceSettingsListener>();

export function requestOfficeResourceSettings(): void {
  for (const listener of listeners) listener();
}

export function subscribeOfficeResourceSettingsRequests(
  listener: OfficeResourceSettingsListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetOfficeResourceSettingsChannelForTests(): void {
  listeners.clear();
}
