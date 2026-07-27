import { uiCopy } from "../ui-copy.js";

export function AgentThinking({
  active = true,
  label,
  className = "",
}: {
  active?: boolean;
  label?: string;
  className?: string;
}) {
  if (!active) return null;
  const visibleLabel = label || uiCopy.timeline.thinking;
  return (
    <span
      className={`agent-thinking ${className}`.trim()}
      data-testid="agent-thinking"
      role="status"
      aria-live="polite"
      aria-label={`${visibleLabel}...`}
    >
      <span className="agent-thinking__phrase" aria-hidden="true">
        <span className="agent-thinking__text">{visibleLabel}</span>
        <span className="agent-thinking__dots">...</span>
      </span>
    </span>
  );
}
