/** Stable component contracts. Apps may use these, but must not redefine them. */
export const componentTokens = {
  button: {
    radius: "var(--piwork-control-radius)",
    heightSmall: "var(--piwork-control-height-sm)",
    heightMedium: "var(--piwork-control-height-md)",
    heightTouch: "var(--piwork-control-height-touch)",
  },
  panel: {
    radius: "var(--piwork-panel-radius)",
    background: "var(--card)",
    border: "var(--border)",
  },
  composer: {
    width: "var(--piwork-composer-width)",
    radius: "var(--piwork-composer-radius)",
    background: "var(--piwork-composer-background)",
  },
} as const;

export type ComponentTokens = typeof componentTokens;
