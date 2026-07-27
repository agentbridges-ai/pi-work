import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type TimelineTone = "idle" | "running" | "success" | "warning" | "error" | "muted";

export interface TimelineRailItemProps {
  id?: string;
  tone: TimelineTone;
  title?: ReactNode;
  titleClassName?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  forceBody?: boolean;
  compactHeader?: boolean;
  autoOpenOnActive?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function TimelineRailScope({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tracks, setTracks] = useState<Array<{ top: number; height: number }>>([]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let frame = 0;
    const observedTargets = new Set<Element>();
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextTracks = updateRailGeometry(root);
        setTracks((currentTracks) =>
          areTracksEqual(currentTracks, nextTracks) ? currentTracks : nextTracks,
        );
      });
    };

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    const syncObservedTargets = () => {
      const nextTargets = new Set<Element>([root, ...getTopLevelTimelineNodes(root, root)]);
      for (const target of observedTargets) {
        if (nextTargets.has(target)) continue;
        resizeObserver.unobserve(target);
        observedTargets.delete(target);
      }
      for (const target of nextTargets) {
        if (observedTargets.has(target)) continue;
        resizeObserver.observe(target);
        observedTargets.add(target);
      }
    };

    syncObservedTargets();
    scheduleUpdate();

    const mutationObserver = new MutationObserver(() => {
      syncObservedTargets();
      scheduleUpdate();
    });
    mutationObserver.observe(root, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`timeline-rail-scope relative overflow-hidden ${className || ""}`}
    >
      {tracks.map((track, index) => (
        <span
          key={`${track.top}:${track.height}:${index}`}
          aria-hidden="true"
          className="timeline-rail-track absolute left-[6px] w-px -translate-x-1/2 bg-border/75"
          style={{ top: track.top, height: track.height }}
        />
      ))}
      {children}
    </div>
  );
}

export function TimelineRailItem({
  id,
  tone,
  title,
  titleClassName,
  children,
  defaultOpen = false,
  forceBody = false,
  compactHeader = false,
  autoOpenOnActive = true,
  open,
  onOpenChange,
}: TimelineRailItemProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const wasActive = useRef(defaultOpen);
  const controlled = typeof open === "boolean";
  const expanded = forceBody || (controlled ? open : internalOpen);
  const isActive = tone === "running" || tone === "warning" || tone === "error";
  const canToggle = Boolean(children) && !forceBody;

  useEffect(() => {
    if (autoOpenOnActive && isActive && !wasActive.current) {
      if (controlled) onOpenChange?.(true);
      else setInternalOpen(true);
    }
    wasActive.current = isActive;
  }, [autoOpenOnActive, controlled, isActive, onOpenChange]);

  const setExpanded = (value: boolean) => {
    if (controlled) onOpenChange?.(value);
    else setInternalOpen(value);
  };

  return (
    <div id={id} className="timeline-node relative pl-8">
      <span
        aria-hidden="true"
        className={`absolute left-[1px] top-[7px] z-10 h-2.5 w-2.5 rounded-full ${timelineDotClass(tone)}`}
      />
      {title && !compactHeader && (
        <button
          type="button"
          disabled={!canToggle}
          data-timeline-user-toggle={canToggle ? "true" : undefined}
          data-timeline-disclosure-controlled={canToggle && controlled ? "true" : undefined}
          onClick={() => canToggle && setExpanded(!expanded)}
          aria-expanded={canToggle ? expanded : undefined}
          className={`group flex min-w-0 items-center gap-2 text-left ${canToggle ? "cursor-pointer" : "cursor-default"}`}
        >
          <span
            className={`min-w-0 text-sm font-semibold leading-6 ${titleClassName || "text-foreground/88"}`}
          >
            {title}
          </span>
          {canToggle && (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
              aria-hidden="true"
            >
              <path d="M6.1 3.1 10.9 8l-4.8 4.9L5 11.8 8.8 8 5 4.2l1.1-1.1Z" />
            </svg>
          )}
        </button>
      )}
      {expanded && children && (
        <div className={title && !compactHeader ? "mt-2" : ""}>{children}</div>
      )}
    </div>
  );
}

function updateRailGeometry(root: HTMLElement): Array<{ top: number; height: number }> {
  const groups = getTimelineNodeGroups(root);
  const nodes = groups.flat();
  const rootTop = root.getBoundingClientRect().top;

  if (nodes.length === 0) return [];

  groups.forEach((group) => {
    group.forEach((node, index) => {
      node.dataset.timelineTerminal = index === group.length - 1 ? "true" : "false";
    });
  });

  return groups.flatMap((group) => {
    if (group.length < 2) {
      group.forEach((node) => {
        node.dataset.timelineTerminal = "true";
      });
      return [];
    }

    const firstDotCenter = group[0].getBoundingClientRect().top - rootTop + 12;
    const lastDotCenter = group[group.length - 1].getBoundingClientRect().top - rootTop + 12;
    return [{ top: firstDotCenter, height: Math.max(0, lastDotCenter - firstDotCenter) }];
  });
}

function getTimelineNodeGroups(root: HTMLElement): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  let currentGroup: HTMLElement[] = [];

  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement) || child.classList.contains("timeline-rail-track")) {
      continue;
    }

    const childNodes = getTopLevelTimelineNodes(child, root);
    if (childNodes.length > 0) {
      currentGroup.push(...childNodes);
      continue;
    }

    if (isEmptyTimelinePlaceholder(child)) {
      continue;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  if (groups.length === 0) {
    const nodes = getTopLevelTimelineNodes(root, root);
    if (nodes.length > 0) groups.push(nodes);
  }

  return groups;
}

function isEmptyTimelinePlaceholder(child: HTMLElement): boolean {
  const text = child.textContent?.trim() || "";
  if (text) return false;
  return child.getBoundingClientRect().height <= 1;
}

function getTopLevelTimelineNodes(container: HTMLElement, root: HTMLElement): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  if (container.classList.contains("timeline-node")) {
    candidates.push(container);
  }
  candidates.push(...Array.from(container.querySelectorAll<HTMLElement>(".timeline-node")));

  return candidates.filter((node) => {
    const ancestorItem = node.parentElement?.closest<HTMLElement>(".timeline-node");
    return !ancestorItem || !root.contains(ancestorItem);
  });
}

function areTracksEqual(
  currentTracks: Array<{ top: number; height: number }>,
  nextTracks: Array<{ top: number; height: number }>,
): boolean {
  if (currentTracks.length !== nextTracks.length) return false;
  return currentTracks.every((track, index) => {
    const next = nextTracks[index];
    return track.top === next.top && track.height === next.height;
  });
}

function timelineDotClass(tone: TimelineTone): string {
  if (tone === "running")
    return "bg-primary animate-[timeline-dot-pulse_1.4s_ease-in-out_infinite]";
  if (tone === "success") return "bg-success";
  if (tone === "warning") return "bg-warning";
  if (tone === "error") return "bg-danger";
  return "bg-muted-foreground";
}
