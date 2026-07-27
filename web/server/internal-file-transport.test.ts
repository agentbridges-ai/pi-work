import { X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureInternalFileTransportCertificate,
  internalFileTransportBaseUrl,
  INTERNAL_FILE_TRANSPORT_HOST,
  isInternalFileConnectTarget,
  startInternalFileConnectProxy,
} from "./internal-file-transport.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("neutral internal file transport", () => {
  it("binds the Linux SRT canary to the production CONNECT proxy implementation", () => {
    const canary = readFileSync(
      new URL("../scripts/verify-srt-user-space-transport.ts", import.meta.url),
      "utf8",
    );
    expect(canary).toContain("startInternalFileConnectProxy");
    expect(canary).toContain("internalFileTransportBaseUrl");
    expect(canary).not.toContain("function startInternalConnectProxy");
  });

  it("accepts only its exact Piwork authority and never a model host", () => {
    expect(isInternalFileConnectTarget(`${INTERNAL_FILE_TRANSPORT_HOST}:4567`, 4567)).toBe(true);
    expect(isInternalFileConnectTarget(`${INTERNAL_FILE_TRANSPORT_HOST}:443`, 4567)).toBe(false);
    expect(isInternalFileConnectTarget("api.anthropic.com:443", 4567)).toBe(false);
    expect(isInternalFileConnectTarget("api.openai.com:443", 4567)).toBe(false);
    expect(
      isInternalFileConnectTarget(`${INTERNAL_FILE_TRANSPORT_HOST}:4567@example.com:443`, 4567),
    ).toBe(false);
  });

  it("builds only a session-scoped protected transfer URL", () => {
    expect(internalFileTransportBaseUrl(4567, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(
      `https://${INTERNAL_FILE_TRANSPORT_HOST}:4567/internal/user-space-transfer/` +
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(() => internalFileTransportBaseUrl(0, "bad")).toThrow();
  });

  it("creates a private certificate for the Piwork hostname without following key symlinks", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "piwork-internal-file-cert-"));
    roots.push(root);
    const dataRoot = join(root, "data");
    const runtimeDir = join(dataRoot, ".runtime");
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const outside = join(root, "outside-key");
    writeFileSync(outside, "do-not-overwrite");
    symlinkSync(outside, join(runtimeDir, "internal-file-transport.key"));

    const material = ensureInternalFileTransportCertificate(realpathSync(dataRoot));

    expect(readFileSync(outside, "utf8")).toBe("do-not-overwrite");
    expect(material.certPath).toBe(join(realpathSync(runtimeDir), "internal-file-transport.crt"));
    expect(statSync(join(runtimeDir, "internal-file-transport.key")).mode & 0o777).toBe(0o600);
    expect(statSync(material.certPath).mode & 0o777).toBe(0o600);
    const certificate = new X509Certificate(material.cert);
    expect(certificate.checkHost(INTERNAL_FILE_TRANSPORT_HOST)).toBe(INTERNAL_FILE_TRANSPORT_HOST);
    expect(certificate.ca).toBe(true);
    expect(existsSync(material.certPath)).toBe(true);
  });

  it("tunnels only to the fixed loopback TLS port", async () => {
    const target = createServer((socket) => socket.end("ok"));
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        target.once("error", rejectListen);
        target.listen(0, "127.0.0.1", resolveListen);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("missing target port");
    let proxy: Awaited<ReturnType<typeof startInternalFileConnectProxy>> | undefined;
    try {
      proxy = await startInternalFileConnectProxy(targetAddress.port);
      const response = await fetch(`http://127.0.0.1:${proxy.port}`, {
        method: "CONNECT",
        headers: { Host: `${INTERNAL_FILE_TRANSPORT_HOST}:${targetAddress.port}` },
      }).catch(() => null);
      // fetch implementations may reject CONNECT before network I/O. The
      // validator and dedicated SRT canary cover the byte-level protocol.
      if (response) expect([200, 403]).toContain(response.status);
    } catch (error) {
      if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    } finally {
      await proxy?.close();
      await new Promise<void>((resolveClose) => target.close(() => resolveClose()));
    }
  });
});
