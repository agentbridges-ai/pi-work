import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { uiCopy } from "../ui-copy.js";
import { MarkdownContent } from "./MessageBubble.js";
import { TimelineRailItem, type TimelineTone } from "./TimelineRail.js";

const COLLAPSED_PLAN_PREVIEW_HEIGHT = 320;

export type PlanApprovalStatus = "approved" | "cancelled" | "rejected";

export function TimelinePlanNode({
  id,
  plan,
  tone,
  approvalStatus,
}: {
  id: string;
  plan: string;
  tone: TimelineTone;
  approvalStatus?: PlanApprovalStatus;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(COLLAPSED_PLAN_PREVIEW_HEIGHT);
  const trimmed = plan.trim();

  const measureContentHeight = useCallback(() => {
    const content = contentRef.current;
    return Math.max(
      COLLAPSED_PLAN_PREVIEW_HEIGHT,
      content?.scrollHeight || 0,
      estimatePlanContentHeight(trimmed),
    );
  }, [trimmed]);

  const updateContentHeight = useCallback(() => {
    const nextHeight = measureContentHeight();
    setContentHeight((currentHeight) =>
      Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight,
    );
    return nextHeight;
  }, [measureContentHeight]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    updateContentHeight();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateContentHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, [updateContentHeight]);

  if (!trimmed) return null;

  const canHalfCollapse = contentHeight > COLLAPSED_PLAN_PREVIEW_HEIGHT + 8;
  const setPlanExpanded = (nextExpanded: boolean) => {
    if (nextExpanded !== expanded) {
      updateContentHeight();
    }
    setExpanded(nextExpanded);
  };

  return (
    <TimelineRailItem id={id} tone={tone} forceBody compactHeader>
      <section
        data-testid="timeline-plan-panel"
        className="piwork-superellipse-panel overflow-hidden rounded-[var(--piwork-panel-radius)] bg-card/85 text-foreground ring-1 ring-border/70 [corner-shape:superellipse(1.5)]"
      >
        <div className="relative flex h-10 w-full items-center justify-between gap-2 px-3 py-2 text-left">
          <span className="text-[13px] font-medium leading-[18px] text-primary">
            {uiCopy.timeline.plan}
          </span>
          <div className="flex items-center gap-2">
            {approvalStatus && (
              <span
                className={`text-xs font-medium leading-[18px] ${
                  approvalStatus === "approved" ? "text-success" : "text-danger"
                }`}
              >
                {approvalStatus === "approved"
                  ? uiCopy.timeline.approved
                  : approvalStatus === "rejected"
                    ? uiCopy.timeline.rejected
                    : uiCopy.timeline.cancelled}
              </span>
            )}
            {canHalfCollapse && (
              <button
                type="button"
                data-timeline-user-toggle="true"
                onClick={() => setPlanExpanded(!expanded)}
                aria-expanded={expanded}
                aria-label={
                  expanded ? uiCopy.timeline.collapsePlan : uiCopy.timeline.expandPlanContent
                }
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus:outline-none active:bg-accent/80 [corner-shape:superellipse(1.5)]"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className={`h-4 w-4 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${expanded ? "" : "rotate-180"}`}
                  aria-hidden="true"
                >
                  <path d="m4 10 4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div
          className="relative overflow-hidden transition-[max-height] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[max-height]"
          style={{
            maxHeight:
              expanded || !canHalfCollapse
                ? `${contentHeight}px`
                : `${COLLAPSED_PLAN_PREVIEW_HEIGHT}px`,
          }}
        >
          <div ref={contentRef} className="px-4 py-3">
            <MarkdownContent
              text={trimmed}
              className="markdown-body text-sm leading-[21px] text-foreground"
              paragraphClassName="mb-2 last:mb-0"
            />
          </div>
          {!expanded && canHalfCollapse && (
            <>
              <div
                aria-hidden="true"
                data-testid="timeline-plan-collapse-fade"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card via-card/95 to-transparent opacity-100"
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                <button
                  type="button"
                  data-timeline-user-toggle="true"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.currentTarget.blur();
                    setPlanExpanded(true);
                  }}
                  className="pointer-events-auto flex h-6 items-center rounded-[var(--piwork-control-radius)] border border-border/40 bg-card px-2 py-0.5 text-[13px] font-[430] leading-[18px] text-foreground transition-colors hover:bg-accent active:bg-accent/80"
                >
                  {uiCopy.timeline.expandPlan}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </TimelineRailItem>
  );
}

function estimatePlanContentHeight(text: string): number {
  const lines = text.split("\n");
  const wrappedLineCount = lines.reduce((count, line) => {
    const trimmed = line.trim();
    if (!trimmed) return count + 1;
    return count + Math.max(1, Math.ceil(trimmed.length / 54));
  }, 0);
  return 24 + wrappedLineCount * 21;
}
