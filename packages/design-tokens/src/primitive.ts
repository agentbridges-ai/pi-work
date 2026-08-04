/**
 * Primitive values are implementation details for theme authors. Product code
 * should consume semantic or component tokens instead of these raw values.
 */
export const primitiveTokens = {
  color: {
    light: {
      page: "oklch(0.9789 0.0013 106.42)",
      surface: "oklch(1 0 0)",
      text: "oklch(0.3174 0.0091 88.75)",
      textMuted: "oklch(0.55 0.0046 91.47)",
      border: "oklch(0.9337 0.0013 106.43)",
      action: "oklch(0.2103 0.0013 106.42)",
    },
    dark: {
      page: "oklch(0.2178 0 0)",
      surface: "oklch(0.2603 0 0)",
      text: "oklch(0.8884 0 0)",
      textMuted: "oklch(0.64 0 0)",
      border: "oklch(0.3132 0 0)",
      action: "oklch(0.8884 0 0)",
    },
  },
  radius: {
    control: "6px",
    panel: "10px",
    composer: "12px",
  },
  space: {
    1: "4px",
    2: "8px",
    3: "12px",
    4: "16px",
    6: "24px",
    8: "32px",
    12: "48px",
  },
  duration: {
    feedback: "120ms",
    overlay: "220ms",
    layout: "320ms",
  },
} as const;

export type PrimitiveTokens = typeof primitiveTokens;
