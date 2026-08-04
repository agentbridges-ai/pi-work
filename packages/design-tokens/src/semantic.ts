/** Public roles for product surfaces. Values intentionally point at CSS vars. */
export const semanticTokens = {
  color: {
    background: "var(--background)",
    surface: "var(--surface)",
    surfaceWeak: "var(--surface-tertiary)",
    text: "var(--foreground)",
    textMuted: "var(--muted-foreground)",
    border: "var(--border)",
    controlBorder: "var(--control-border)",
    action: "var(--primary)",
    actionForeground: "var(--primary-foreground)",
    danger: "var(--danger)",
    warning: "var(--warning)",
    success: "var(--success)",
  },
  radius: {
    control: "var(--piwork-control-radius)",
    panel: "var(--piwork-panel-radius)",
  },
  motion: {
    feedback: "var(--piwork-duration-feedback)",
    overlay: "var(--piwork-duration-overlay)",
    layout: "var(--piwork-duration-layout)",
    easing: "var(--piwork-ease-out)",
  },
} as const;

export type SemanticTokens = typeof semanticTokens;
