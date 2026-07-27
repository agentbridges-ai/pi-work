import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { INTERNAL_FILE_TRANSPORT_HOST } from "./internal-file-transport-contract.js";
import { getLocalDataRoot } from "./local-paths.js";

export {
  internalFileTransportBaseUrl,
  INTERNAL_FILE_TRANSPORT_HOST,
  isInternalFileConnectTarget,
} from "./internal-file-transport-contract.js";
export {
  startInternalFileConnectProxy,
  type InternalFileConnectProxy,
} from "./internal-file-connect-proxy.js";

export interface InternalFileTransportTls {
  key: string;
  cert: string;
  certPath: string;
}

function boundedRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024;
  } catch {
    return false;
  }
}

function readBoundedRegularFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) {
      throw new Error("Internal file transport material must be a bounded regular file");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function assertCertificate(path: string): void {
  if (!boundedRegularFile(path)) {
    throw new Error("Internal file transport certificate is not a private regular file");
  }
  const certificate = new X509Certificate(readBoundedRegularFile(path));
  if (certificate.checkHost(INTERNAL_FILE_TRANSPORT_HOST) !== INTERNAL_FILE_TRANSPORT_HOST) {
    throw new Error("Internal file transport certificate has the wrong hostname");
  }
  if (!certificate.ca) throw new Error("Internal file transport certificate must be a local CA");
  if (new Date(certificate.validTo).getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
    throw new Error("Internal file transport certificate expires too soon");
  }
}

function certificateUsable(keyPath: string, certPath: string): boolean {
  try {
    if (!boundedRegularFile(keyPath)) return false;
    assertCertificate(certPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create narrowly scoped TLS material for protected User Space and document
 * transfer only. The hostname is owned by Piwork and is never a model API.
 */
export function ensureInternalFileTransportCertificate(
  dataRoot = getLocalDataRoot(),
): InternalFileTransportTls {
  const root = realpathSync(dataRoot);
  if (root !== dataRoot || lstatSync(root).isSymbolicLink()) {
    throw new Error("Internal file transport data root must be canonical");
  }
  const runtimeDir = join(root, ".runtime");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  if (realpathSync(runtimeDir) !== runtimeDir || lstatSync(runtimeDir).isSymbolicLink()) {
    throw new Error("Internal file transport runtime directory must be canonical");
  }
  chmodSync(runtimeDir, 0o700);

  const keyPath = join(runtimeDir, "internal-file-transport.key");
  const certPath = join(runtimeDir, "internal-file-transport.crt");
  if (!certificateUsable(keyPath, certPath)) {
    const nonce = `${process.pid}-${randomUUID()}`;
    const stagedKey = join(runtimeDir, `.internal-file-transport-${nonce}.key`);
    const stagedCert = join(runtimeDir, `.internal-file-transport-${nonce}.crt`);
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-keyout",
          stagedKey,
          "-out",
          stagedCert,
          "-days",
          "30",
          "-nodes",
          "-subj",
          `/CN=${INTERNAL_FILE_TRANSPORT_HOST}`,
          "-addext",
          `subjectAltName=DNS:${INTERNAL_FILE_TRANSPORT_HOST}`,
          "-addext",
          "basicConstraints=critical,CA:TRUE",
          "-addext",
          "keyUsage=critical,keyCertSign,digitalSignature",
          "-addext",
          "extendedKeyUsage=serverAuth",
        ],
        { timeout: 10_000, stdio: "pipe" },
      );
      chmodSync(stagedKey, 0o600);
      chmodSync(stagedCert, 0o600);
      assertCertificate(stagedCert);
      rmSync(keyPath, { force: true });
      rmSync(certPath, { force: true });
      renameSync(stagedKey, keyPath);
      renameSync(stagedCert, certPath);
    } finally {
      rmSync(stagedKey, { force: true });
      rmSync(stagedCert, { force: true });
    }
  }

  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o600);
  assertCertificate(certPath);
  return {
    key: readBoundedRegularFile(keyPath),
    cert: readBoundedRegularFile(certPath),
    certPath: realpathSync(certPath),
  };
}
