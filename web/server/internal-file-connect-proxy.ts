import { connect, createServer, type Server, type Socket } from "node:net";
import { isInternalFileConnectTarget } from "./internal-file-transport-contract.js";

const MAX_CONNECT_HEADER_BYTES = 8 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;

export interface InternalFileConnectProxy {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

/**
 * Start a loopback CONNECT tunnel that accepts exactly the protected Piwork
 * file-transfer authority. It has no general egress or model-host passthrough.
 *
 * This function is exercised by the real Linux protected-file SRT canary
 * because its socket lifecycle cannot run inside Vitest's V8 isolate.
 */
export async function startInternalFileConnectProxy(
  tlsPort: number,
): Promise<InternalFileConnectProxy> {
  if (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65_535) {
    throw new Error("Internal file transport TLS port is invalid");
  }
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.setTimeout(CONNECT_TIMEOUT_MS, () => client.destroy());
    let buffered = Buffer.alloc(0);

    const reject = (status: 403 | 431) => {
      client.end(
        status === 431
          ? "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n"
          : "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
      );
    };

    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > MAX_CONNECT_HEADER_BYTES) {
        client.off("data", onData);
        reject(431);
        return;
      }
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      client.off("data", onData);
      const requestLine = buffered.subarray(0, headerEnd).toString("ascii").split("\r\n", 1)[0];
      const [method, authority, protocol, extra] = requestLine.split(/\s+/);
      if (
        extra !== undefined ||
        method !== "CONNECT" ||
        !/^HTTP\/1\.[01]$/.test(protocol || "") ||
        !isInternalFileConnectTarget(authority || "", tlsPort)
      ) {
        reject(403);
        return;
      }

      const upstream = connect({ host: "127.0.0.1", port: tlsPort });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.once("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = buffered.subarray(headerEnd + 4);
        if (remainder.byteLength) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.once("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy());
    };
    client.on("data", onData);
    client.once("error", () => client.destroy());
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await closeServer(server);
    throw new Error("Internal file CONNECT proxy did not bind to loopback");
  }
  return {
    server,
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closeServer(server);
    },
  };
}
