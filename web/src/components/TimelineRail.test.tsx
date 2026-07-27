// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineRailItem, TimelineRailScope } from "./TimelineRail.js";

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

describe("TimelineRail", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("timeline-node")) {
        const text = this.textContent || "";
        const top = text.includes("First") ? 20 : text.includes("Second") ? 84 : 148;
        return makeRect({ top });
      }
      return originalGetBoundingClientRect.call(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws one continuous rail from the first dot to the final dot", async () => {
    const { container } = render(
      <TimelineRailScope>
        <TimelineRailItem tone="success" title="First" />
        <div>
          <TimelineRailItem tone="idle" title="Second" />
        </div>
        <TimelineRailItem tone="muted" title="Third" />
      </TimelineRailScope>,
    );

    const nodes = Array.from(container.querySelectorAll<HTMLElement>(".timeline-node"));
    expect(nodes).toHaveLength(3);
    expect(container.firstElementChild?.className).toContain("overflow-hidden");

    await waitFor(() => {
      expect(nodes[0].dataset.timelineTerminal).toBe("false");
      expect(nodes[1].dataset.timelineTerminal).toBe("false");
      expect(nodes[2].dataset.timelineTerminal).toBe("true");
    });

    const track = container.querySelector<HTMLElement>(".timeline-rail-track");
    expect(track).toBeTruthy();
    expect(track?.style.top).toBe("32px");
    expect(track?.style.height).toBe("128px");
    expect(container.querySelector(".timeline-connector")).toBeNull();
  });

  it("does not connect agent rail segments across non-timeline content", async () => {
    const { container } = render(
      <TimelineRailScope>
        <TimelineRailItem tone="success" title="First" />
        <div data-testid="user-message">user bubble</div>
        <TimelineRailItem tone="muted" title="Second" />
      </TimelineRailScope>,
    );

    const nodes = Array.from(container.querySelectorAll<HTMLElement>(".timeline-node"));
    expect(nodes).toHaveLength(2);

    await waitFor(() => {
      expect(nodes[0].dataset.timelineTerminal).toBe("true");
      expect(nodes[1].dataset.timelineTerminal).toBe("true");
    });

    expect(container.querySelectorAll(".timeline-rail-track")).toHaveLength(0);
  });

  it("keeps one observer lifecycle across repeated streaming rerenders", () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;
    let observerInstances = 0;
    class CountingResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
        observerInstances += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: CountingResizeObserver,
    });

    try {
      const { rerender } = render(
        <TimelineRailScope>
          <TimelineRailItem tone="running" title="token 0" />
        </TimelineRailScope>,
      );
      for (let index = 1; index <= 30; index += 1) {
        rerender(
          <TimelineRailScope>
            <TimelineRailItem tone="running" title={`token ${index}`} />
          </TimelineRailScope>,
        );
      }
      expect(observerInstances).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: OriginalResizeObserver,
      });
    }
  });

  it("keeps an active item open after it completes", () => {
    const { rerender } = render(
      <TimelineRailItem tone="running" title="Bash" defaultOpen>
        <div>tool output</div>
      </TimelineRailItem>,
    );

    expect(screen.getByText("tool output")).toBeTruthy();

    rerender(
      <TimelineRailItem tone="success" title="Bash" defaultOpen={false}>
        <div>tool output</div>
      </TimelineRailItem>,
    );

    expect(screen.getByText("tool output")).toBeTruthy();
  });

  it("can keep an active item collapsed when auto-open is disabled", () => {
    const { rerender } = render(
      <TimelineRailItem tone="idle" title="Write" autoOpenOnActive={false}>
        <div>created file diff</div>
      </TimelineRailItem>,
    );

    expect(screen.queryByText("created file diff")).toBeNull();

    rerender(
      <TimelineRailItem tone="running" title="Write" autoOpenOnActive={false}>
        <div>created file diff</div>
      </TimelineRailItem>,
    );

    expect(screen.queryByText("created file diff")).toBeNull();
  });

  it("uses right-to-down disclosure direction for collapsible titles", () => {
    render(
      <TimelineRailItem tone="muted" title="Thinking">
        <div>hidden reasoning</div>
      </TimelineRailItem>,
    );

    const button = screen.getByRole("button", { name: "Thinking" });
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class")).not.toContain("rotate-90");
    expect(screen.queryByText("hidden reasoning")).toBeNull();

    fireEvent.click(button);

    expect(icon?.getAttribute("class")).toContain("rotate-90");
    expect(screen.getByText("hidden reasoning")).toBeTruthy();
  });
});

function makeRect({ top }: { top: number }): DOMRect {
  return {
    bottom: top + 24,
    height: 24,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
