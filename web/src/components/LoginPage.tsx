import { useState, useCallback, useEffect } from "react";
import { useStore } from "../store.js";
import { api, getAuthMode, getMe } from "../api.js";
import { authClient } from "../auth-client.js";
import { uiCopy } from "../ui-copy.js";
import { Building2, Check, UserRound, UsersRound } from "lucide-react";

type AuthModeState = "checking" | "unsupported" | "better-auth";
type FormMode = "sign-in" | "sign-up";
type RegistrationType = "personal" | "team" | "enterprise";

const AUTH_FIELD_CLASS =
  "h-10 w-full rounded-[var(--piwork-control-radius)] border border-control-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-tertiary-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";

function resultError(result: {
  error?: { message?: string; statusText?: string } | null;
}): string | null {
  const error = result.error;
  if (!error) return null;
  return error.message || error.statusText || uiCopy.login.authFailed;
}

export function LoginPage() {
  const [formMode, setFormMode] = useState<FormMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registrationType, setRegistrationType] = useState<RegistrationType>("personal");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authMode, setAuthMode] = useState<AuthModeState>("checking");
  const [signUpEnabled, setSignUpEnabled] = useState(true);
  const setCurrentUser = useStore((s) => s.setCurrentUser);

  const refreshCurrentUser = useCallback(async () => {
    const result = await getMe();
    setCurrentUser(result.user, result.runtimeMode);
  }, [setCurrentUser]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (authMode !== "better-auth") return;
      if (formMode === "sign-up" && !signUpEnabled) {
        setError(uiCopy.login.disabledRegistration);
        return;
      }
      const trimmedEmail = email.trim().toLowerCase();
      const trimmedName = name.trim();
      const trimmedWorkspaceName = workspaceName.trim();
      if (
        !trimmedEmail ||
        !password ||
        (formMode === "sign-up" && (!trimmedName || !confirmPassword))
      ) {
        setError(
          formMode === "sign-up"
            ? uiCopy.login.missingSignUpFields
            : uiCopy.login.missingSignInFields,
        );
        return;
      }
      if (formMode === "sign-up" && password !== confirmPassword) {
        setError(uiCopy.login.passwordMismatch);
        return;
      }
      if (formMode === "sign-up" && registrationType !== "personal" && !trimmedWorkspaceName) {
        setError(
          registrationType === "team"
            ? uiCopy.login.missingTeamName
            : uiCopy.login.missingEnterpriseName,
        );
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result =
          formMode === "sign-up"
            ? await authClient.signUp.email({ email: trimmedEmail, password, name: trimmedName })
            : await authClient.signIn.email({ email: trimmedEmail, password });
        const message = resultError(result);
        if (message) throw new Error(message);
        if (formMode === "sign-up") {
          await api.completeOnboarding({
            type: registrationType,
            ...(registrationType !== "personal" ? { workspaceName: trimmedWorkspaceName } : {}),
          });
        }
        await refreshCurrentUser();
      } catch (err) {
        setError(err instanceof Error ? err.message : uiCopy.login.authFailed);
      } finally {
        setLoading(false);
      }
    },
    [
      authMode,
      confirmPassword,
      email,
      formMode,
      name,
      password,
      refreshCurrentUser,
      registrationType,
      signUpEnabled,
      workspaceName,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    getAuthMode()
      .then((mode) => {
        if (cancelled) return;
        const connected =
          mode.mode === "better-auth" && mode.runtimeMode === "local" && mode.emailAndPassword;
        const nextSignUpEnabled = mode.signUpEnabled !== false;
        setAuthMode(connected ? "better-auth" : "unsupported");
        setSignUpEnabled(nextSignUpEnabled);
        if (!nextSignUpEnabled) setFormMode("sign-in");
        useStore.getState().setUnauthenticated("local");
      })
      .catch(() => {
        if (cancelled) return;
        setAuthMode("unsupported");
        useStore.getState().setUnauthenticated("local");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchMode = useCallback((mode: FormMode) => {
    setFormMode(mode);
    setError(null);
    setConfirmPassword("");
    setWorkspaceName("");
  }, []);

  const isSignUp = formMode === "sign-up";
  const registrationOptions: Array<{
    type: RegistrationType;
    title: string;
    description: string;
    Icon: typeof UserRound;
  }> = [
    { type: "personal", ...uiCopy.login.registration.personal, Icon: UserRound },
    { type: "team", ...uiCopy.login.registration.team, Icon: UsersRound },
    { type: "enterprise", ...uiCopy.login.registration.enterprise, Icon: Building2 },
  ];

  return (
    <div className="min-h-[100dvh] overflow-y-auto bg-background font-sans-ui text-foreground antialiased">
      <div className="mx-auto grid min-h-[100dvh] w-full max-w-[72rem] lg:grid-cols-[minmax(0,1fr)_minmax(26rem,30rem)]">
        <aside className="flex min-h-[15rem] flex-col justify-between border-b border-border bg-surface-weak px-6 py-8 lg:min-h-full lg:border-b-0 lg:border-r lg:px-10 lg:py-12">
          <div>
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-[var(--piwork-control-radius)] bg-primary text-sm font-bold text-primary-foreground"
                aria-hidden="true"
              >
                {uiCopy.login.brand.slice(0, 1)}
              </div>
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-secondary-foreground">
                {uiCopy.login.brand}
              </div>
            </div>
            <div className="mt-10 h-px w-16 bg-primary" aria-hidden="true" />
            <p className="mt-5 max-w-lg text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-foreground">
              {uiCopy.login.title}
            </p>
            <p className="mt-4 max-w-md text-sm leading-6 text-secondary-foreground">
              {isSignUp ? uiCopy.login.signUpDescription : uiCopy.login.signInDescription}
            </p>
          </div>
          <p className="mt-10 max-w-lg text-xs leading-5 text-tertiary-foreground">
            {uiCopy.login.privacyNote}
          </p>
        </aside>

        <section
          className="flex items-center bg-card px-5 py-10 sm:px-8 lg:px-10"
          aria-labelledby="login-title"
        >
          <div className="w-full">
            <div className="mb-8 text-left">
              <h1
                id="login-title"
                className="text-2xl font-semibold tracking-tight text-foreground"
              >
                {isSignUp ? uiCopy.login.signUpTitle : uiCopy.login.title}
              </h1>
              <p className="mt-2 text-sm leading-6 text-secondary-foreground">
                {isSignUp ? uiCopy.login.signUpDescription : uiCopy.login.signInDescription}
              </p>
            </div>

            {authMode === "checking" ? (
              <div
                className="rounded-[var(--piwork-panel-radius)] border border-border bg-background px-4 py-5 text-center text-sm text-secondary-foreground"
                role="status"
                aria-live="polite"
              >
                {uiCopy.login.connectAuthService}
              </div>
            ) : authMode === "better-auth" ? (
              <form
                onSubmit={handleSubmit}
                className="space-y-4"
                aria-busy={loading}
                aria-describedby={error ? "auth-form-error" : undefined}
              >
                <div className="grid grid-cols-2 rounded-[var(--piwork-control-radius)] border border-border bg-card p-1">
                  <button
                    type="button"
                    aria-label={uiCopy.login.switchToLogin}
                    aria-pressed={formMode === "sign-in"}
                    onClick={() => switchMode("sign-in")}
                    className={`h-9 rounded-[var(--piwork-control-radius)] text-sm font-medium transition-colors ${formMode === "sign-in" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {uiCopy.login.login}
                  </button>
                  {signUpEnabled ? (
                    <button
                      type="button"
                      aria-label={uiCopy.login.switchToSignUp}
                      aria-pressed={formMode === "sign-up"}
                      onClick={() => switchMode("sign-up")}
                      className={`h-9 rounded-[var(--piwork-control-radius)] text-sm font-medium transition-colors ${formMode === "sign-up" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {uiCopy.login.signUp}
                    </button>
                  ) : (
                    <div className="flex h-9 items-center justify-center rounded-[var(--piwork-control-radius)] text-sm font-medium text-muted-foreground">
                      {uiCopy.login.registrationClosed}
                    </div>
                  )}
                </div>

                {isSignUp && (
                  <fieldset>
                    <legend className="mb-2 block text-xs font-medium text-muted-foreground">
                      {uiCopy.login.usageMode}
                    </legend>
                    <div
                      className="grid gap-2"
                      role="radiogroup"
                      aria-label={uiCopy.login.usageMode}
                    >
                      {registrationOptions.map((option) => {
                        const active = registrationType === option.type;
                        const Icon = option.Icon;
                        return (
                          <button
                            key={option.type}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            tabIndex={active ? 0 : -1}
                            onClick={() => {
                              setRegistrationType(option.type);
                              setError(null);
                            }}
                            onKeyDown={(event) => {
                              if (
                                ![
                                  "ArrowLeft",
                                  "ArrowRight",
                                  "ArrowUp",
                                  "ArrowDown",
                                  "Home",
                                  "End",
                                ].includes(event.key)
                              )
                                return;
                              event.preventDefault();
                              const currentIndex = registrationOptions.findIndex(
                                (candidate) => candidate.type === option.type,
                              );
                              const nextIndex =
                                event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? registrationOptions.length - 1
                                    : (currentIndex +
                                        (event.key === "ArrowLeft" || event.key === "ArrowUp"
                                          ? -1
                                          : 1) +
                                        registrationOptions.length) %
                                      registrationOptions.length;
                              const nextType = registrationOptions[nextIndex].type;
                              const group =
                                event.currentTarget.closest<HTMLElement>('[role="radiogroup"]');
                              setRegistrationType(nextType);
                              requestAnimationFrame(() =>
                                group
                                  ?.querySelector<HTMLElement>(
                                    `[data-registration-type="${nextType}"]`,
                                  )
                                  ?.focus(),
                              );
                            }}
                            data-registration-type={option.type}
                            className={`relative min-h-20 rounded-[var(--piwork-control-radius)] border p-3 text-left transition-colors ${active ? "border-primary bg-accent text-foreground" : "border-control-border bg-background text-secondary-foreground hover:border-primary hover:text-foreground"}`}
                          >
                            <div className="flex items-center justify-between">
                              <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                              {active && (
                                <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                              )}
                            </div>
                            <div className="mt-2 text-sm font-semibold">{option.title}</div>
                            <div className="mt-1 text-xs leading-5 opacity-75">
                              {option.description}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                )}

                {isSignUp && registrationType !== "personal" && (
                  <div>
                    <label
                      htmlFor="auth-workspace-name"
                      className="mb-1.5 block text-xs text-muted-foreground"
                    >
                      {registrationType === "team"
                        ? uiCopy.login.teamName
                        : uiCopy.login.organizationName}
                    </label>
                    <input
                      id="auth-workspace-name"
                      type="text"
                      value={workspaceName}
                      onChange={(e) => {
                        setWorkspaceName(e.target.value);
                        setError(null);
                      }}
                      autoComplete="organization"
                      disabled={loading}
                      placeholder={
                        registrationType === "team"
                          ? uiCopy.login.teamNamePlaceholder
                          : uiCopy.login.organizationNamePlaceholder
                      }
                      className={AUTH_FIELD_CLASS}
                    />
                  </div>
                )}

                {isSignUp && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor="auth-name"
                        className="mb-1.5 block text-xs text-muted-foreground"
                      >
                        {uiCopy.login.name}
                      </label>
                      <input
                        id="auth-name"
                        aria-label={uiCopy.login.name}
                        type="text"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setError(null);
                        }}
                        autoComplete="name"
                        disabled={loading}
                        className={AUTH_FIELD_CLASS}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="auth-email"
                        className="mb-1.5 block text-xs text-muted-foreground"
                      >
                        {uiCopy.login.email}
                      </label>
                      <input
                        id="auth-email"
                        aria-label={uiCopy.login.email}
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setError(null);
                        }}
                        autoComplete="email"
                        disabled={loading}
                        className={AUTH_FIELD_CLASS}
                      />
                    </div>
                  </div>
                )}

                {!isSignUp && (
                  <div>
                    <label
                      htmlFor="auth-email"
                      className="mb-1.5 block text-xs text-muted-foreground"
                    >
                      {uiCopy.login.email}
                    </label>
                    <input
                      id="auth-email"
                      aria-label={uiCopy.login.email}
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setError(null);
                      }}
                      autoComplete="email"
                      disabled={loading}
                      className={AUTH_FIELD_CLASS}
                    />
                  </div>
                )}
                <div className={isSignUp ? "grid gap-4 sm:grid-cols-2" : ""}>
                  <div>
                    <label
                      htmlFor="auth-password"
                      className="mb-1.5 block text-xs text-muted-foreground"
                    >
                      {uiCopy.login.password}
                    </label>
                    <input
                      id="auth-password"
                      aria-label={uiCopy.login.password}
                      type="password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError(null);
                      }}
                      autoComplete={isSignUp ? "new-password" : "current-password"}
                      disabled={loading}
                      className={AUTH_FIELD_CLASS}
                    />
                  </div>
                  {isSignUp && (
                    <div>
                      <label
                        htmlFor="auth-confirm-password"
                        className="mb-1.5 block text-xs text-muted-foreground"
                      >
                        {uiCopy.login.confirmPassword}
                      </label>
                      <input
                        id="auth-confirm-password"
                        aria-label={uiCopy.login.confirmPassword}
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => {
                          setConfirmPassword(e.target.value);
                          setError(null);
                        }}
                        autoComplete="new-password"
                        disabled={loading}
                        className={AUTH_FIELD_CLASS}
                      />
                    </div>
                  )}
                </div>

                {error && (
                  <p
                    id="auth-form-error"
                    className="rounded-[var(--piwork-control-radius)] border border-danger/35 bg-danger-muted px-3 py-2 text-xs font-medium text-danger"
                    role="alert"
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={
                    loading ||
                    !email.trim() ||
                    !password ||
                    (isSignUp &&
                      (!name.trim() ||
                        !confirmPassword ||
                        (registrationType !== "personal" && !workspaceName.trim())))
                  }
                  className="h-10 w-full rounded-[var(--piwork-control-radius)] bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading
                    ? uiCopy.common.processing
                    : isSignUp
                      ? uiCopy.login.createAccount
                      : uiCopy.login.login}
                </button>
              </form>
            ) : (
              <div
                className="rounded-[var(--piwork-panel-radius)] border border-danger/35 bg-danger-muted px-4 py-5 text-sm leading-relaxed text-danger"
                role="alert"
              >
                {uiCopy.login.loginServiceUnavailable}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
