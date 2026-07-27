export interface PiworkNotificationData {
  type: "piwork-session";
  sessionId: string;
}

export interface ShowSessionNotificationOptions {
  body: string;
  sessionId: string;
  tag?: string;
  requireInteraction?: boolean;
}

export async function showSessionNotification(
  title: string,
  options: ShowSessionNotificationOptions,
): Promise<boolean> {
  if (!("serviceWorker" in navigator) || typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration?.active) return false;
  await registration.showNotification(title, {
    body: options.body,
    tag: options.tag || options.sessionId,
    requireInteraction: options.requireInteraction,
    icon: "/icons/piwork-192.png",
    badge: "/icons/piwork-192.png",
    data: {
      type: "piwork-session",
      sessionId: options.sessionId,
    } satisfies PiworkNotificationData,
  });
  return true;
}

export function subscribeToNotificationSessionOpen(
  listener: (sessionId: string) => void,
): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const onMessage = (event: MessageEvent<unknown>) => {
    const message = event.data as { type?: unknown; sessionId?: unknown } | null;
    if (message?.type !== "piwork:open-session" || typeof message.sessionId !== "string") return;
    listener(message.sessionId);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
