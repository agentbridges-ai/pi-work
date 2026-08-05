import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

/** The proof-of-work challenge returned by Cloudflare's preview API. */
export interface CloudflarePreviewChallenge {
  challengeToken: string;
  seed: string;
  k: number;
  g: number;
}

export interface CloudflarePreviewSolution {
  challengeToken: string;
  solution: { checkpoints: string };
}

export class CloudflarePreviewChallengeError extends Error {
  readonly code = "invalid_cloudflare_preview_challenge";

  constructor(message: string) {
    super(message);
    this.name = "CloudflarePreviewChallengeError";
  }
}

const MAX_HASHES = 64_000_000;
const SEED_BYTES = 32;

function decodeSeed(seed: unknown): Buffer {
  if (typeof seed !== "string" || seed.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(seed)) {
    throw new CloudflarePreviewChallengeError("seed must be a base64url string");
  }
  // Node accepts a few malformed base64 strings. The alphabet/length checks above
  // make the input unambiguous before decoding it.
  if (seed.length % 4 === 1) {
    throw new CloudflarePreviewChallengeError("seed is not valid base64url");
  }
  const bytes = Buffer.from(seed, "base64url");
  if (bytes.byteLength !== SEED_BYTES) {
    throw new CloudflarePreviewChallengeError("seed must decode to 32 bytes");
  }
  return bytes;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new CloudflarePreviewChallengeError(`${field} must be a positive integer`);
  }
  return Number(value);
}

export interface ValidatedCloudflarePreviewChallenge {
  challengeToken: string;
  seed: Buffer;
  k: number;
  g: number;
}

export function validateCloudflarePreviewChallenge(
  challenge: CloudflarePreviewChallenge,
): ValidatedCloudflarePreviewChallenge {
  if (
    !challenge ||
    typeof challenge !== "object" ||
    typeof challenge.challengeToken !== "string" ||
    challenge.challengeToken.trim().length === 0
  ) {
    throw new CloudflarePreviewChallengeError("challengeToken is required");
  }
  const seed = decodeSeed(challenge.seed);
  const k = positiveInteger(challenge.k, "k");
  const g = positiveInteger(challenge.g, "g");
  if (k > Math.floor(MAX_HASHES / g)) {
    throw new CloudflarePreviewChallengeError("k * g must not exceed 64,000,000");
  }
  return { challengeToken: challenge.challengeToken, seed, k, g };
}

function sha256(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Deterministic implementation of Cloudflare's checkpoint chain. Keep this
 * synchronous function small and pure so it is useful for contract vectors;
 * production callers should use solveCloudflarePreviewChallenge(), which runs
 * the same computation in a worker thread.
 */
export function solveCloudflarePreviewChallengeSync(
  challenge: CloudflarePreviewChallenge,
): CloudflarePreviewSolution {
  const validated = validateCloudflarePreviewChallenge(challenge);
  const checkpoints: Buffer[] = [];
  let hash = sha256(validated.seed);
  checkpoints.push(hash);
  for (let segment = 0; segment < validated.k; segment += 1) {
    for (let iteration = 0; iteration < validated.g; iteration += 1) {
      hash = sha256(hash);
    }
    checkpoints.push(hash);
  }
  return {
    challengeToken: validated.challengeToken,
    solution: { checkpoints: Buffer.concat(checkpoints).toString("base64") },
  };
}

const WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { createHash } = require("node:crypto");
  const sha256 = (value) => createHash("sha256").update(value).digest();
  try {
    const seed = Buffer.from(workerData.seed, "base64");
    let hash = sha256(seed);
    const checkpoints = [hash];
    for (let segment = 0; segment < workerData.k; segment += 1) {
      for (let iteration = 0; iteration < workerData.g; iteration += 1) hash = sha256(hash);
      checkpoints.push(hash);
    }
    parentPort.postMessage(Buffer.concat(checkpoints).toString("base64"));
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : "proof-of-work failed" });
  }
`;

export interface SolveCloudflarePreviewChallengeOptions {
  signal?: AbortSignal;
  /** Hard stop for a worker that is taking too long; never retry implicitly. */
  timeoutMs?: number;
}

/** Solve outside the API event loop, as required by the Cloudflare contract. */
export function solveCloudflarePreviewChallenge(
  challenge: CloudflarePreviewChallenge,
  options: SolveCloudflarePreviewChallengeOptions = {},
): Promise<CloudflarePreviewSolution> {
  const validated = validateCloudflarePreviewChallenge(challenge);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
    return Promise.reject(new CloudflarePreviewChallengeError("timeoutMs is invalid"));
  }
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException("The proof-of-work solve was aborted", "AbortError"));
  }
  return new Promise<CloudflarePreviewSolution>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        seed: validated.seed.toString("base64"),
        k: validated.k,
        g: validated.g,
      },
    });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      void worker.terminate();
      finish(() => reject(new DOMException("The proof-of-work solve was aborted", "AbortError")));
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new CloudflarePreviewChallengeError("proof-of-work solve timed out")));
    }, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: unknown) => {
      if (message && typeof message === "object" && "error" in message) {
        finish(() => reject(new CloudflarePreviewChallengeError(String(message.error))));
        return;
      }
      if (typeof message !== "string") {
        finish(() =>
          reject(new CloudflarePreviewChallengeError("proof-of-work result is invalid")),
        );
        return;
      }
      finish(() => {
        resolve({ challengeToken: validated.challengeToken, solution: { checkpoints: message } });
      });
    });
    worker.once("error", (error: Error) => {
      finish(() => reject(new CloudflarePreviewChallengeError(error.message)));
    });
    worker.once("exit", (code: number) => {
      if (code !== 0) {
        finish(() => reject(new CloudflarePreviewChallengeError("proof-of-work worker exited")));
      }
    });
  });
}

export const CLOUDFLARE_PREVIEW_MAX_HASHES = MAX_HASHES;
