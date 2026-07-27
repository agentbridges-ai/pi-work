const MEBIBYTE = 1024 * 1024;

/**
 * Hard ceiling for every WebSocket message accepted by the shared Bun
 * listener. Narrower browser and protocol limits remain semantic checks after
 * Bun has reassembled the message.
 */
export const RUNTIME_TRANSPORT_MAX_MESSAGE_BYTES = 8 * MEBIBYTE;

/** Browser messages are intentionally narrower than the process transport ceiling. */
export const BROWSER_WS_MAX_MESSAGE_BYTES = MEBIBYTE;

export function websocketTransportLimits(): Readonly<{ maxPayloadLength: number }> {
  return {
    maxPayloadLength: RUNTIME_TRANSPORT_MAX_MESSAGE_BYTES,
  };
}
