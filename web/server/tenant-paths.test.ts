import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getTenantKnowledgeRoot,
  getTenantSessionDir,
  getTenantUserDataRoot,
} from "./local-paths.js";

const previous = process.env.PIWORK_DATA_ROOT;
afterEach(() => {
  if (previous === undefined) delete process.env.PIWORK_DATA_ROOT;
  else process.env.PIWORK_DATA_ROOT = previous;
});

describe("tenant-aware runtime paths", () => {
  it("nests users, sessions and knowledge below a validated tenant root", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-tenants-"));
    process.env.PIWORK_DATA_ROOT = root;
    const userRoot = getTenantUserDataRoot("tenant-1", "user-1");
    expect(userRoot).toBe(join(realpathSync(root), "tenants", "tenant-1", "users", "user-1"));
    expect(
      getTenantSessionDir("tenant-1", "user-1", "11111111-1111-4111-8111-111111111111"),
    ).toContain("/tenants/tenant-1/users/user-1/sessions/");
    expect(getTenantKnowledgeRoot("tenant-1", "knowledge-1")).toContain(
      "/tenants/tenant-1/knowledge/knowledge-1",
    );
  });

  it("rejects path-shaped tenant identifiers", () => {
    expect(() => getTenantUserDataRoot("../other", "user-1")).toThrow("Invalid tenant id");
  });
});
