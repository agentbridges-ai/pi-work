import { beforeEach, describe, expect, it } from "vitest";
import type { RbacAuditEntry, RbacDepartment } from "../api.js";
import { setUiCopyLanguage } from "../ui-copy.js";
import {
  auditSummary,
  departmentNames,
  errorMessage,
  flattenVisibleDepartments,
  roleNames,
} from "./rbac-admin-utils.js";

function department(id: string, parentId: string | null, sortOrder: number): RbacDepartment {
  return {
    id,
    parentId,
    name: id,
    sortOrder,
    source: "local",
    externalId: null,
    roleIds: [],
    userCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("RBAC admin helpers", () => {
  beforeEach(() => setUiCopyLanguage("en-US"));

  it("flattens visible departments in stable tree order", () => {
    const rows = flattenVisibleDepartments(
      [department("child", "root", 0), department("second", null, 2), department("root", null, 1)],
      new Set(),
    );
    expect(rows.map(({ id, depth }) => [id, depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["second", 0],
    ]);
  });

  it("does not descend into collapsed departments", () => {
    const rows = flattenVisibleDepartments(
      [department("root", null, 0), department("child", "root", 0)],
      new Set(["root"]),
    );
    expect(rows.map((row) => row.id)).toEqual(["root"]);
    expect(rows[0].hasChildren).toBe(true);
  });

  it("uses localized fallbacks for missing assignments", () => {
    expect(roleNames([], [])).toBeTruthy();
    expect(departmentNames([], [])).toBe(roleNames([], []));
  });

  it("formats known audit actions with the actor and target", () => {
    const entry = {
      actorDisplayName: "Admin",
      action: "department.create",
      resourceName: "Engineering",
    } as RbacAuditEntry;
    expect(auditSummary(entry)).toContain("Admin");
    expect(auditSummary(entry)).toContain("Engineering");
  });

  it("normalizes thrown values", () => {
    expect(errorMessage(new Error("failed"))).toBe("failed");
    expect(errorMessage(42)).toBe("42");
  });
});
