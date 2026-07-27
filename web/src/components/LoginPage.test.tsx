// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { setUiCopyLanguage } from "../ui-copy.js";

const mockGetAuthMode = vi
  .fn()
  .mockResolvedValue({ mode: "better-auth", runtimeMode: "local", emailAndPassword: true });
const mockGetMe = vi.fn().mockResolvedValue({
  user: {
    userId: "better-auth-user",
    uuid: "better-auth-user",
    username: "misaka@example.test",
    displayName: "御坂美琴",
    orgId: "local",
    orgName: "Local",
    roles: ["user"],
    email: "misaka@example.test",
  },
  runtimeMode: "local",
});
const mockSignInEmail = vi.fn().mockResolvedValue({ data: {}, error: null });
const mockSignUpEmail = vi.fn().mockResolvedValue({ data: {}, error: null });
const mockCompleteOnboarding = vi.fn().mockResolvedValue({
  onboarding: {
    tenantId: "personal-u1",
    tenantName: "御坂美琴 Workspace",
    tenantType: "personal",
    completed: true,
  },
});

vi.mock("../api.js", () => ({
  getAuthMode: () => mockGetAuthMode(),
  getMe: () => mockGetMe(),
  api: { completeOnboarding: (...args: unknown[]) => mockCompleteOnboarding(...args) },
}));

vi.mock("../auth-client.js", () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => mockSignInEmail(...args) },
    signUp: { email: (...args: unknown[]) => mockSignUpEmail(...args) },
  },
}));

interface MockStoreState {
  runtimeMode: string;
  setCurrentUser: ReturnType<typeof vi.fn>;
  setUnauthenticated: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    runtimeMode: "local",
    setCurrentUser: vi.fn(),
    setUnauthenticated: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign((selector: (s: MockStoreState) => unknown) => selector(mockState), {
    getState: () => mockState,
  }),
}));

import { LoginPage } from "./LoginPage.js";

beforeEach(() => {
  setUiCopyLanguage("zh-CN");
  vi.clearAllMocks();
  mockGetAuthMode.mockResolvedValue({
    mode: "better-auth",
    runtimeMode: "local",
    emailAndPassword: true,
  });
  mockGetMe.mockResolvedValue({
    user: {
      userId: "better-auth-user",
      uuid: "better-auth-user",
      username: "misaka@example.test",
      displayName: "御坂美琴",
      orgId: "local",
      orgName: "Local",
      roles: ["user"],
      email: "misaka@example.test",
    },
    runtimeMode: "local",
  });
  mockSignInEmail.mockResolvedValue({ data: {}, error: null });
  mockSignUpEmail.mockResolvedValue({ data: {}, error: null });
  mockCompleteOnboarding.mockResolvedValue({
    onboarding: {
      tenantId: "personal-u1",
      tenantName: "御坂美琴 Workspace",
      tenantType: "personal",
      completed: true,
    },
  });
  resetStore();
});

describe("LoginPage", () => {
  it("renders the Better Auth email/password login form", async () => {
    render(<LoginPage />);

    expect(screen.getByRole("heading", { name: "Agent工作台" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent工作台" })).toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.queryByLabelText("测试用户")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeDisabled();
  });

  it("logs in with Better Auth credentials in local mode", async () => {
    render(<LoginPage />);

    fireEvent.change(await screen.findByLabelText("邮箱"), {
      target: { value: "Misaka@Example.Test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "33669900" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: "misaka@example.test",
        password: "33669900",
      });
      expect(mockGetMe).toHaveBeenCalledTimes(1);
      expect(mockState.setCurrentUser).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: "better-auth-user", email: "misaka@example.test" }),
        "local",
      );
    });
  });

  it("registers a new Better Auth user", async () => {
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "切换到注册" }));
    fireEvent.change(screen.getByLabelText("姓名"), {
      target: { value: "御坂美琴" },
    });
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "misaka@example.test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "33669900" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "33669900" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    await waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledWith({
        email: "misaka@example.test",
        password: "33669900",
        name: "御坂美琴",
      });
      expect(mockCompleteOnboarding).toHaveBeenCalledWith({ type: "personal" });
      expect(mockState.setCurrentUser).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: "better-auth-user" }),
        "local",
      );
    });
  });

  it("registers a team workspace through onboarding", async () => {
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole("button", { name: "切换到注册" }));
    fireEvent.click(screen.getByRole("radio", { name: /团队/ }));
    fireEvent.change(screen.getByLabelText("团队名称"), { target: { value: "研发团队" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "管理员" } });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "admin@example.test" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "33669900" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "33669900" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));
    await waitFor(() =>
      expect(mockCompleteOnboarding).toHaveBeenCalledWith({
        type: "team",
        workspaceName: "研发团队",
      }),
    );
  });

  it("requires matching passwords when registering", async () => {
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "切换到注册" }));
    fireEvent.change(screen.getByLabelText("姓名"), {
      target: { value: "御坂美琴" },
    });
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "misaka@example.test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "33669900" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "different" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("两次输入的密码不一致");
    expect(mockSignUpEmail).not.toHaveBeenCalled();
  });

  it("hides registration when the server disables sign-up", async () => {
    mockGetAuthMode.mockResolvedValue({
      mode: "better-auth",
      runtimeMode: "local",
      emailAndPassword: true,
      signUpEnabled: false,
    });

    render(<LoginPage />);

    await screen.findByLabelText("邮箱");
    expect(screen.getByText("注册已关闭")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "切换到注册" })).not.toBeInTheDocument();
  });

  it("shows an error when Better Auth login fails", async () => {
    mockSignInEmail.mockResolvedValue({ data: null, error: { message: "邮箱或密码错误" } });
    render(<LoginPage />);

    fireEvent.change(await screen.findByLabelText("邮箱"), {
      target: { value: "misaka@example.test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong-pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("邮箱或密码错误");
    });
  });

  it("shows a clear unsupported state when Better Auth is not available", async () => {
    mockGetAuthMode.mockResolvedValue({ mode: "unsupported", runtimeMode: "local" });
    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText("登录服务暂不可用，请联系系统管理员。")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Auth Token")).not.toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<LoginPage />);
    await screen.findByLabelText("邮箱");

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
