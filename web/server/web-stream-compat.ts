interface ReleasableReader {
  readonly releaseLock?: () => void;
}

/** Release a terminal reader without letting runtime-specific cleanup replace its result. */
export function releaseReaderLockBestEffort(reader: ReleasableReader): void {
  try {
    const releaseLock = reader.releaseLock;
    if (typeof releaseLock === "function") Reflect.apply(releaseLock, reader, []);
  } catch {
    // Bun can expose non-standard request-body reader hooks. The caller has
    // already consumed or cancelled the stream, so there is nothing to recover.
  }
}
