import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

describe("ChatView Pi interaction wiring", () => {
  it("renders native interactions in the composer layer", () => {
    expect(source).toContain("pendingInteractions");
    expect(source).toContain("<InteractionCard");
    expect(source).not.toContain("pendingPermissions");
    expect(source).not.toContain("PermissionBanner");
  });

  it("keeps User Space session state in Pi camel-case fields", () => {
    expect(source).toContain("userSpaces");
    expect(source).toContain("userSpace:");
    expect(source).not.toContain("backend_type");
  });
});
