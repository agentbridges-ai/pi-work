import { useEffect, useRef } from "react";

/**
 * Enforces the product contract for search surfaces that appear on demand:
 * opening the surface or changing its search context must activate its input.
 */
export function useAutoFocusSearchInput<T extends HTMLInputElement>(
  active: boolean,
  focusKey: unknown,
) {
  const inputRef = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [active, focusKey]);

  return inputRef;
}
