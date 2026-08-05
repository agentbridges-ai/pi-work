import { randomUUID } from "node:crypto";
import type {
  AppCloudflareAccountContext,
  AppCloudflareQueuedDeployment,
} from "./apps-cloudflare-account-types.js";
import type { AppOperationOutboxRecord } from "./apps-types.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_CLAIM_LIMIT = 10;
const DEFAULT_LEASE_MS = 30_000;

export interface AppsOutboxWorkerDependencies {
  claim(workerId: string, limit: number, leaseMs: number): Promise<AppOperationOutboxRecord[]>;
  run(
    context: AppCloudflareAccountContext,
    deployment: AppCloudflareQueuedDeployment,
    signal: AbortSignal,
  ): Promise<void>;
  complete(id: string, workerId: string): Promise<boolean>;
  retry(id: string, workerId: string, error: unknown): Promise<boolean>;
  /** Permanently rejects malformed or unsupported records without executing them. */
  fail(record: AppOperationOutboxRecord, workerId: string, error: unknown): Promise<boolean>;
  onError?(error: unknown): void;
}

export interface AppsOutboxWorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  claimLimit?: number;
  leaseMs?: number;
}

interface ParsedDeploymentOperation {
  context: AppCloudflareAccountContext;
  deployment: AppCloudflareQueuedDeployment;
}

class AppsOutboxStoppedError extends Error {
  constructor() {
    super("Apps outbox worker stopped before the claimed operation ran.");
    this.name = "AbortError";
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value))
    throw new Error("Apps outbox worker options must be finite numbers.");
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function strictString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`Apps outbox payload field ${field} must be a non-empty string.`);
  }
  return value;
}

function strictNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return strictString(value, field);
}

export function parseAppsDeploymentOutboxRecord(
  record: AppOperationOutboxRecord,
): ParsedDeploymentOperation {
  if (record.operation !== "deploy" && record.operation !== "rollback") {
    throw new Error("Apps outbox worker only accepts deploy and rollback operations.");
  }
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw new Error("Apps outbox payload must be an object.");
  }

  const expectedKeys = [
    "connectionId",
    "deploymentId",
    "membershipId",
    "target",
    "temporaryAccountId",
    "userId",
  ];
  const actualKeys = Object.keys(record.payload).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Apps outbox payload has missing or unknown fields.");
  }

  const userId = strictString(record.payload.userId, "userId");
  const membershipId = strictString(record.payload.membershipId, "membershipId");
  const deploymentId = strictString(record.payload.deploymentId, "deploymentId");
  const connectionId = strictNullableString(record.payload.connectionId, "connectionId");
  const temporaryAccountId = strictNullableString(
    record.payload.temporaryAccountId,
    "temporaryAccountId",
  );
  const target = record.payload.target;
  if (target !== "temporary" && target !== "byoc") {
    throw new Error("Apps outbox payload target must be temporary or byoc.");
  }
  if (target === "byoc" && (!connectionId || temporaryAccountId !== null)) {
    throw new Error("Apps BYOC outbox payload requires only connectionId.");
  }
  if (target === "temporary" && (!temporaryAccountId || connectionId !== null)) {
    throw new Error("Apps temporary outbox payload requires only temporaryAccountId.");
  }
  if (!Number.isSafeInteger(record.appGeneration) || record.appGeneration <= 0) {
    throw new Error("Apps outbox record appGeneration must be a positive safe integer.");
  }

  return {
    context: {
      tenantId: strictString(record.tenantId, "tenantId"),
      userId,
      membershipId,
    },
    deployment: {
      appId: strictString(record.appId, "appId"),
      deploymentId,
      appGeneration: record.appGeneration,
      phase: "queued",
      target,
      connectionId,
      temporaryAccountId,
    },
  };
}

/**
 * Recovers durable App deploy/rollback operations from Postgres.
 *
 * A chained timeout keeps polling single-flight. Stopping aborts cooperative runners,
 * waits for the active runner, and releases any claimed records that have not started.
 */
export class AppsOutboxWorker {
  readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly claimLimit: number;
  private readonly leaseMs: number;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private pollPromise: Promise<number> | null = null;

  constructor(
    private readonly dependencies: AppsOutboxWorkerDependencies,
    options: AppsOutboxWorkerOptions = {},
  ) {
    this.workerId = options.workerId?.trim() || `apps-outbox:${process.pid}:${randomUUID()}`;
    this.pollIntervalMs = boundedInteger(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      25,
      60_000,
    );
    this.claimLimit = boundedInteger(options.claimLimit, DEFAULT_CLAIM_LIMIT, 1, 100);
    this.leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 1_000, 300_000);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.controller = new AbortController();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    const pending = this.pollPromise;
    if (pending) await pending.catch(() => undefined);
    this.controller = null;
  }

  pollOnce(): Promise<number> {
    if (this.pollPromise) return this.pollPromise;
    const signal = this.controller?.signal ?? new AbortController().signal;
    const operation = this.doPoll(signal).finally(() => {
      if (this.pollPromise === operation) this.pollPromise = null;
    });
    this.pollPromise = operation;
    return operation;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    const timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce()
        .catch((error) => this.report(error))
        .finally(() => {
          if (this.started) this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private async doPoll(signal: AbortSignal): Promise<number> {
    const records = await this.dependencies.claim(this.workerId, this.claimLimit, this.leaseMs);
    let processed = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (signal.aborted) {
        const stopped = new AppsOutboxStoppedError();
        for (const unprocessed of records.slice(index)) {
          await this.settleRetry(unprocessed.id, stopped);
        }
        break;
      }
      await this.process(record, signal);
      processed += 1;
    }
    return processed;
  }

  private async process(record: AppOperationOutboxRecord, signal: AbortSignal): Promise<void> {
    let parsed: ParsedDeploymentOperation;
    try {
      parsed = parseAppsDeploymentOutboxRecord(record);
    } catch (error) {
      try {
        await this.dependencies.fail(record, this.workerId, error);
      } catch (settleError) {
        this.report(settleError);
      }
      return;
    }

    try {
      await this.dependencies.run(parsed.context, parsed.deployment, signal);
      await this.dependencies.complete(record.id, this.workerId);
    } catch (error) {
      await this.settleRetry(record.id, error);
    }
  }

  private async settleRetry(id: string, error: unknown): Promise<void> {
    try {
      await this.dependencies.retry(id, this.workerId, error);
    } catch (settleError) {
      this.report(settleError);
    }
  }

  private report(error: unknown): void {
    this.dependencies.onError?.(error);
  }
}
