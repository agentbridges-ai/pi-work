export interface MessageBufferLimits {
  maxItems: number;
  maxBytes: number;
}

export interface MessageBufferAppendResult<T> {
  accepted: boolean;
  dropped: T[];
  byteLength: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

export function utf8JsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized === undefined ? "null" : serialized, "utf-8");
}

/**
 * Mutable FIFO with deterministic count and UTF-8 byte budgets. The buffer
 * owns the supplied array so existing Session serialization can keep using
 * plain arrays while all mutations flow through this small interface.
 */
export class BoundedMessageBuffer<T> {
  private bytes = 0;
  readonly limits: MessageBufferLimits;

  constructor(
    readonly items: T[],
    limits: MessageBufferLimits,
    private readonly measure: (item: T) => number = utf8JsonByteLength,
  ) {
    this.limits = {
      maxItems: positiveInteger(limits.maxItems, "maxItems"),
      maxBytes: positiveInteger(limits.maxBytes, "maxBytes"),
    };
    this.recalculate();
    this.trim();
  }

  append(item: T): MessageBufferAppendResult<T> {
    const itemBytes = this.measure(item);
    if (!Number.isSafeInteger(itemBytes) || itemBytes < 0) {
      throw new TypeError("message byte length must be a non-negative safe integer");
    }
    if (itemBytes > this.limits.maxBytes) {
      return { accepted: false, dropped: [], byteLength: this.bytes };
    }
    this.items.push(item);
    this.bytes += itemBytes;
    const dropped = this.trim();
    return { accepted: true, dropped, byteLength: this.bytes };
  }

  shift(): T | undefined {
    const item = this.items.shift();
    if (item !== undefined) this.bytes = Math.max(0, this.bytes - this.measure(item));
    return item;
  }

  removeAt(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return undefined;
    const [item] = this.items.splice(index, 1);
    if (item !== undefined) this.bytes = Math.max(0, this.bytes - this.measure(item));
    return item;
  }

  takeAll(): T[] {
    const values = this.items.splice(0);
    this.bytes = 0;
    return values;
  }

  replace(values: readonly T[]): T[] {
    this.items.splice(0);
    this.items.push(...values);
    this.recalculate();
    return this.trim();
  }

  byteLength(): number {
    return this.bytes;
  }

  private recalculate(): void {
    this.bytes = this.items.reduce((total, item) => total + this.measure(item), 0);
  }

  private trim(): T[] {
    const dropped: T[] = [];
    while (this.items.length > this.limits.maxItems || this.bytes > this.limits.maxBytes) {
      const item = this.items.shift();
      if (item === undefined) break;
      this.bytes = Math.max(0, this.bytes - this.measure(item));
      dropped.push(item);
    }
    return dropped;
  }
}
