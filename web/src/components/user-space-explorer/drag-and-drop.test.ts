import { describe, expect, it } from "vitest";
import type { TreeNode } from "../../api.js";
import type { WorkspaceEntrySelection } from "./model.js";
import {
  validateAgentEntryDrop,
  validateWorkspaceEntryDrop,
  workspaceDragOperationFromModifiers,
  workspaceDragScrollDelta,
} from "./drag-and-drop.js";

function workspaceEntry(
  path: string,
  kind: "file" | "directory" = "file",
  mountId = "uw-1",
): WorkspaceEntrySelection {
  return {
    mountId,
    entry: { path, name: path.split("/").pop() || path, kind },
  };
}

function agentEntry(path: string, type: "file" | "directory" = "file"): TreeNode {
  return { path, name: path.split("/").pop() || path, type };
}

describe("workspace explorer drag and drop", () => {
  it("uses the VS Code copy modifier for each desktop platform", () => {
    expect(workspaceDragOperationFromModifiers({ altKey: true, ctrlKey: false }, true)).toBe(
      "copy",
    );
    expect(workspaceDragOperationFromModifiers({ altKey: false, ctrlKey: true }, true)).toBe(
      "move",
    );
    expect(workspaceDragOperationFromModifiers({ altKey: false, ctrlKey: true }, false)).toBe(
      "copy",
    );
  });

  it("rejects no-op, cross-mount, self, and descendant moves", () => {
    expect(
      validateWorkspaceEntryDrop([workspaceEntry("notes/a.txt")], "uw-1", "notes", "move"),
    ).toEqual({ valid: false, reason: "same-parent" });
    expect(
      validateWorkspaceEntryDrop([workspaceEntry("a.txt")], "uw-2", "archive", "move"),
    ).toEqual({ valid: false, reason: "different-mount" });
    expect(
      validateWorkspaceEntryDrop([workspaceEntry("notes", "directory")], "uw-1", "notes", "move"),
    ).toEqual({ valid: false, reason: "self" });
    expect(
      validateWorkspaceEntryDrop(
        [workspaceEntry("notes", "directory")],
        "uw-1",
        "notes/archive",
        "move",
      ),
    ).toEqual({ valid: false, reason: "descendant" });
  });

  it("allows copying beside the source while retaining recursive safety", () => {
    expect(
      validateWorkspaceEntryDrop([workspaceEntry("notes/a.txt")], "uw-1", "notes", "copy"),
    ).toEqual({ valid: true });
    expect(
      validateWorkspaceEntryDrop(
        [workspaceEntry("notes", "directory")],
        "uw-1",
        "notes/archive",
        "copy",
      ),
    ).toEqual({ valid: false, reason: "descendant" });
  });

  it("applies the same no-op and recursive guards to Agent space", () => {
    expect(validateAgentEntryDrop([agentEntry("src/a.ts")], "src")).toEqual({
      valid: false,
      reason: "same-parent",
    });
    expect(validateAgentEntryDrop([agentEntry("src", "directory")], "src/deep")).toEqual({
      valid: false,
      reason: "descendant",
    });
    expect(validateAgentEntryDrop([agentEntry("src/a.ts")], "archive")).toEqual({ valid: true });
  });

  it("accelerates auto-scroll only inside the upper and lower edge zones", () => {
    const bounds = { top: 100, bottom: 500 };
    expect(workspaceDragScrollDelta(100, bounds)).toBe(-14);
    expect(workspaceDragScrollDelta(130, bounds)).toBeLessThan(0);
    expect(workspaceDragScrollDelta(300, bounds)).toBe(0);
    expect(workspaceDragScrollDelta(470, bounds)).toBeGreaterThan(0);
    expect(workspaceDragScrollDelta(500, bounds)).toBe(14);
  });
});
