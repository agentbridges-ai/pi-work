// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getPreview, getToolActionLabel, getToolLabel, ToolBlock } from "./ToolBlock.js";

describe("Pi ToolBlock", () => {
  it("recognizes the four trusted native tool names", () => {
    expect(getPreview("read", { path: "src/main.ts" })).toBe("src/main.ts");
    expect(getPreview("write", { path: "src/main.ts" })).toBe("src/main.ts");
    expect(getPreview("edit", { path: "src/main.ts" })).toBe("src/main.ts");
    expect(getPreview("bash", { command: "git status" })).toBe("git status");
  });

  it("displays managed MCP names without SDK transport terminology", () => {
    expect(getToolLabel("mcp__docs__lookup")).toBe("docs / lookup");
    expect(getToolActionLabel("mcp__docs__lookup")).toMatch(/连接|connection/i);
  });

  it("renders native read input details", () => {
    render(
      <ToolBlock
        name="read"
        input={{ path: "README.md", offset: 10, limit: 20 }}
        toolUseId="tool-1"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("README.md")).toHaveLength(2);
    expect(screen.getByText("offset: 10")).toBeTruthy();
    expect(screen.getByText("limit: 20")).toBeTruthy();
  });

  it("renders every edit in Pi's atomic edits array", () => {
    render(
      <ToolBlock
        name="edit"
        input={{
          path: "src/main.ts",
          edits: [
            { oldText: "const one = 1;", newText: "const one = 2;" },
            { oldText: "const two = 2;", newText: "const two = 3;" },
          ],
        }}
        toolUseId="tool-edit"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/编辑 1\/2|Edit 1\/2/)).toBeTruthy();
    expect(screen.getByText(/编辑 2\/2|Edit 2\/2/)).toBeTruthy();
  });
});
