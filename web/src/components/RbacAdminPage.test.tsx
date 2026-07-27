// @vitest-environment jsdom
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import { setUiCopyLanguage } from "../ui-copy.js";

beforeEach(() => setUiCopyLanguage("zh-CN"));

const mockApi = vi.hoisted(() => ({
  getRbacBootstrap: vi.fn(),
  listRbacUsers: vi.fn(),
  createRbacDepartment: vi.fn(),
  updateRbacDepartment: vi.fn(),
  deleteRbacDepartment: vi.fn(),
  putRbacDepartmentRoles: vi.fn(),
  createRbacRole: vi.fn(),
  updateRbacRole: vi.fn(),
  deleteRbacRole: vi.fn(),
  putRbacRolePermissions: vi.fn(),
  putRbacUserDepartments: vi.fn(),
  putRbacUserRoles: vi.fn(),
  putRbacUserPassword: vi.fn(),
  getRbacAudit: vi.fn(),
  createRbacUser: vi.fn(),
  putRbacSettings: vi.fn(),
}));

const mockNavigateHome = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastDanger = vi.hoisted(() => vi.fn());

vi.mock("@heroui/react", () => ({
  Modal: Object.assign(({ children }: { children: ReactNode }) => <>{children}</>, {
    Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Container: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Dialog: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div role="dialog" className={className}>
        {children}
      </div>
    ),
  }),
  Select: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Trigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
    Value: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Indicator: () => <span />,
    Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }),
  ListBox: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Item: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }),
  Switch: Object.assign(
    ({
      children,
      isSelected,
      onChange,
      isDisabled,
      ...props
    }: {
      children: ReactNode;
      isSelected?: boolean;
      isDisabled?: boolean;
      onChange?: (value: boolean) => void;
    }) => (
      <button
        type="button"
        role="switch"
        aria-checked={isSelected ? "true" : "false"}
        disabled={isDisabled}
        onClick={() => onChange?.(!isSelected)}
        {...props}
      >
        {children}
      </button>
    ),
    {
      Control: ({ children }: { children: ReactNode }) => <span>{children}</span>,
      Thumb: () => <span />,
      Content: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    },
  ),
  Toast: {
    Provider: () => null,
    toast: {
      success: (...args: unknown[]) => mockToastSuccess(...args),
      danger: (...args: unknown[]) => mockToastDanger(...args),
      warning: (...args: unknown[]) => mockToastDanger(...args),
    },
  },
}));

vi.mock("../api.js", () => ({
  api: mockApi,
}));

vi.mock("../utils/routing.js", () => ({
  navigateHome: (...args: unknown[]) => mockNavigateHome(...args),
}));

import { RbacAdminPage } from "./RbacAdminPage.js";

function bootstrapData() {
  return {
    current: {
      userId: "admin-user",
      username: "admin@example.test",
      displayName: "Admin",
      orgId: "local",
      orgName: "Local",
      roles: ["系统管理员"],
      permissions: ["admin:access"],
      departments: [{ id: "dept-root", name: "默认组织", parentId: null, primary: true }],
    },
    departments: [
      {
        id: "dept-root",
        parentId: null,
        name: "默认组织",
        sortOrder: 0,
        source: "system",
        externalId: null,
        roleIds: ["role-system-admin"],
        userCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "dept-engineering",
        parentId: "dept-root",
        name: "研发部",
        sortOrder: 10,
        source: "local",
        externalId: null,
        roleIds: [],
        userCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    roles: [
      {
        id: "role-system-admin",
        name: "系统管理员",
        description: "拥有系统管理后台访问权限",
        system: true,
        permissionKeys: ["admin:access"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "role-member",
        name: "普通成员",
        description: "默认成员角色",
        system: false,
        permissionKeys: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    permissions: [
      {
        key: "admin:access",
        name: "进入管理后台",
        description: "允许进入管理后台并进行管理操作",
        category: "system",
      },
    ],
    users: [],
    audit: [
      {
        id: "audit-1",
        actorUserId: "admin-user",
        actorDisplayName: "Admin",
        action: "user.roles.replace",
        resourceType: "user",
        resourceId: "ada",
        resourceName: "Ada",
        metadata: { roleIds: ["role-member"] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    settings: {
      registrationEnabled: true,
    },
  };
}

function usersPage() {
  return {
    users: [
      {
        userId: "admin-user",
        username: "admin@example.test",
        displayName: "Admin",
        email: "admin@example.test",
        orgId: "local",
        orgName: "Local",
        roleIds: ["role-system-admin"],
        departmentIds: ["dept-root"],
        primaryDepartmentId: "dept-root",
        permissions: ["admin:access"],
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
      {
        userId: "ada",
        username: "ada@example.test",
        displayName: "Ada",
        email: "ada@example.test",
        orgId: "local",
        orgName: "Local",
        roleIds: [],
        departmentIds: ["dept-engineering"],
        primaryDepartmentId: "dept-engineering",
        permissions: [],
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    total: 2,
    cursor: 0,
    limit: 25,
    nextCursor: 2,
    hasMore: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getRbacBootstrap.mockResolvedValue(bootstrapData());
  mockApi.listRbacUsers.mockResolvedValue(usersPage());
  mockApi.putRbacUserDepartments.mockResolvedValue({ ok: true });
  mockApi.putRbacUserRoles.mockResolvedValue({ ok: true });
  mockApi.putRbacUserPassword.mockResolvedValue({ ok: true });
  mockApi.createRbacUser.mockResolvedValue({ user: usersPage().users[1] });
  mockApi.putRbacSettings.mockResolvedValue({ settings: { registrationEnabled: false } });
  mockApi.updateRbacRole.mockResolvedValue({ role: bootstrapData().roles[1] });
  mockApi.putRbacRolePermissions.mockResolvedValue({
    role: { ...bootstrapData().roles[1], permissionKeys: ["admin:access"] },
  });
});

describe("RbacAdminPage", () => {
  it("renders user management by default and keeps department tree inside members tab", async () => {
    render(<RbacAdminPage />);

    expect(await screen.findByText("权限管理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回工作台" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("tab", { name: "用户管理" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("tab", { name: "用户管理" })).not.toHaveClass("rounded-lg");
    expect(screen.getByRole("button", { name: "新建用户" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(screen.getByRole("button", { name: "新建用户" })).not.toHaveClass("rounded-lg");
    expect(screen.getAllByText("用户管理").length).toBeGreaterThan(0);
    expect(screen.queryByText("部门树")).not.toBeInTheDocument();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(mockApi.listRbacUsers).toHaveBeenCalledWith({
      cursor: 0,
      limit: 25,
      departmentId: "all",
      query: "",
    });

    fireEvent.click(screen.getByRole("tab", { name: "成员与部门" }));
    expect(await screen.findByText("部门树")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加已有用户" })).toHaveClass(
      "rounded-[var(--piwork-control-radius)]",
    );
    expect(document.querySelector('button[aria-current="true"]')).toHaveTextContent("默认组织");
    expect(screen.queryByText("全部成员")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "角色权限" }));

    expect(screen.queryByText("部门树")).not.toBeInTheDocument();
    expect(screen.getByText("普通成员")).toHaveClass("truncate", "overflow-visible");
  });

  it("creates users from the user management tab", async () => {
    render(<RbacAdminPage />);

    fireEvent.click(await screen.findByRole("button", { name: "新建用户" }));
    expect(screen.queryByText("主部门")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "Grace" } });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "Grace@Example.Test" } });
    fireEvent.change(screen.getByLabelText("初始密码"), { target: { value: "secure-password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "secure-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(mockApi.createRbacUser).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "Grace",
          email: "grace@example.test",
          password: "secure-password",
          departmentIds: ["dept-root"],
        }),
      );
    });
  });

  it("renders a clean 403 state when backend denies access", async () => {
    mockApi.getRbacBootstrap.mockRejectedValue(new Error("Forbidden"));

    render(<RbacAdminPage />);

    expect(await screen.findByText("没有管理后台权限")).toBeInTheDocument();
    expect(screen.getByText("请联系管理员开通权限。")).toBeInTheDocument();
  });

  it("edits user departments as removable tags and resets password from the modal", async () => {
    render(<RbacAdminPage />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑 Ada" }));
    expect(screen.getByRole("dialog", { hidden: true })).toBeInTheDocument();
    expect(screen.getAllByText("研发部").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    fireEvent.change(await screen.findByLabelText(/新密码/), {
      target: { value: "new-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    await waitFor(() => {
      expect(mockApi.putRbacUserPassword).toHaveBeenCalledWith("ada", "new-secure-password");
    });
  });

  it("opens department actions from the hovered action menu and creates a child department in a dialog", async () => {
    mockApi.createRbacDepartment.mockResolvedValue({ department: bootstrapData().departments[1] });
    render(<RbacAdminPage />);

    fireEvent.click(await screen.findByRole("tab", { name: "成员与部门" }));
    fireEvent.click(await screen.findByRole("button", { name: "默认组织 操作" }));
    fireEvent.click(screen.getByRole("button", { name: "新建子部门" }));
    fireEvent.change(screen.getByLabelText(/部门名称/), { target: { value: "产品部" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(mockApi.createRbacDepartment).toHaveBeenCalledWith({
        name: "产品部",
        parentId: "dept-root",
        sortOrder: 0,
      });
    });
  });

  it("edits role permissions in a dialog", async () => {
    render(<RbacAdminPage />);

    fireEvent.click(await screen.findByRole("tab", { name: "角色权限" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑角色 普通成员" }));
    const dialog = screen.getByText("编辑角色").closest("div");
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/进入管理后台/));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(mockApi.updateRbacRole).toHaveBeenCalledWith("role-member", {
        name: "普通成员",
        description: "默认成员角色",
      });
      expect(mockApi.putRbacRolePermissions).toHaveBeenCalledWith("role-member", ["admin:access"]);
    });
  });

  it("shows Chinese audit summaries with technical details collapsed", async () => {
    render(<RbacAdminPage />);

    fireEvent.click(await screen.findByRole("tab", { name: "审计" }));

    expect(screen.getByText("Admin 调整了成员 Ada 的角色")).toBeInTheDocument();
    const summary = screen.getByText("记录明细");
    expect(summary).toBeInTheDocument();
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("updates system settings with the component switch", async () => {
    render(<RbacAdminPage />);

    fireEvent.click(await screen.findByRole("tab", { name: "系统设置" }));
    fireEvent.click(screen.getByRole("switch", { name: "允许自主注册" }));

    await waitFor(() => {
      expect(mockApi.putRbacSettings).toHaveBeenCalledWith({ registrationEnabled: false });
    });
  });

  it("exposes selected tab semantics and supports arrow-key navigation", async () => {
    render(<RbacAdminPage />);

    const usersTab = await screen.findByRole("tab", { name: "用户管理" });
    const membersTab = screen.getByRole("tab", { name: "成员与部门" });
    expect(screen.getByRole("tablist", { name: "权限管理分区" })).toBeInTheDocument();
    expect(usersTab).toHaveAttribute("aria-selected", "true");
    expect(usersTab).toHaveAttribute("tabindex", "0");
    expect(membersTab).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(usersTab, { key: "ArrowRight" });

    expect(membersTab).toHaveFocus();
    expect(membersTab).toHaveAttribute("aria-selected", "true");
    expect(usersTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "rbac-tab-members");
  });

  it("provides stable accessible names for each search field", async () => {
    render(<RbacAdminPage />);

    const userSearch = await screen.findByRole("searchbox", { name: "搜索用户" });
    await waitFor(() => expect(userSearch).toHaveFocus());
    fireEvent.click(screen.getByRole("tab", { name: "成员与部门" }));
    const memberSearch = screen.getByRole("searchbox", { name: "搜索成员" });
    await waitFor(() => expect(memberSearch).toHaveFocus());
    fireEvent.click(screen.getAllByText("研发部")[0]);
    await waitFor(() => expect(memberSearch).toHaveFocus());
    fireEvent.click(screen.getByRole("tab", { name: "审计" }));
    const auditSearch = screen.getByRole("searchbox", { name: "搜索审计记录" });
    await waitFor(() => expect(auditSearch).toHaveFocus());
  });

  it("focuses the user lookup when the add-member search dialog opens", async () => {
    render(<RbacAdminPage />);

    await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("tab", { name: "成员与部门" }));
    fireEvent.click(screen.getByRole("button", { name: "添加已有用户" }));

    const search = await screen.findByRole("searchbox", { name: /目标用户/ });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it("uses English Agent terminology and locale-aware audit dates", async () => {
    setUiCopyLanguage("en-US");
    render(<RbacAdminPage />);

    expect(await screen.findByRole("tab", { name: "Agent governance" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Audit" }));
    const expectedDate = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date("2026-01-01T00:00:00.000Z"));
    expect(screen.getByText(expectedDate)).toHaveAttribute("datetime", "2026-01-01T00:00:00.000Z");
  });

  it("has no axe violations on the default management surface", async () => {
    const { container } = render(<RbacAdminPage />);
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
