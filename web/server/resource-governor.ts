export interface UserResourceLimits {
  maxConcurrentSessions: number;
  maxManagedProcesses: number;
}

export const DEFAULT_USER_RESOURCE_LIMITS: UserResourceLimits = {
  maxConcurrentSessions: 4,
  maxManagedProcesses: 8,
};

export type ManagedProcessKind = "pi" | "pi-task";

export interface ResourceLease {
  release(): void;
}

export interface UserResourceSnapshot {
  concurrentSessions: number;
  managedProcesses: number;
  sessionLimit: number;
  processLimit: number;
}

export class ResourceLimitError extends Error {
  readonly status = 429;

  constructor(
    readonly resource: "session" | "process",
    readonly limit: number,
  ) {
    super(
      resource === "session"
        ? `Concurrent session limit reached (${limit})`
        : `Managed process limit reached (${limit})`,
    );
    this.name = "ResourceLimitError";
  }
}

interface ReservationCounter {
  references: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Per-Better-Auth-user admission control for resources managed by Piwork.
 * One governor is intentionally shared by every tenant runtime for that uuid.
 *
 * Reservations are synchronous so two concurrent async launch flows cannot
 * both observe spare capacity. Owners are reference-counted: overlapping
 * generations of the same Pi session consume one session slot while each
 * live process generation still consumes its own process slot.
 */
export class UserResourceGovernor {
  private readonly sessions = new Map<string, ReservationCounter>();
  private readonly processes = new Map<string, ReservationCounter>();
  private existingProcessDebtLeases = 0;
  readonly limits: UserResourceLimits;

  constructor(limits: UserResourceLimits = DEFAULT_USER_RESOURCE_LIMITS) {
    this.limits = {
      maxConcurrentSessions: positiveInteger(limits.maxConcurrentSessions, "maxConcurrentSessions"),
      maxManagedProcesses: positiveInteger(limits.maxManagedProcesses, "maxManagedProcesses"),
    };
  }

  reserveSession(sessionId: string): ResourceLease {
    return this.reserve(
      this.sessions,
      this.requireOwner(sessionId, "sessionId"),
      this.limits.maxConcurrentSessions,
      "session",
    );
  }

  reserveManagedProcess(kind: ManagedProcessKind, processId: string): ResourceLease {
    return this.reserve(
      this.processes,
      `${kind}:${this.requireOwner(processId, "processId")}`,
      this.limits.maxManagedProcesses,
      "process",
    );
  }

  /** Atomically reserves both slots needed by a Pi process generation. */
  reservePiProcess(sessionId: string, processId: string): ResourceLease {
    const normalizedSessionId = this.requireOwner(sessionId, "sessionId");
    const normalizedProcessId = this.requireOwner(processId, "processId");
    this.assertCapacity(
      this.sessions,
      normalizedSessionId,
      this.limits.maxConcurrentSessions,
      "session",
    );
    this.assertCapacity(
      this.processes,
      `pi:${normalizedProcessId}`,
      this.limits.maxManagedProcesses,
      "process",
    );

    const sessionLease = this.reserve(
      this.sessions,
      normalizedSessionId,
      this.limits.maxConcurrentSessions,
      "session",
    );
    try {
      const processLease = this.reserve(
        this.processes,
        `pi:${normalizedProcessId}`,
        this.limits.maxManagedProcesses,
        "process",
      );
      return this.combine(sessionLease, processLease);
    } catch (error) {
      sessionLease.release();
      throw error;
    }
  }

  /**
   * Accounts for a Pi process that was already running when the governor
   * discovered it. Existing work cannot be rejected retroactively, so this
   * bypasses configured limits and records admission debt instead. While any
   * such debt lease remains, every normal reservation fails closed.
   */
  accountForExistingPiProcess(sessionId: string, processId: string): ResourceLease {
    const normalizedSessionId = this.requireOwner(sessionId, "sessionId");
    const normalizedProcessId = this.requireOwner(processId, "processId");
    const sessionLease = this.addReservationReference(this.sessions, normalizedSessionId);
    const processLease = this.addReservationReference(this.processes, `pi:${normalizedProcessId}`);
    const resourceLease = this.combine(sessionLease, processLease);
    this.existingProcessDebtLeases += 1;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        resourceLease.release();
        this.existingProcessDebtLeases -= 1;
      },
    };
  }

  snapshot(): UserResourceSnapshot {
    return {
      concurrentSessions: this.sessions.size,
      managedProcesses: this.processes.size,
      sessionLimit: this.limits.maxConcurrentSessions,
      processLimit: this.limits.maxManagedProcesses,
    };
  }

  private requireOwner(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) throw new TypeError(`${label} must not be empty`);
    return normalized;
  }

  private assertCapacity(
    reservations: Map<string, ReservationCounter>,
    owner: string,
    limit: number,
    resource: "session" | "process",
  ): void {
    if (this.existingProcessDebtLeases > 0) {
      throw new ResourceLimitError(resource, limit);
    }
    if (!reservations.has(owner) && reservations.size >= limit) {
      throw new ResourceLimitError(resource, limit);
    }
  }

  private reserve(
    reservations: Map<string, ReservationCounter>,
    owner: string,
    limit: number,
    resource: "session" | "process",
  ): ResourceLease {
    this.assertCapacity(reservations, owner, limit, resource);
    return this.addReservationReference(reservations, owner);
  }

  private addReservationReference(
    reservations: Map<string, ReservationCounter>,
    owner: string,
  ): ResourceLease {
    const counter = reservations.get(owner) ?? { references: 0 };
    counter.references += 1;
    reservations.set(owner, counter);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = reservations.get(owner);
        if (!current) return;
        current.references -= 1;
        if (current.references <= 0) reservations.delete(owner);
      },
    };
  }

  private combine(...leases: ResourceLease[]): ResourceLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (let index = leases.length - 1; index >= 0; index -= 1) {
          leases[index].release();
        }
      },
    };
  }
}
