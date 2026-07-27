type WtermPrintableKey = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
};

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Wterm 0.3.0 emits printable keys from keydown. Some IMEs start composition
 * only after that first keydown, so the first phonetic letter escapes before
 * Wterm learns that composition is active. Defer plain printable keys by one
 * task so compositionstart can discard that provisional key.
 */
export class WtermImeKeyBuffer {
  private readonly timers = new Set<TimerHandle>();

  constructor(private readonly emit: (data: string) => void) {}

  deferIfPrintable(event: WtermPrintableKey): boolean {
    if (
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      Array.from(event.key).length !== 1
    ) {
      return false;
    }

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.emit(event.key);
    }, 0);
    this.timers.add(timer);
    return true;
  }

  compositionStarted(): void {
    this.clear();
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
