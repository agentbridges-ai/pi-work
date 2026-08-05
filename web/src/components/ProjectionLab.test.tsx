// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import { ProjectionLab } from "./ProjectionLab.js";

vi.mock("./MessageFeed.js", () => ({ MessageFeed: () => <div data-testid="message-feed" /> }));
vi.mock("../ws.js", async () => {
  const actual = await vi.importActual<typeof import("../ws.js")>("../ws.js");
  return { ...actual, loadSessionHistoryPage: vi.fn() };
});

beforeEach(() => {
  useStore.getState().reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

describe("ProjectionLab", () => {
  it("is server-gated and drives the shared message projection controls", async () => {
    render(<ProjectionLab />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /投影视验室|Projection Lab/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /单步|Step/ }));
    expect(screen.getByTestId("message-feed")).toBeTruthy();
    expect(screen.getByText(/事件 1\/7|Events 1\/7/)).toBeTruthy();
    expect(screen.getByTestId("agent-activity-bar")).toBeTruthy();
  });

  it("does not expose the lab when the hub entry is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    render(<ProjectionLab />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/未启用|not enabled/);
  });

  it("recovers a dropped final message through the shared gap history snapshot", async () => {
    render(<ProjectionLab />);
    await screen.findByRole("heading", { name: /投影视验室|Projection Lab/ });
    fireEvent.change(screen.getByRole("combobox", { name: /故障|Fault/ }), {
      target: { value: "gap" },
    });
    const step = screen.getByRole("button", { name: /单步|Step/ });
    for (let index = 0; index < 5; index += 1) fireEvent.click(step);

    const messages = useStore.getState().messages.get("recording-hub-projection-lab");
    expect(messages).toHaveLength(1);
    expect(messages?.[0]).toMatchObject({
      id: "scenario-assistant-1",
      content: "Projection complete.",
    });
    expect(messages?.[0]?.isStreaming).toBeUndefined();
  });
});
