// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentThinking } from "./AgentThinking.js";

describe("AgentThinking", () => {
  it("renders a localized status without backend branding", () => {
    render(<AgentThinking />);
    const status = screen.getByTestId("agent-thinking");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).not.toMatch(/claude/i);
  });

  it("uses a caller-provided progress label", () => {
    render(<AgentThinking label="Reading" />);
    expect(screen.getByText("Reading")).toBeTruthy();
  });

  it("renders nothing while inactive", () => {
    const { container } = render(<AgentThinking active={false} />);
    expect(container.childElementCount).toBe(0);
  });
});
