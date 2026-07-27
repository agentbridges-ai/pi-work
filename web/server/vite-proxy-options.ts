import type { ClientRequest, IncomingMessage } from "node:http";
import { ENV, environment } from "./environment.js";

export function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export function preserveOriginalOriginProxyOptions(options: { ws?: boolean } = {}) {
  const controlPlaneTarget =
    environment.value(ENV.PIWORK_DEV_CONTROL_PLANE_URL) || "http://127.0.0.1:3457";
  return {
    target: controlPlaneTarget,
    changeOrigin: true,
    ...(options.ws ? { ws: true, rewriteWsOrigin: false } : {}),
    configure(proxy: {
      on(
        event: "proxyReq",
        listener: (proxyReq: ClientRequest, req: IncomingMessage) => void,
      ): void;
    }) {
      proxy.on("proxyReq", (proxyReq: ClientRequest, req: IncomingMessage) => {
        const forwardedHost =
          firstHeader(req.headers["x-forwarded-host"]) || firstHeader(req.headers.host);
        const forwardedProto =
          firstHeader(req.headers["x-forwarded-proto"]) ||
          ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
        if (forwardedHost) proxyReq.setHeader("X-Forwarded-Host", forwardedHost);
        if (forwardedProto) proxyReq.setHeader("X-Forwarded-Proto", forwardedProto);
      });
    },
  };
}
