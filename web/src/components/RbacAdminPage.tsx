import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  api,
  type RbacAuditEntry,
  type RbacBootstrap,
  type RbacDepartment,
  type RbacPermission,
  type RbacRole,
  type RbacSystemSettings,
  type RbacUser,
  type RbacUserPage,
} from "../api.js";
import { navigateHome } from "../utils/routing.js";
import { uiCopy } from "../ui-copy.js";
import { AgentGovernancePanel } from "./AgentGovernancePanel.js";
import { useAutoFocusSearchInput } from "./use-auto-focus-search-input.js";
import {
  DropdownMotion,
  ListBoxEngine as ListBox,
  ModalEngine as Modal,
  SelectEngine as Select,
  SwitchEngine as Switch,
  ToastEngine as Toast,
} from "./ui/index.js";
import {
  auditSummary,
  departmentLabel,
  departmentNames,
  errorMessage as errMessage,
  flattenVisibleDepartments,
  formatRbacDate as formatDate,
  permissionNames,
  roleNames,
  type FlatDepartment,
} from "./rbac-admin-utils.js";

type RbacTab = "users" | "members" | "roles" | "agents" | "settings" | "audit";
const RBAC_TABS: readonly RbacTab[] = ["users", "members", "roles", "agents", "settings", "audit"];
type RbacModal =
  | { type: "department-create"; parentId: string | null }
  | { type: "department-edit"; department: RbacDepartment }
  | { type: "department-delete"; department: RbacDepartment }
  | { type: "department-add-user"; department: RbacDepartment }
  | { type: "user-create" }
  | { type: "user-edit"; user: RbacUser }
  | { type: "role-create" }
  | { type: "role-edit"; role: RbacRole }
  | null;

const PAGE_SIZE = 25;
const rbacCopy = uiCopy.rbacAdmin;
const EMPTY_DEPARTMENTS: RbacDepartment[] = [];
const EMPTY_ROLES: RbacRole[] = [];
const EMPTY_PERMISSIONS: RbacPermission[] = [];
const EMPTY_AUDIT: RbacAuditEntry[] = [];

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

export function RbacAdminPage() {
  const [bootstrap, setBootstrap] = useState<RbacBootstrap | null>(null);
  const [usersPage, setUsersPage] = useState<RbacUserPage>({
    users: [],
    total: 0,
    cursor: 0,
    limit: PAGE_SIZE,
    nextCursor: 0,
    hasMore: false,
  });
  const [loading, setLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<RbacTab>("users");
  const [memberQuery, setMemberQuery] = useState("");
  const debouncedMemberQuery = useDebouncedValue(memberQuery, 250);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string>("all");
  const [collapsedDepartmentIds, setCollapsedDepartmentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [departmentMenuId, setDepartmentMenuId] = useState("");
  const [modal, setModal] = useState<RbacModal>(null);

  const departments = bootstrap?.departments ?? EMPTY_DEPARTMENTS;
  const roles = bootstrap?.roles ?? EMPTY_ROLES;
  const permissions = bootstrap?.permissions ?? EMPTY_PERMISSIONS;
  const audit = bootstrap?.audit ?? EMPTY_AUDIT;
  const systemSettings = bootstrap?.settings || { registrationEnabled: true };
  const selectedDepartment =
    departments.find((department) => department.id === selectedDepartmentId) || null;
  const visibleDepartments = useMemo(
    () => flattenVisibleDepartments(departments, collapsedDepartmentIds),
    [collapsedDepartmentIds, departments],
  );

  const loadBootstrap = useCallback(async () => {
    setError("");
    const next = await api.getRbacBootstrap();
    setBootstrap(next);
    setSelectedDepartmentId((current) =>
      current === "all" || next.departments.some((department) => department.id === current)
        ? current
        : "all",
    );
  }, []);

  const loadUsers = useCallback(
    async (cursor = 0) => {
      setUsersLoading(true);
      setError("");
      try {
        const activeDepartmentId =
          tab === "members"
            ? selectedDepartmentId !== "all"
              ? selectedDepartmentId
              : departments[0]?.id || "all"
            : "all";
        const page = await api.listRbacUsers({
          cursor,
          limit: PAGE_SIZE,
          departmentId: activeDepartmentId,
          query: debouncedMemberQuery,
        });
        setUsersPage(page);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setUsersLoading(false);
      }
    },
    [debouncedMemberQuery, departments, selectedDepartmentId, tab],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadBootstrap()
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadBootstrap]);

  useEffect(() => {
    if (!bootstrap) return;
    void loadUsers(0);
  }, [bootstrap, loadUsers]);

  useEffect(() => {
    if (!bootstrap) return;
    if (tab === "users" && selectedDepartmentId !== "all") {
      setSelectedDepartmentId("all");
    } else if (tab === "members" && selectedDepartmentId === "all" && departments[0]) {
      setSelectedDepartmentId(departments[0].id);
    }
  }, [bootstrap, departments, selectedDepartmentId, tab]);

  const switchTab = useCallback(
    (nextTab: RbacTab) => {
      setTab(nextTab);
      setDepartmentMenuId("");
      if (nextTab === "users") setSelectedDepartmentId("all");
      if (nextTab === "members") {
        setSelectedDepartmentId((current) =>
          current !== "all" ? current : departments[0]?.id || "all",
        );
      }
    },
    [departments],
  );

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentTab: RbacTab) => {
      const currentIndex = RBAC_TABS.indexOf(currentTab);
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % RBAC_TABS.length;
      if (event.key === "ArrowLeft")
        nextIndex = (currentIndex - 1 + RBAC_TABS.length) % RBAC_TABS.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = RBAC_TABS.length - 1;
      if (nextIndex === null) return;

      event.preventDefault();
      const nextTab = RBAC_TABS[nextIndex];
      switchTab(nextTab);
      document.getElementById(`rbac-tab-${nextTab}`)?.focus();
    },
    [switchTab],
  );

  const refreshAfterWrite = useCallback(
    async (message: string) => {
      await loadBootstrap();
      await loadUsers(usersPage.cursor);
      Toast.toast.success(message, { timeout: 2600 });
    },
    [loadBootstrap, loadUsers, usersPage.cursor],
  );

  const withSave = useCallback(
    async (action: () => Promise<void>, message: string) => {
      setSaving(true);
      setError("");
      try {
        await action();
        setModal(null);
        await refreshAfterWrite(message);
      } catch (err) {
        const messageText = errMessage(err);
        setError(messageText);
        Toast.toast.danger(messageText, { timeout: 4200 });
      } finally {
        setSaving(false);
      }
    },
    [refreshAfterWrite],
  );

  const toggleDepartmentCollapse = (departmentId: string) => {
    setCollapsedDepartmentIds((current) => {
      const next = new Set(current);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  };

  const unauthorized = /forbidden|403/i.test(error);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <Toast.Provider placement="top" />
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <button
          type="button"
          aria-label={rbacCopy.dashboard.back}
          onClick={() => navigateHome(false)}
          className="flex h-9 w-9 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {rbacCopy.dashboard.title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {rbacCopy.dashboard.subtitle}
          </div>
        </div>
      </header>
      {departmentMenuId && (
        <button
          type="button"
          aria-label={rbacCopy.closeDepartmentMenu}
          onClick={() => setDepartmentMenuId("")}
          className="fixed inset-0 z-10 cursor-default"
        />
      )}

      {loading && !bootstrap ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          {rbacCopy.dashboard.loading}
        </div>
      ) : unauthorized ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-md rounded-xl border border-border bg-card p-5 text-center">
            <ShieldCheck
              className="mx-auto mb-3 h-8 w-8 text-muted-foreground"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <div className="text-base font-semibold text-foreground">
              {rbacCopy.dashboard.noPermission}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {rbacCopy.dashboard.noPermissionDescription}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <nav
            aria-label={rbacCopy.tabs.label}
            className="shrink-0 border-b border-border bg-card px-4 py-3"
          >
            <div
              role="tablist"
              aria-label={rbacCopy.tabs.label}
              className="flex flex-wrap items-center gap-2"
            >
              <TabButton
                tab="users"
                active={tab === "users"}
                icon={<Users className="h-4 w-4" aria-hidden="true" />}
                label={rbacCopy.tabs.users}
                onClick={() => switchTab("users")}
                onKeyDown={handleTabKeyDown}
              />
              <TabButton
                tab="members"
                active={tab === "members"}
                icon={<Building2 className="h-4 w-4" aria-hidden="true" />}
                label={rbacCopy.tabs.members}
                onClick={() => switchTab("members")}
                onKeyDown={handleTabKeyDown}
              />
              <TabButton
                tab="roles"
                active={tab === "roles"}
                icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                label={rbacCopy.tabs.roles}
                onClick={() => switchTab("roles")}
                onKeyDown={handleTabKeyDown}
              />
              <TabButton
                tab="agents"
                active={tab === "agents"}
                icon={<Bot className="h-4 w-4" aria-hidden="true" />}
                label={rbacCopy.tabs.agents}
                onClick={() => switchTab("agents")}
                onKeyDown={handleTabKeyDown}
              />
              <TabButton
                tab="settings"
                active={tab === "settings"}
                icon={<Settings className="h-4 w-4" aria-hidden="true" />}
                label={rbacCopy.tabs.settings}
                onClick={() => switchTab("settings")}
                onKeyDown={handleTabKeyDown}
              />
              <TabButton
                tab="audit"
                active={tab === "audit"}
                icon={<Check className="h-4 w-4" aria-hidden="true" />}
                label={rbacCopy.tabs.audit}
                onClick={() => switchTab("audit")}
                onKeyDown={handleTabKeyDown}
              />
            </div>
          </nav>

          {error && !unauthorized && (
            <div
              role="alert"
              className="mx-4 mt-3 rounded-lg border border-danger/35 bg-danger-muted px-3 py-2 text-sm text-danger"
            >
              {error}
            </div>
          )}

          <div
            id="rbac-active-panel"
            role="tabpanel"
            aria-labelledby={`rbac-tab-${tab}`}
            tabIndex={0}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {tab === "users" && (
              <UserManagementView
                departments={departments}
                roles={roles}
                permissions={permissions}
                usersPage={usersPage}
                query={memberQuery}
                loading={usersLoading}
                onQuery={setMemberQuery}
                onOpenModal={setModal}
                onPage={(cursor) => void loadUsers(cursor)}
              />
            )}
            {tab === "members" && (
              <MembersView
                departments={departments}
                visibleDepartments={visibleDepartments}
                roles={roles}
                permissions={permissions}
                usersPage={usersPage}
                selectedDepartmentId={selectedDepartmentId}
                selectedDepartment={selectedDepartment}
                query={memberQuery}
                loading={usersLoading}
                saving={saving}
                departmentMenuId={departmentMenuId}
                collapsedDepartmentIds={collapsedDepartmentIds}
                onQuery={setMemberQuery}
                onDepartmentMenu={setDepartmentMenuId}
                onSelectDepartment={(id) => {
                  setSelectedDepartmentId(id);
                  setDepartmentMenuId("");
                }}
                onToggleDepartment={toggleDepartmentCollapse}
                onOpenModal={setModal}
                onPage={(cursor) => void loadUsers(cursor)}
              />
            )}
            {tab === "roles" && (
              <RolesView roles={roles} permissions={permissions} onOpenModal={setModal} />
            )}
            {tab === "agents" && <AgentGovernancePanel />}
            {tab === "settings" && (
              <SystemSettingsView settings={systemSettings} saving={saving} onSave={withSave} />
            )}
            {tab === "audit" && <AuditView audit={audit} />}
          </div>
        </div>
      )}

      {modal && (
        <RbacDialog
          modal={modal}
          departments={departments}
          roles={roles}
          permissions={permissions}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={withSave}
        />
      )}
    </div>
  );
}

function TabButton({
  tab,
  active,
  icon,
  label,
  onClick,
  onKeyDown,
}: {
  tab: RbacTab;
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, tab: RbacTab) => void;
}) {
  return (
    <button
      id={`rbac-tab-${tab}`}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls="rbac-active-panel"
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      onKeyDown={(event) => onKeyDown(event, tab)}
      className={`flex h-9 items-center gap-2 rounded-[var(--piwork-control-radius)] px-3 text-sm font-semibold transition-colors ${
        active ? "bg-accent text-primary" : "text-muted-foreground hover:bg-muted"
      } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
    >
      {icon}
      {label}
    </button>
  );
}

function UserManagementView(props: {
  departments: RbacDepartment[];
  roles: RbacRole[];
  permissions: RbacPermission[];
  usersPage: RbacUserPage;
  query: string;
  loading: boolean;
  onQuery: (value: string) => void;
  onOpenModal: (modal: RbacModal) => void;
  onPage: (cursor: number) => void;
}) {
  const searchInputRef = useAutoFocusSearchInput<HTMLInputElement>(true, "users");
  return (
    <section className="min-h-0 flex-1 overflow-hidden bg-background p-4">
      <div className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-card">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {rbacCopy.tabs.users}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {rbacCopy.allMembersCount(props.usersPage.total)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => props.onOpenModal({ type: "user-create" })}
            className="inline-flex h-9 items-center gap-2 rounded-[var(--piwork-control-radius)] bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <UserPlus className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            {rbacCopy.user.create}
          </button>
          <label className="flex h-9 min-w-[260px] items-center gap-2 rounded-[var(--piwork-control-radius)] border border-input bg-muted px-3 text-muted-foreground">
            <Search className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              aria-label={rbacCopy.searchUsersLabel}
              value={props.query}
              onChange={(event) => props.onQuery(event.target.value)}
              placeholder={rbacCopy.searchNameOrEmail}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 p-4 pb-0">
          <MemberTable
            departments={props.departments}
            roles={props.roles}
            permissions={props.permissions}
            users={props.usersPage.users}
            loading={props.loading}
            onEdit={(user) => props.onOpenModal({ type: "user-edit", user })}
          />
        </div>
        <PaginationBar page={props.usersPage} loading={props.loading} onPage={props.onPage} />
      </div>
    </section>
  );
}

function MembersView(props: {
  departments: RbacDepartment[];
  visibleDepartments: FlatDepartment[];
  roles: RbacRole[];
  permissions: RbacPermission[];
  usersPage: RbacUserPage;
  selectedDepartmentId: string;
  selectedDepartment: RbacDepartment | null;
  query: string;
  loading: boolean;
  saving: boolean;
  departmentMenuId: string;
  collapsedDepartmentIds: Set<string>;
  onQuery: (value: string) => void;
  onDepartmentMenu: (id: string) => void;
  onSelectDepartment: (id: string) => void;
  onToggleDepartment: (id: string) => void;
  onOpenModal: (modal: RbacModal) => void;
  onPage: (cursor: number) => void;
}) {
  const searchInputRef = useAutoFocusSearchInput<HTMLInputElement>(
    true,
    props.selectedDepartmentId,
  );
  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)]">
      <DepartmentTree
        departments={props.departments}
        visibleDepartments={props.visibleDepartments}
        selectedDepartmentId={props.selectedDepartmentId}
        menuId={props.departmentMenuId}
        collapsedIds={props.collapsedDepartmentIds}
        onMenu={props.onDepartmentMenu}
        onSelect={props.onSelectDepartment}
        onToggle={props.onToggleDepartment}
        onOpenModal={props.onOpenModal}
      />
      <div className="flex min-h-0 min-w-0 flex-col border-l border-border bg-background">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {props.selectedDepartment?.name || rbacCopy.department.selectPlaceholder}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {rbacCopy.department.totalMembers(props.usersPage.total)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!props.selectedDepartment) {
                Toast.toast.danger(rbacCopy.department.selectFirst, { timeout: 3000 });
                return;
              }
              props.onOpenModal({
                type: "department-add-user",
                department: props.selectedDepartment,
              });
            }}
            className="inline-flex h-9 items-center gap-2 rounded-[var(--piwork-control-radius)] bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <UserPlus className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            {rbacCopy.department.addExistingUser}
          </button>
          <label className="flex h-9 min-w-[240px] items-center gap-2 rounded-[var(--piwork-control-radius)] border border-input bg-muted px-3 text-muted-foreground">
            <Search className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              aria-label={rbacCopy.department.searchMembers}
              value={props.query}
              onChange={(event) => props.onQuery(event.target.value)}
              placeholder={rbacCopy.department.searchMembers}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 p-4 pb-0">
          <MemberTable
            departments={props.departments}
            roles={props.roles}
            permissions={props.permissions}
            users={props.usersPage.users}
            loading={props.loading}
            onEdit={(user) => props.onOpenModal({ type: "user-edit", user })}
          />
        </div>
        <PaginationBar page={props.usersPage} loading={props.loading} onPage={props.onPage} />
      </div>
    </section>
  );
}

function DepartmentTree(props: {
  departments: RbacDepartment[];
  visibleDepartments: FlatDepartment[];
  selectedDepartmentId: string;
  menuId: string;
  collapsedIds: Set<string>;
  onMenu: (id: string) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onOpenModal: (modal: RbacModal) => void;
}) {
  return (
    <aside className="min-h-0 border-b border-border bg-muted lg:border-b-0">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Building2 className="h-4 w-4 text-primary" strokeWidth={1.8} aria-hidden="true" />
            {rbacCopy.department.tableTitle}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {props.visibleDepartments.map((department) => (
            <div key={department.id} className="group relative mb-1">
              <div
                className={`flex min-h-9 items-center gap-1 rounded-[var(--piwork-control-radius)] pr-1 text-sm transition-colors ${
                  props.selectedDepartmentId === department.id
                    ? "bg-accent font-semibold text-primary"
                    : "text-foreground hover:bg-muted"
                }`}
                style={{ paddingLeft: 6 + department.depth * 18 }}
              >
                {department.hasChildren ? (
                  <button
                    type="button"
                    aria-label={
                      props.collapsedIds.has(department.id)
                        ? rbacCopy.department.expand
                        : rbacCopy.department.collapse
                    }
                    aria-expanded={!props.collapsedIds.has(department.id)}
                    onClick={() => props.onToggle(department.id)}
                    className="flex h-7 w-6 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground hover:bg-card/80"
                  >
                    {props.collapsedIds.has(department.id) ? (
                      <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  <span aria-hidden="true" className="h-7 w-6 shrink-0" />
                )}
                <button
                  type="button"
                  aria-current={props.selectedDepartmentId === department.id ? "true" : undefined}
                  onClick={() => props.onSelect(department.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                >
                  <Building2
                    className="h-3.5 w-3.5 shrink-0"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{department.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {department.userCount}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={rbacCopy.department.operation(department.name)}
                  aria-expanded={props.menuId === department.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onMenu(props.menuId === department.id ? "" : department.id);
                  }}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground hover:bg-accent ${
                    props.menuId === department.id
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <MoreHorizontal className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>
              <DropdownMotion
                open={props.menuId === department.id}
                className="absolute right-2 top-8 z-20 w-36 overflow-hidden rounded-lg border border-border bg-card py-1 text-sm"
              >
                <MenuButton
                  icon={<Plus className="h-3.5 w-3.5" />}
                  label={rbacCopy.department.createChild}
                  onClick={() => {
                    props.onMenu("");
                    props.onOpenModal({ type: "department-create", parentId: department.id });
                  }}
                />
                <MenuButton
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  label={rbacCopy.department.edit}
                  onClick={() => {
                    props.onMenu("");
                    props.onOpenModal({ type: "department-edit", department });
                  }}
                />
                <MenuButton
                  danger
                  disabled={department.parentId === null}
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  label={rbacCopy.department.delete}
                  onClick={() => {
                    props.onMenu("");
                    props.onOpenModal({ type: "department-delete", department });
                  }}
                />
              </DropdownMotion>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 px-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? "text-danger hover:bg-danger-muted" : "text-foreground hover:bg-muted"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MemberTable({
  departments,
  roles,
  permissions,
  users,
  loading,
  onEdit,
}: {
  departments: RbacDepartment[];
  roles: RbacRole[];
  permissions: RbacPermission[];
  users: RbacUser[];
  loading: boolean;
  onEdit: (user: RbacUser) => void;
}) {
  return (
    <div className="h-full min-h-0 overflow-auto rounded-lg border border-border bg-card">
      <table className="min-w-full table-fixed text-left text-sm">
        <thead className="sticky top-0 bg-card text-xs uppercase text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-[26%] px-4 py-3 font-semibold">{rbacCopy.member.name}</th>
            <th className="w-[24%] px-4 py-3 font-semibold">{rbacCopy.member.department}</th>
            <th className="w-[22%] px-4 py-3 font-semibold">{rbacCopy.member.roles}</th>
            <th className="w-[18%] px-4 py-3 font-semibold">{rbacCopy.member.permissions}</th>
            <th className="w-[10%] px-4 py-3 text-right font-semibold">
              {rbacCopy.member.operations}
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr
              key={user.userId}
              className="border-b border-border/60 transition-colors hover:bg-muted/70"
            >
              <td className="px-4 py-3">
                <div className="truncate font-semibold text-foreground">{user.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {user.email || user.username}
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {departmentNames(user.departmentIds, departments)}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{roleNames(user.roleIds, roles)}</td>
              <td className="px-4 py-3 text-muted-foreground">
                {permissionNames(user.permissions, permissions)}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  aria-label={rbacCopy.member.editUser(user.displayName)}
                  onClick={() => onEdit(user)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
                >
                  <Settings className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                {loading ? rbacCopy.member.loading : rbacCopy.member.matchedEmpty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function PaginationBar({
  page,
  loading,
  onPage,
}: {
  page: RbacUserPage;
  loading: boolean;
  onPage: (cursor: number) => void;
}) {
  const start = page.total === 0 ? 0 : page.cursor + 1;
  const end = page.cursor + page.users.length;
  return (
    <div className="mx-4 mb-4 mt-3 flex shrink-0 items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
      <span>
        {start}-{end} / {page.total}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={loading || page.cursor <= 0}
          onClick={() => onPage(Math.max(0, page.cursor - page.limit))}
          className="h-8 rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          {rbacCopy.pagination.previous}
        </button>
        <button
          type="button"
          disabled={loading || !page.hasMore}
          onClick={() => onPage(page.nextCursor)}
          className="h-8 rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          {rbacCopy.pagination.next}
        </button>
      </div>
    </div>
  );
}

function RolesView({
  roles,
  permissions,
  onOpenModal,
}: {
  roles: RbacRole[];
  permissions: RbacPermission[];
  onOpenModal: (modal: RbacModal) => void;
}) {
  return (
    <section className="min-h-0 flex-1 overflow-auto bg-background p-4">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-foreground">{rbacCopy.role.title}</div>
            <div className="text-xs text-muted-foreground">
              {rbacCopy.role.titleMeta(roles.length, permissions.length)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenModal({ type: "role-create" })}
            className="inline-flex h-9 items-center gap-2 rounded-[var(--piwork-control-radius)] bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
            {rbacCopy.role.create}
          </button>
        </div>
        <table className="min-w-full table-fixed text-left text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr className="border-b border-border">
              <th className="w-[28%] px-4 py-3 font-semibold">{rbacCopy.member.roles}</th>
              <th className="w-[42%] px-4 py-3 font-semibold">{rbacCopy.description}</th>
              <th className="w-[20%] px-4 py-3 font-semibold">{rbacCopy.role.permissions}</th>
              <th className="w-[10%] px-4 py-3 text-right font-semibold">
                {rbacCopy.member.operations}
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id} className="border-b border-border/60 last:border-b-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck
                      className="h-4 w-4 text-primary"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate font-semibold text-foreground overflow-visible">
                      {role.name}
                    </span>
                    {role.system && (
                      <span className="rounded-[var(--piwork-control-radius)] bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                        {rbacCopy.role.system}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {role.description || rbacCopy.noDescription}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {rbacCopy.role.permissionCount(role.permissionKeys.length)}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    aria-label={rbacCopy.role.editRole(role.name)}
                    onClick={() => onOpenModal({ type: "role-edit", role })}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
                  >
                    <Pencil className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SystemSettingsView({
  settings,
  saving,
  onSave,
}: {
  settings: RbacSystemSettings;
  saving: boolean;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const toggleRegistration = (registrationEnabled: boolean) => {
    void onSave(
      async () => {
        await api.putRbacSettings({ registrationEnabled });
      },
      registrationEnabled
        ? rbacCopy.settings.registrationEnabled
        : rbacCopy.settings.registrationDisabled,
    );
  };

  return (
    <section className="min-h-0 flex-1 overflow-auto bg-background p-4">
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-semibold text-foreground">{rbacCopy.settings.title}</div>
          <div className="text-xs text-muted-foreground">{rbacCopy.settings.subtitle}</div>
        </div>
        <div className="divide-y divide-border">
          <div className="flex flex-wrap items-center gap-4 px-4 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">
                {rbacCopy.settings.registrationLabel}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {rbacCopy.settings.registrationDescription}
              </div>
            </div>
            <Switch
              aria-label={rbacCopy.settings.registrationLabel}
              isSelected={settings.registrationEnabled}
              isDisabled={saving}
              onChange={toggleRegistration}
              size="sm"
              className="piwork-switch-contrast shrink-0"
            >
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Content className="sr-only">
                {rbacCopy.settings.registrationLabel}
              </Switch.Content>
            </Switch>
          </div>
        </div>
      </div>
    </section>
  );
}

function AuditView({ audit }: { audit: RbacAuditEntry[] }) {
  const [query, setQuery] = useState("");
  const searchInputRef = useAutoFocusSearchInput<HTMLInputElement>(true, "audit");
  const filteredAudit = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return audit;
    return audit.filter((entry) =>
      [
        auditSummary(entry),
        entry.action,
        entry.actorDisplayName || "",
        entry.actorUserId,
        entry.resourceName || "",
        entry.resourceId,
      ].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [audit, query]);

  return (
    <section className="min-h-0 flex-1 overflow-auto bg-background p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{rbacCopy.audit.title}</div>
          <div className="text-xs text-muted-foreground">
            {rbacCopy.audit.recordCount(filteredAudit.length, audit.length)}
          </div>
        </div>
        <label className="flex h-9 min-w-[260px] items-center gap-2 rounded-[var(--piwork-control-radius)] border border-input bg-muted px-3 text-muted-foreground">
          <Search className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            aria-label={rbacCopy.audit.searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={rbacCopy.audit.searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {filteredAudit.map((entry) => (
          <article
            key={entry.id}
            className="border-b border-border/60 px-4 py-3 text-sm last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">{auditSummary(entry)}</span>
              <time dateTime={entry.createdAt} className="text-xs text-muted-foreground">
                {formatDate(entry.createdAt)}
              </time>
            </div>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                {rbacCopy.audit.detail}
              </summary>
              <div className="mt-2 grid gap-1 rounded-lg bg-muted p-3">
                <div>{rbacCopy.audit.recordId(entry.id)}</div>
                <div>{rbacCopy.audit.actorId(entry.actorUserId)}</div>
                <div>{rbacCopy.audit.resourceId(entry.resourceType, entry.resourceId)}</div>
                <pre className="max-h-40 overflow-auto rounded-md bg-card p-2">
                  {JSON.stringify(entry.metadata, null, 2)}
                </pre>
              </div>
            </details>
          </article>
        ))}
        {filteredAudit.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {audit.length === 0 ? rbacCopy.audit.empty : rbacCopy.audit.matchedEmpty}
          </div>
        )}
      </div>
    </section>
  );
}

function RbacDialog(props: {
  modal: NonNullable<RbacModal>;
  departments: RbacDepartment[];
  roles: RbacRole[];
  permissions: RbacPermission[];
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  if (props.modal.type === "department-create") {
    return <DepartmentFormDialog mode="create" {...props} parentId={props.modal.parentId} />;
  }
  if (props.modal.type === "department-edit") {
    return <DepartmentFormDialog mode="edit" {...props} department={props.modal.department} />;
  }
  if (props.modal.type === "department-delete") {
    return <DeleteDepartmentDialog {...props} department={props.modal.department} />;
  }
  if (props.modal.type === "department-add-user") {
    return <AddUserToDepartmentDialog {...props} department={props.modal.department} />;
  }
  if (props.modal.type === "user-create") {
    return <UserCreateDialog {...props} />;
  }
  if (props.modal.type === "user-edit") {
    return <UserEditDialog {...props} user={props.modal.user} />;
  }
  if (props.modal.type === "role-create") {
    return <RoleFormDialog mode="create" {...props} />;
  }
  return <RoleFormDialog mode="edit" {...props} role={props.modal.role} />;
}

function DialogShell({
  title,
  subtitle,
  children,
  footer,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/30 px-3 py-4"
      >
        <Modal.Container placement="center" size="lg" className="max-h-[88vh] w-full max-w-lg">
          <Modal.Dialog className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex shrink-0 items-start gap-3 border-b border-border px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold text-foreground">{title}</div>
                {subtitle && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
                )}
              </div>
              <button
                type="button"
                aria-label={rbacCopy.close}
                onClick={onClose}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent"
              >
                <X className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">{children}</div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-card px-3.5 py-2.5">
              {footer}
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function RequiredMark() {
  return (
    <span className="ml-0.5 text-danger" aria-hidden="true">
      *
    </span>
  );
}

function AppSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  required = false,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const selected = options.find((option) => option.id === value);
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-semibold text-muted-foreground">
        {label}
        {required && <RequiredMark />}
      </div>
      <Select
        selectedKey={value || "__none__"}
        onSelectionChange={(key) => onChange(String(key || "__none__"))}
        isDisabled={disabled}
        aria-label={label}
        fullWidth
      >
        <Select.Trigger className="h-9 w-full rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent disabled:bg-card">
          <Select.Value>{selected?.label || rbacCopy.none}</Select.Value>
          <Select.Indicator className="ml-auto h-4 w-4 text-disabled-foreground" />
        </Select.Trigger>
        <Select.Popover className="piwork-dropdown-motion z-[var(--piwork-z-popover)] max-h-64 overflow-auto rounded-lg border border-border bg-card p-1 text-sm">
          <ListBox aria-label={label}>
            {options.map((option) => (
              <ListBox.Item
                key={option.id}
                id={option.id}
                textValue={option.label}
                className="cursor-pointer rounded-[var(--piwork-control-radius)] px-2 py-1.5 text-foreground outline-none hover:bg-accent data-[selected=true]:bg-accent data-[selected=true]:font-semibold data-[selected=true]:text-primary"
              >
                {option.label}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  );
}

function DepartmentFormDialog(props: {
  mode: "create" | "edit";
  parentId?: string | null;
  department?: RbacDepartment;
  departments: RbacDepartment[];
  roles: RbacRole[];
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const department = props.department;
  const [name, setName] = useState(department?.name || "");
  const [parentId, setParentId] = useState<string | null>(
    department ? department.parentId : props.parentId || null,
  );
  const [sortOrder, setSortOrder] = useState(String(department?.sortOrder || 0));
  const [roleIds, setRoleIds] = useState<string[]>(department?.roleIds || []);
  const title =
    props.mode === "create" ? rbacCopy.department.createChild : rbacCopy.department.edit;

  const save = () =>
    props.onSave(
      async () => {
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error(rbacCopy.department.emptyName);
        if (props.mode === "create") {
          await api.createRbacDepartment({
            name: trimmedName,
            parentId: parentId || undefined,
            sortOrder: Number(sortOrder) || 0,
          });
        } else if (department) {
          await api.updateRbacDepartment(department.id, {
            name: trimmedName,
            parentId,
            sortOrder: Number(sortOrder) || 0,
          });
          await api.putRbacDepartmentRoles(department.id, roleIds);
        }
      },
      props.mode === "create"
        ? rbacCopy.department.createSuccess
        : rbacCopy.department.updateSuccess,
    );

  return (
    <DialogShell
      title={title}
      subtitle={
        parentId
          ? rbacCopy.department.parentLabel(departmentLabel(parentId, props.departments))
          : rbacCopy.department.root
      }
      onClose={props.onClose}
      footer={
        <DialogFooter
          saving={props.saving}
          onCancel={props.onClose}
          onConfirm={save}
          confirmLabel={rbacCopy.save}
        />
      }
    >
      <Field label={rbacCopy.department.name} value={name} onChange={setName} required />
      <AppSelect
        label={rbacCopy.department.parent}
        value={parentId || "__none__"}
        disabled={department?.parentId === null}
        options={[
          { id: "__none__", label: rbacCopy.none },
          ...props.departments
            .filter((item) => item.id !== department?.id)
            .map((item) => ({ id: item.id, label: item.name })),
        ]}
        onChange={(value) => setParentId(value === "__none__" ? null : value)}
      />
      <Field
        label={rbacCopy.department.sortOrder}
        value={sortOrder}
        onChange={setSortOrder}
        type="number"
      />
      {props.mode === "edit" && (
        <CheckboxGroup
          title={rbacCopy.department.roles}
          values={roleIds}
          options={props.roles.map((role) => ({ value: role.id, label: role.name }))}
          onChange={setRoleIds}
        />
      )}
    </DialogShell>
  );
}

function DeleteDepartmentDialog(props: {
  department: RbacDepartment;
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const [confirmName, setConfirmName] = useState("");
  const matched = confirmName.trim() === props.department.name;
  return (
    <DialogShell
      title={rbacCopy.department.delete}
      subtitle={props.department.name}
      onClose={props.onClose}
      footer={
        <>
          <button
            type="button"
            onClick={props.onClose}
            className="h-9 rounded-[var(--piwork-control-radius)] px-3 text-sm font-semibold text-muted-foreground hover:bg-accent"
          >
            {rbacCopy.cancel}
          </button>
          <button
            type="button"
            disabled={props.saving || !matched}
            onClick={() =>
              void props.onSave(async () => {
                await api.deleteRbacDepartment(props.department.id);
              }, rbacCopy.department.deleteSuccess)
            }
            className="h-9 rounded-[var(--piwork-control-radius)] bg-danger px-3 text-sm font-semibold text-danger-foreground transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {rbacCopy.delete}
          </button>
        </>
      }
    >
      <div className="rounded-lg border border-danger/35 bg-danger-muted px-3 py-2 text-sm text-danger">
        {rbacCopy.department.deleteDescription}
      </div>
      <Field
        label={rbacCopy.department.typeConfirm(props.department.name)}
        value={confirmName}
        onChange={setConfirmName}
      />
    </DialogShell>
  );
}

function AddUserToDepartmentDialog(props: {
  department: RbacDepartment;
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<RbacUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<RbacUser | null>(null);
  const [searching, setSearching] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 180);
  const searchInputRef = useAutoFocusSearchInput<HTMLInputElement>(true, props.department.id);

  useEffect(() => {
    let cancelled = false;
    const needle = debouncedQuery.trim();
    if (!needle) {
      setSuggestions([]);
      return () => {
        cancelled = true;
      };
    }
    setSearching(true);
    api
      .listRbacUsers({ query: needle, limit: 8 })
      .then((page) => {
        if (!cancelled) setSuggestions(page.users);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const choose = (user: RbacUser) => {
    setSelectedUser(user);
    setQuery(user.displayName || user.username);
    setSuggestions([]);
  };

  const add = () => {
    const needle = query.trim();
    if (!needle) {
      Toast.toast.danger(rbacCopy.department.addUser.missing, { timeout: 3000 });
      return;
    }
    const exact =
      selectedUser ||
      suggestions.find(
        (user) => user.displayName === needle || user.username === needle || user.email === needle,
      );
    if (!exact) {
      Toast.toast.danger(rbacCopy.department.addUser.notFound, { timeout: 3600 });
      return;
    }
    if (exact.departmentIds.includes(props.department.id)) {
      Toast.toast.warning(rbacCopy.department.addUser.duplicate, { timeout: 3000 });
      return;
    }
    void props.onSave(async () => {
      await api.putRbacUserDepartments(
        exact.userId,
        Array.from(new Set([...exact.departmentIds, props.department.id])),
      );
    }, rbacCopy.department.addUser.joined);
  };

  return (
    <DialogShell
      title={rbacCopy.department.addUser.title}
      subtitle={props.department.name}
      onClose={props.onClose}
      footer={
        <DialogFooter
          saving={props.saving}
          onCancel={props.onClose}
          onConfirm={add}
          confirmLabel={rbacCopy.add}
        />
      }
    >
      <label className="block text-xs font-semibold text-muted-foreground">
        {rbacCopy.department.addUser.targetUser}
        <RequiredMark />
        <div className="relative mt-1">
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedUser(null);
            }}
            placeholder={rbacCopy.department.addUser.inputPlaceholder}
            className="h-9 w-full rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring"
          />
          {query.trim() && (suggestions.length > 0 || searching) && (
            <div className="absolute left-0 top-10 z-[var(--piwork-z-popover)] w-full overflow-hidden rounded-[var(--piwork-control-radius)] border border-border bg-card py-1 text-sm">
              {searching && (
                <div className="px-3 py-2 text-disabled-foreground">
                  {rbacCopy.department.addUser.searching}
                </div>
              )}
              {!searching &&
                suggestions.map((user) => (
                  <button
                    type="button"
                    key={user.userId}
                    onClick={() => choose(user)}
                    className="block w-full px-3 py-2 text-left hover:bg-accent"
                  >
                    <div className="truncate font-semibold text-foreground">{user.displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {user.email || user.username}
                    </div>
                  </button>
                ))}
            </div>
          )}
        </div>
      </label>
    </DialogShell>
  );
}

function UserCreateDialog(props: {
  departments: RbacDepartment[];
  roles: RbacRole[];
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const defaultDepartmentId = props.departments[0]?.id || "";
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [departmentIds, setDepartmentIds] = useState<string[]>(
    defaultDepartmentId ? [defaultDepartmentId] : [],
  );
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [departmentInput, setDepartmentInput] = useState("");

  const save = () =>
    props.onSave(async () => {
      const trimmedName = displayName.trim();
      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedName) throw new Error(rbacCopy.user.emptyDisplayName);
      if (!trimmedEmail) throw new Error(rbacCopy.user.emptyEmail);
      if (!password) throw new Error(rbacCopy.password.emptyInitial);
      if (password !== confirmPassword) throw new Error(rbacCopy.user.passwordMismatch);
      const nextDepartments = departmentIds.length
        ? departmentIds
        : defaultDepartmentId
          ? [defaultDepartmentId]
          : [];
      await api.createRbacUser({
        displayName: trimmedName,
        email: trimmedEmail,
        password,
        departmentIds: nextDepartments,
        roleIds,
      });
    }, rbacCopy.user.createSuccess);

  return (
    <DialogShell
      title={rbacCopy.user.create}
      subtitle={rbacCopy.user.createSubtitle}
      onClose={props.onClose}
      footer={
        <DialogFooter
          saving={props.saving}
          onCancel={props.onClose}
          onConfirm={save}
          confirmLabel={rbacCopy.create}
        />
      }
    >
      <Field
        label={rbacCopy.user.displayName}
        value={displayName}
        onChange={setDisplayName}
        required
      />
      <Field label={rbacCopy.user.email} value={email} onChange={setEmail} type="email" required />
      <Field
        label={rbacCopy.password.initial}
        value={password}
        onChange={setPassword}
        type="password"
        required
      />
      <Field
        label={rbacCopy.user.confirmPassword}
        value={confirmPassword}
        onChange={setConfirmPassword}
        type="password"
        required
      />
      <TagPicker
        title={rbacCopy.member.department}
        inputValue={departmentInput}
        onInputValue={setDepartmentInput}
        selectedIds={departmentIds}
        options={props.departments.map((department) => ({
          id: department.id,
          label: department.name,
        }))}
        onChange={setDepartmentIds}
      />
      <CheckboxGroup
        title={rbacCopy.member.directRoles}
        values={roleIds}
        options={props.roles.map((role) => ({ value: role.id, label: role.name }))}
        onChange={setRoleIds}
      />
    </DialogShell>
  );
}

function UserEditDialog(props: {
  user: RbacUser;
  departments: RbacDepartment[];
  roles: RbacRole[];
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const [roleIds, setRoleIds] = useState<string[]>(props.user.roleIds);
  const [departmentIds, setDepartmentIds] = useState<string[]>(props.user.departmentIds);
  const [departmentInput, setDepartmentInput] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);

  const saveAssignments = () =>
    props.onSave(async () => {
      const nextDepartments = departmentIds.length
        ? departmentIds
        : props.departments.slice(0, 1).map((department) => department.id);
      await api.putRbacUserDepartments(props.user.userId, nextDepartments);
      await api.putRbacUserRoles(props.user.userId, roleIds);
    }, rbacCopy.member.informationSaved);

  return (
    <>
      <DialogShell
        title={rbacCopy.member.edit}
        subtitle={`${props.user.displayName} · ${props.user.email || props.user.username}`}
        onClose={props.onClose}
        footer={
          <>
            <button
              type="button"
              onClick={() => setPasswordOpen(true)}
              className="mr-auto inline-flex h-9 items-center gap-2 rounded-[var(--piwork-control-radius)] px-3 text-sm font-semibold text-foreground hover:bg-accent"
            >
              <KeyRound className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
              {rbacCopy.password.reset}
            </button>
            <button
              type="button"
              onClick={props.onClose}
              className="h-9 rounded-[var(--piwork-control-radius)] px-3 text-sm font-semibold text-muted-foreground hover:bg-accent"
            >
              {rbacCopy.cancel}
            </button>
            <button
              type="button"
              disabled={props.saving}
              onClick={saveAssignments}
              className="h-9 rounded-[var(--piwork-control-radius)] bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {rbacCopy.save}
            </button>
          </>
        }
      >
        <CheckboxGroup
          title={rbacCopy.member.directRoles}
          values={roleIds}
          options={props.roles.map((role) => ({ value: role.id, label: role.name }))}
          onChange={setRoleIds}
        />
        <TagPicker
          title={rbacCopy.member.department}
          inputValue={departmentInput}
          onInputValue={setDepartmentInput}
          selectedIds={departmentIds}
          options={props.departments.map((department) => ({
            id: department.id,
            label: department.name,
          }))}
          onChange={setDepartmentIds}
        />
      </DialogShell>
      {passwordOpen && (
        <PasswordResetDialog
          user={props.user}
          saving={props.saving}
          onClose={() => setPasswordOpen(false)}
          onSave={props.onSave}
        />
      )}
    </>
  );
}

function PasswordResetDialog(props: {
  user: RbacUser;
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const resetPassword = () =>
    props.onSave(async () => {
      if (!password.trim()) throw new Error(rbacCopy.password.emptyNew);
      await api.putRbacUserPassword(props.user.userId, password);
    }, rbacCopy.password.resetSuccess);

  return (
    <DialogShell
      title={rbacCopy.password.reset}
      subtitle={`${props.user.displayName} · ${props.user.email || props.user.username}`}
      onClose={props.onClose}
      footer={
        <DialogFooter
          saving={props.saving}
          onCancel={props.onClose}
          onConfirm={resetPassword}
          confirmLabel={rbacCopy.password.resetConfirm}
        />
      }
    >
      <Field
        label={rbacCopy.password.new}
        value={password}
        onChange={setPassword}
        type="password"
        required
      />
    </DialogShell>
  );
}

function RoleFormDialog(props: {
  mode: "create" | "edit";
  role?: RbacRole;
  permissions: RbacPermission[];
  saving: boolean;
  onClose: () => void;
  onSave: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const systemRole = props.role?.system === true;
  const [name, setName] = useState(props.role?.name || "");
  const [description, setDescription] = useState(props.role?.description || "");
  const [permissionKeys, setPermissionKeys] = useState<string[]>(props.role?.permissionKeys || []);
  const title = props.mode === "create" ? rbacCopy.role.create : rbacCopy.role.edit;

  const save = () =>
    props.onSave(
      async () => {
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error(rbacCopy.role.emptyName);
        if (props.mode === "create") {
          const result = await api.createRbacRole({
            name: trimmedName,
            description: description.trim(),
          });
          if (permissionKeys.length)
            await api.putRbacRolePermissions(result.role.id, permissionKeys);
        } else if (props.role && !systemRole) {
          await api.updateRbacRole(props.role.id, {
            name: trimmedName,
            description: description.trim(),
          });
          await api.putRbacRolePermissions(props.role.id, permissionKeys);
        }
      },
      props.mode === "create" ? rbacCopy.role.createSuccess : rbacCopy.role.updateSuccess,
    );

  const deleteRole = () =>
    props.onSave(async () => {
      if (!props.role || systemRole) return;
      await api.deleteRbacRole(props.role.id);
    }, rbacCopy.role.deleteSuccess);

  return (
    <DialogShell
      title={title}
      subtitle={systemRole ? rbacCopy.role.systemReadonly : undefined}
      onClose={props.onClose}
      footer={
        <>
          {props.mode === "edit" && !systemRole && (
            <button
              type="button"
              disabled={props.saving}
              onClick={deleteRole}
              className="mr-auto h-9 rounded-[var(--piwork-control-radius)] px-3 text-sm font-semibold text-danger hover:bg-danger-muted disabled:opacity-40"
            >
              {rbacCopy.role.delete}
            </button>
          )}
          <button
            type="button"
            onClick={props.onClose}
            className="h-9 rounded-[var(--piwork-control-radius)] px-3 text-sm font-semibold text-muted-foreground hover:bg-accent"
          >
            {rbacCopy.cancel}
          </button>
          <button
            type="button"
            disabled={props.saving || systemRole}
            onClick={save}
            className="h-9 rounded-[var(--piwork-control-radius)] bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {rbacCopy.save}
          </button>
        </>
      }
    >
      <Field
        label={rbacCopy.role.name}
        value={name}
        onChange={setName}
        disabled={systemRole}
        required
      />
      <Field
        label={rbacCopy.description}
        value={description}
        onChange={setDescription}
        disabled={systemRole}
      />
      <CheckboxGroup
        title={rbacCopy.role.permissions}
        values={permissionKeys}
        options={props.permissions.map((permission) => ({
          value: permission.key,
          label: permission.name || permission.key,
        }))}
        onChange={setPermissionKeys}
        disabled={systemRole}
      />
    </DialogShell>
  );
}

function DialogFooter({
  saving,
  onCancel,
  onConfirm,
  confirmLabel,
}: {
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onCancel}
        className="h-9 rounded-[var(--piwork-control-radius)] px-3 text-sm font-semibold text-muted-foreground hover:bg-accent"
      >
        {rbacCopy.cancel}
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={onConfirm}
        className="h-9 rounded-[var(--piwork-control-radius)] bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {confirmLabel}
      </button>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <label className="mt-2.5 block text-xs font-semibold text-muted-foreground first:mt-0">
      {label}
      {required && <RequiredMark />}
      <input
        aria-label={label}
        type={type}
        value={value}
        disabled={disabled}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-8 w-full rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring disabled:bg-card"
      />
    </label>
  );
}

function CheckboxGroup({
  title,
  values,
  options,
  onChange,
  disabled = false,
}: {
  title: string;
  values: string[];
  options: Array<{ value: string; label: string; meta?: string }>;
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  };
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{title}</div>
      <div className="max-h-44 space-y-0.5 overflow-auto rounded-lg border border-border bg-card p-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-7 items-center gap-2 rounded-[var(--piwork-control-radius)] px-2 py-0.5 text-sm text-foreground hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={values.includes(option.value)}
              disabled={disabled}
              onChange={() => toggle(option.value)}
              className="h-4 w-4 rounded border-input text-primary"
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.meta && (
              <span className="shrink-0 text-xs text-disabled-foreground">{option.meta}</span>
            )}
          </label>
        ))}
        {options.length === 0 && (
          <div className="px-2 py-3 text-sm text-muted-foreground">{rbacCopy.noOptions}</div>
        )}
      </div>
    </div>
  );
}

function TagPicker({
  title,
  inputValue,
  onInputValue,
  selectedIds,
  options,
  onChange,
}: {
  title: string;
  inputValue: string;
  onInputValue: (value: string) => void;
  selectedIds: string[];
  options: Array<{ id: string; label: string }>;
  onChange: (ids: string[]) => void;
}) {
  const suggestions = useMemo(() => {
    const needle = inputValue.trim().toLowerCase();
    if (!needle) return [];
    return options
      .filter((option) => !selectedIds.includes(option.id))
      .filter(
        (option) =>
          option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [inputValue, options, selectedIds]);

  const addByText = () => {
    const needle = inputValue.trim();
    if (!needle) {
      Toast.toast.danger(rbacCopy.tagPicker.missing(title), { timeout: 3000 });
      return;
    }
    const exact = options.find((option) => option.label === needle || option.id === needle);
    if (!exact) {
      Toast.toast.danger(rbacCopy.tagPicker.notFound(title), { timeout: 3600 });
      return;
    }
    if (selectedIds.includes(exact.id)) {
      Toast.toast.warning(rbacCopy.tagPicker.duplicate(exact.label), { timeout: 3000 });
      return;
    }
    onChange([...selectedIds, exact.id]);
    onInputValue("");
  };

  const remove = (id: string) => onChange(selectedIds.filter((item) => item !== id));

  return (
    <div className="mt-3">
      <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{title}</div>
      <div className="rounded-lg border border-border bg-card p-1.5">
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id) => (
            <span
              key={id}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--piwork-control-radius)] bg-accent px-2 text-sm font-semibold text-primary"
            >
              {options.find((option) => option.id === id)?.label || id}
              <button
                type="button"
                aria-label={rbacCopy.tagPicker.remove(id)}
                onClick={() => remove(id)}
                className="flex h-4 w-4 items-center justify-center rounded-[var(--piwork-control-radius)] hover:bg-accent"
              >
                <X className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          ))}
          {selectedIds.length === 0 && (
            <span className="py-1 text-sm text-disabled-foreground">
              {rbacCopy.member.unassigned}
            </span>
          )}
        </div>
        <div className="relative mt-1.5 flex gap-2">
          <input
            value={inputValue}
            onChange={(event) => onInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addByText();
              }
            }}
            placeholder={rbacCopy.tagPicker.inputPlaceholder}
            className="h-8 min-w-0 flex-1 rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring"
          />
          <button
            type="button"
            onClick={addByText}
            className="h-8 rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
          >
            {rbacCopy.tagPicker.add}
          </button>
          {suggestions.length > 0 && (
            <div className="absolute left-0 top-10 z-20 w-full overflow-hidden rounded-lg border border-border bg-card py-1 text-sm">
              {suggestions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onChange([...selectedIds, option.id]);
                    onInputValue("");
                  }}
                  className="block w-full px-3 py-2 text-left text-foreground hover:bg-accent"
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default RbacAdminPage;
