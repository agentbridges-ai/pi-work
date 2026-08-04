import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Boxes,
  Clipboard,
  Cloud,
  ExternalLink,
  History,
  Link2,
  RefreshCw,
  RotateCcw,
  Settings2,
} from "lucide-react";
import {
  api,
  ApiError,
  type ApiRequestOptions,
  type AppCloudflareBrowserConfig,
  type AppCloudflareConnection,
  type AppCloudflareZone,
  type AppDeployment,
  type AppDeploymentEvent,
  type AppDeploymentPhase,
  type AppDeploymentTargetKind,
  type AppListScope,
  type AppStatus,
  type PublishedApp,
  type PublishedAppSummary,
} from "../api.js";
import { isAbortError, runtimeContextCoordinator } from "../runtime-context.js";
import { useStore } from "../store.js";
import { userScopeKeyFromCurrentUser } from "../store/user-scoped-storage.js";
import { uiCopy } from "../ui-copy.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";
import { AppPreviewFrame, isIndependentAppUrl } from "./AppPreviewFrame.js";
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  SegmentedControl,
  Sheet,
  Skeleton,
  StatusBadge,
  TextField,
} from "./ui/index.js";
import { Card } from "./ui/heroui.js";

const CLOUDFLARE_TERMS_URL = "https://www.cloudflare.com/website-terms/";
const CLOUDFLARE_PRIVACY_URL = "https://www.cloudflare.com/privacypolicy/";
const TURNSTILE_SCRIPT_ID = "piwork-cloudflare-turnstile";
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface CloudflareTurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "auto";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId?: string): void;
  remove?(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: CloudflareTurnstileApi;
  }
}

let turnstileScriptPromise: Promise<CloudflareTurnstileApi> | null = null;

function loadCloudflareTurnstile(): Promise<CloudflareTurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise<CloudflareTurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing || document.createElement("script");
    const loaded = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Cloudflare Turnstile API unavailable"));
    };
    const failed = () => reject(new Error("Cloudflare Turnstile script failed to load"));
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  }).catch((error) => {
    turnstileScriptPromise = null;
    throw error;
  });
  return turnstileScriptPromise;
}

type Notice = { status: "success" | "danger"; message: string } | null;
type DeploymentTargetChoice = "temporary" | "byoc";

interface PreviewTarget {
  name: string;
  url: string;
}

interface ContextOperation {
  context: NonNullable<ReturnType<typeof runtimeContextCoordinator.current>>["context"];
  dispose: () => Promise<void>;
  options: ApiRequestOptions;
  signal: AbortSignal;
}

function beginContextOperation(expectedUserScopeKey: string): ContextOperation | null {
  const lease = runtimeContextCoordinator.current();
  if (!lease || lease.context.userScopeKey !== expectedUserScopeKey) return null;
  const scope = runtimeContextCoordinator.operationScope(lease.context);
  return {
    context: lease.context,
    dispose: () => scope.dispose(),
    options: {
      signal: scope.signal,
      contextEpoch: lease.context.epoch,
      contextId: lease.context.contextId,
    },
    signal: scope.signal,
  };
}

function operationIsCurrent(operation: ContextOperation): boolean {
  return !operation.signal.aborted && runtimeContextCoordinator.isCurrent(operation.context);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : uiCopy.apps.actionFailed;
}

function statusLabel(status: AppStatus): string {
  return uiCopy.apps.status[status];
}

function statusTone(status: AppStatus): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "ready" || status === "preview") return "success";
  if (status === "building" || status === "deploying") return "info";
  if (status === "needs_action" || status === "archived") return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}

function phaseLabel(phase: AppDeploymentPhase): string {
  return uiCopy.apps.phase[phase];
}

function phaseTone(
  phase: AppDeploymentPhase,
): "neutral" | "info" | "success" | "warning" | "danger" {
  if (phase === "ready" || phase === "temporary_ready") return "success";
  if (
    phase === "building" ||
    phase === "queued" ||
    phase === "provisioning" ||
    phase === "deploying" ||
    phase === "verifying_claim"
  ) {
    return "info";
  }
  if (phase === "awaiting_target" || phase === "awaiting_oauth" || phase === "claim_pending") {
    return "warning";
  }
  if (phase === "failed" || phase === "expired") return "danger";
  return "neutral";
}

function targetLabel(target: AppDeploymentTargetKind): string {
  return uiCopy.apps.targetKind[target];
}

function formatDate(value: string, language: "zh-CN" | "en-US"): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function emptyCopy(scope: AppListScope): { title: string; description: string } {
  if (scope === "current-session") {
    return {
      title: uiCopy.apps.empty.currentSessionTitle,
      description: uiCopy.apps.empty.currentSessionDescription,
    };
  }
  if (scope === "mine") {
    return {
      title: uiCopy.apps.empty.mineTitle,
      description: uiCopy.apps.empty.mineDescription,
    };
  }
  return {
    title: uiCopy.apps.empty.tenantTitle,
    description: uiCopy.apps.empty.tenantDescription,
  };
}

function asSummary(app: PublishedApp): PublishedAppSummary {
  return app;
}

function currentDeploymentId(app: PublishedApp, deployments: AppDeployment[]): string {
  return app.latestDeploymentId || deployments[0]?.id || "";
}

function deploymentNeedsTarget(deployment: AppDeployment | null): boolean {
  return deployment?.phase === "awaiting_target" || deployment?.phase === "awaiting_oauth";
}

function isOAuthMismatch(code: string | null | undefined): boolean {
  const value = code?.toLowerCase() || "";
  return value.includes("account_mismatch") || value.includes("temporary_account_mismatch");
}

function isOAuthCancelled(code: string | null | undefined): boolean {
  const value = code?.toLowerCase() || "";
  return value.includes("oauth_cancel") || value.includes("oauth_denied");
}

function isTemporaryExpired(deployment: AppDeployment): boolean {
  const code = deployment.errorCode?.toLowerCase() || "";
  return deployment.phase === "expired" || code.includes("expired");
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase();
}

function exactHostnameBelongsToZone(hostname: string, zoneName: string): boolean {
  const value = normalizeHostname(hostname);
  const zone = normalizeHostname(zoneName);
  if (!value || !zone || value.includes("*") || value.endsWith(".")) return false;
  if (value !== zone && !value.endsWith(`.${zone}`)) return false;
  if (value.length > 253) return false;
  return value.split(".").every((label) => {
    if (!label || label.length > 63) return false;
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  });
}

function matchingZoneId(zones: AppCloudflareZone[], hostname: string): string {
  return (
    [...zones]
      .filter((zone) => zone.status === "active" && exactHostnameBelongsToZone(hostname, zone.name))
      .sort((left, right) => right.name.length - left.name.length)[0]?.id || ""
  );
}

function enabledDeploymentTargets(
  config: AppCloudflareBrowserConfig | null,
): DeploymentTargetChoice[] {
  if (!config) return [];
  const targets: DeploymentTargetChoice[] = [];
  if (config.temporaryEnabled === true) targets.push("temporary");
  if (config.byocEnabled === true) targets.push("byoc");
  return targets;
}

function selectedDeploymentTarget(
  config: AppCloudflareBrowserConfig | null,
  preferred: DeploymentTargetChoice,
): DeploymentTargetChoice | null {
  const enabled = enabledDeploymentTargets(config);
  return enabled.includes(preferred) ? preferred : enabled[0] || null;
}

export function AppsPage() {
  const currentSessionId = useStore((state) => state.currentSessionId);
  const currentUser = useStore((state) => state.currentUser);
  const language = useStore((state) => state.uiLanguage);
  const expectedUserScopeKey = userScopeKeyFromCurrentUser(currentUser);
  const runtimeIdentity = `${expectedUserScopeKey}:${currentUser?.membershipId || ""}`;
  const [scope, setScope] = useState<AppListScope>("current-session");
  const [apps, setApps] = useState<PublishedAppSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [selectedApp, setSelectedApp] = useState<PublishedApp | null>(null);
  const [deployments, setDeployments] = useState<AppDeployment[]>([]);
  const [deploymentsError, setDeploymentsError] = useState("");
  const [selectedDeployment, setSelectedDeployment] = useState<AppDeployment | null>(null);
  const [deploymentEvents, setDeploymentEvents] = useState<AppDeploymentEvent[]>([]);
  const [eventsError, setEventsError] = useState("");
  const [connections, setConnections] = useState<AppCloudflareConnection[]>([]);
  const [connectionsError, setConnectionsError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [targetChoice, setTargetChoice] = useState<DeploymentTargetChoice>("temporary");
  const [connectionId, setConnectionId] = useState("");
  const [requiredOauthPermissions, setRequiredOauthPermissions] = useState<string[]>([]);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [cloudflareConfig, setCloudflareConfig] = useState<AppCloudflareBrowserConfig | null>(null);
  const [cloudflareConfigError, setCloudflareConfigError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [domainConnectionId, setDomainConnectionId] = useState("");
  const [domainZones, setDomainZones] = useState<AppCloudflareZone[]>([]);
  const [domainZonesLoading, setDomainZonesLoading] = useState(false);
  const [domainZonesError, setDomainZonesError] = useState("");
  const [domainZoneId, setDomainZoneId] = useState("");
  const [domainHostname, setDomainHostname] = useState("");
  const [domainImpactConfirmed, setDomainImpactConfirmed] = useState(false);
  const requestSequenceRef = useRef(0);
  const actionInFlightRef = useRef(false);

  const replaceApp = useCallback((nextApp: PublishedApp) => {
    setSelectedApp(nextApp);
    setApps((current) => current.map((app) => (app.id === nextApp.id ? asSummary(nextApp) : app)));
  }, []);

  const replaceDeployment = useCallback((nextDeployment: AppDeployment) => {
    setSelectedDeployment(nextDeployment);
    setDeployments((current) => {
      const index = current.findIndex((deployment) => deployment.id === nextDeployment.id);
      if (index < 0) return [nextDeployment, ...current];
      return current.map((deployment) =>
        deployment.id === nextDeployment.id ? nextDeployment : deployment,
      );
    });
  }, []);

  const loadApps = useCallback(
    async (cursor: string | null = null) => {
      const operation = beginContextOperation(expectedUserScopeKey);
      if (!operation) {
        window.setTimeout(() => setReloadToken((value) => value + 1), 0);
        return;
      }
      const sequence = ++requestSequenceRef.current;
      const append = Boolean(cursor);
      if (append) setLoadingMore(true);
      else setLoading(true);
      setLoadError("");
      try {
        const page = await api.listApps(
          { scope, sessionId: currentSessionId, cursor },
          operation.options,
        );
        if (sequence !== requestSequenceRef.current || !operationIsCurrent(operation)) return;
        setApps((current) => (append ? [...current, ...page.apps] : page.apps));
        setNextCursor(page.nextCursor || null);
      } catch (error) {
        if (isAbortError(error) || !operationIsCurrent(operation)) return;
        setLoadError(errorMessage(error));
      } finally {
        if (sequence === requestSequenceRef.current && operationIsCurrent(operation)) {
          setLoading(false);
          setLoadingMore(false);
        }
        await operation.dispose();
      }
    },
    [currentSessionId, expectedUserScopeKey, scope],
  );

  useEffect(() => {
    actionInFlightRef.current = false;
    setBusyAction("");
    setNotice(null);
    setApps([]);
    setNextCursor(null);
    setSelectedAppId("");
    setSelectedApp(null);
    setPreviewTarget(null);
    if (scope === "current-session" && !currentSessionId) {
      setLoading(false);
      return;
    }
    void loadApps();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [currentSessionId, loadApps, reloadToken, runtimeIdentity, scope]);

  useEffect(() => {
    if (!selectedAppId) {
      setSelectedApp(null);
      setDeployments([]);
      setSelectedDeployment(null);
      setDeploymentEvents([]);
      setConnections([]);
      setCloudflareConfig(null);
      setCloudflareConfigError("");
      setTurnstileToken("");
      setDomainZones([]);
      return;
    }
    const operation = beginContextOperation(expectedUserScopeKey);
    if (!operation) {
      window.setTimeout(() => setReloadToken((value) => value + 1), 0);
      return;
    }
    let active = true;
    setDetailsLoading(true);
    setDetailsError("");
    setDeploymentsError("");
    setEventsError("");
    setConnectionsError("");
    setTargetChoice("temporary");
    setConnectionId("");
    setRequiredOauthPermissions([]);
    setAcceptedTerms(false);
    setAcceptedPrivacy(false);
    setCloudflareConfig(null);
    setCloudflareConfigError("");
    setTurnstileToken("");
    setTurnstileResetKey((value) => value + 1);
    setDomainConnectionId("");
    setDomainZones([]);
    setDomainZonesError("");
    setDomainZoneId("");
    setDomainHostname("");
    setDomainImpactConfirmed(false);

    const load = async () => {
      const [appResult, deploymentsResult, connectionsResult, configResult] =
        await Promise.allSettled([
          api.getApp(selectedAppId, operation.options),
          api.listAppVersions(selectedAppId, null, operation.options),
          api.listCloudflareConnections(operation.options),
          api.getCloudflareConfig(operation.options),
        ]);
      if (!active || !operationIsCurrent(operation)) return;
      if (appResult.status === "rejected") {
        setDetailsError(errorMessage(appResult.reason));
        return;
      }

      const app = appResult.value.app;
      setSelectedApp(app);
      const nextDeployments =
        deploymentsResult.status === "fulfilled" ? deploymentsResult.value.versions : [];
      setDeployments(nextDeployments);
      if (deploymentsResult.status === "rejected") {
        setDeploymentsError(errorMessage(deploymentsResult.reason));
      }
      if (connectionsResult.status === "fulfilled") {
        const nextConnections = connectionsResult.value.connections;
        setConnections(nextConnections);
        setConnectionId(
          nextConnections.find((connection) => connection.status === "active")?.id || "",
        );
        const appConnectionId = app.customDomain?.connectionId || app.cloudflareConnectionId || "";
        setDomainConnectionId(
          nextConnections.some(
            (connection) => connection.id === appConnectionId && connection.status === "active",
          )
            ? appConnectionId
            : appConnectionId
              ? ""
              : nextConnections.find((connection) => connection.status === "active")?.id || "",
        );
        setDomainHostname(app.customDomain?.hostname || "");
        setDomainZoneId(app.customDomain?.zoneId || "");
      } else {
        setConnectionsError(errorMessage(connectionsResult.reason));
      }
      if (configResult.status === "fulfilled") {
        setCloudflareConfig(configResult.value);
      } else {
        setCloudflareConfig(null);
        setCloudflareConfigError(errorMessage(configResult.reason));
      }

      const deploymentId = currentDeploymentId(app, nextDeployments);
      if (!deploymentId) return;
      const [deploymentResult, eventsResult] = await Promise.allSettled([
        api.getAppDeployment(deploymentId, operation.options),
        api.getAppDeploymentEvents(deploymentId, operation.options),
      ]);
      if (!active || !operationIsCurrent(operation)) return;
      if (deploymentResult.status === "fulfilled") {
        const nextDeployment = deploymentResult.value.deployment;
        setSelectedDeployment(nextDeployment);
        if (!app.customDomain && nextDeployment.requestedCustomDomain) {
          setDomainHostname(nextDeployment.requestedCustomDomain);
        }
      } else {
        const fallback =
          nextDeployments.find((deployment) => deployment.id === deploymentId) || null;
        setSelectedDeployment(fallback);
        setDeploymentsError(errorMessage(deploymentResult.reason));
      }
      if (eventsResult.status === "fulfilled") {
        setDeploymentEvents(eventsResult.value.events);
      } else {
        setEventsError(errorMessage(eventsResult.reason));
      }
    };

    void load()
      .catch((error) => {
        if (!active || isAbortError(error) || !operationIsCurrent(operation)) return;
        setDetailsError(errorMessage(error));
      })
      .finally(() => {
        if (active && operationIsCurrent(operation)) setDetailsLoading(false);
        void operation.dispose();
      });
    return () => {
      active = false;
      void operation.dispose();
    };
  }, [expectedUserScopeKey, reloadToken, runtimeIdentity, selectedAppId]);

  useEffect(() => {
    if (
      !selectedApp ||
      selectedApp.status !== "ready" ||
      selectedApp.targetKind !== "byoc" ||
      (!selectedApp.customDomain && !selectedDeployment?.requestedCustomDomain) ||
      !domainConnectionId
    ) {
      setDomainZones([]);
      setDomainZonesLoading(false);
      setDomainZonesError("");
      return;
    }
    const operation = beginContextOperation(expectedUserScopeKey);
    if (!operation) return;
    let active = true;
    setDomainZonesLoading(true);
    setDomainZonesError("");
    api
      .listCloudflareConnectionZones(domainConnectionId, operation.options)
      .then(({ zones }) => {
        if (!active || !operationIsCurrent(operation)) return;
        const activeZones = zones.filter((zone) => zone.status === "active");
        setDomainZones(activeZones);
        setDomainZoneId((current) => {
          if (activeZones.some((zone) => zone.id === current)) return current;
          const domainZone = selectedApp.customDomain?.zoneId;
          if (domainZone && activeZones.some((zone) => zone.id === domainZone)) return domainZone;
          return (
            matchingZoneId(activeZones, selectedApp.customDomain?.hostname || "") ||
            activeZones[0]?.id ||
            ""
          );
        });
      })
      .catch((error) => {
        if (!active || isAbortError(error) || !operationIsCurrent(operation)) return;
        setDomainZones([]);
        setDomainZonesError(errorMessage(error));
      })
      .finally(() => {
        if (active && operationIsCurrent(operation)) setDomainZonesLoading(false);
        void operation.dispose();
      });
    return () => {
      active = false;
      void operation.dispose();
    };
  }, [
    domainConnectionId,
    expectedUserScopeKey,
    runtimeIdentity,
    selectedApp,
    selectedDeployment?.requestedCustomDomain,
  ]);

  const runAction = useCallback(
    async <T,>(
      actionKey: string,
      action: (options: ApiRequestOptions) => Promise<T>,
      commit: (result: T) => void,
      successMessage: string,
      onError?: (error: unknown) => void,
    ) => {
      if (actionInFlightRef.current) return;
      const operation = beginContextOperation(expectedUserScopeKey);
      if (!operation) return;
      actionInFlightRef.current = true;
      setBusyAction(actionKey);
      setNotice(null);
      try {
        const result = await action(operation.options);
        if (!operationIsCurrent(operation)) return;
        commit(result);
        setNotice({ status: "success", message: successMessage });
      } catch (error) {
        if (isAbortError(error) || !operationIsCurrent(operation)) return;
        onError?.(error);
        setNotice({ status: "danger", message: errorMessage(error) });
      } finally {
        if (operationIsCurrent(operation)) setBusyAction("");
        await operation.dispose();
        actionInFlightRef.current = false;
      }
    },
    [expectedUserScopeKey],
  );

  const startOAuth = useCallback(
    async (deployment: AppDeployment) => {
      if (actionInFlightRef.current) return;
      const operation = beginContextOperation(expectedUserScopeKey);
      if (!operation) return;
      actionInFlightRef.current = true;
      setBusyAction("oauth");
      setNotice(null);
      try {
        const temporaryPreviewId = deployment?.temporaryPreview?.id || undefined;
        const result = await api.startCloudflareOAuth(
          {
            returnPath: `${window.location.pathname}${window.location.search}`,
            deploymentId: deployment.id,
            purpose: temporaryPreviewId ? "claim" : "direct",
            ...(temporaryPreviewId ? { temporaryPreviewId } : {}),
          },
          operation.options,
        );
        if (!operationIsCurrent(operation)) return;
        window.location.assign(result.authorizationUrl);
      } catch (error) {
        if (isAbortError(error) || !operationIsCurrent(operation)) return;
        setNotice({ status: "danger", message: errorMessage(error) });
      } finally {
        if (operationIsCurrent(operation)) setBusyAction("");
        await operation.dispose();
        actionInFlightRef.current = false;
      }
    },
    [expectedUserScopeKey],
  );

  const continueDevelopment = useCallback(() => {
    if (!selectedApp) return;
    void runAction(
      "continue",
      (options) => api.continueAppDevelopment(selectedApp.id, options),
      ({ sessionId }) => {
        setSelectedAppId("");
        navigateToSession(sessionId, false, {
          userUuid: currentUser?.uuid || currentUser?.userId,
          agentId: useStore.getState().selectedAgentId,
        });
      },
      uiCopy.apps.continuingDevelopment,
    );
  }, [currentUser?.userId, currentUser?.uuid, runAction, selectedApp]);

  const submitTarget = useCallback(
    (submittedTarget: DeploymentTargetChoice) => {
      if (!selectedDeployment || !cloudflareConfig) return;
      if (submittedTarget === "temporary") {
        if (cloudflareConfig.temporaryEnabled !== true) return;
        const requiresTurnstile = cloudflareConfig?.turnstileEnabled === true;
        if (
          !acceptedTerms ||
          !acceptedPrivacy ||
          (requiresTurnstile && (!cloudflareConfig.siteKey || !turnstileToken))
        ) {
          return;
        }
        const token = turnstileToken;
        void runAction(
          "target",
          (options) =>
            api.selectAppDeploymentTarget(
              selectedDeployment.id,
              {
                target: "temporary",
                termsAcceptance: {
                  acceptedTermsOfService: true,
                  acceptedPrivacyPolicy: true,
                  ...(requiresTurnstile ? { turnstileToken: token } : {}),
                },
              },
              options,
            ),
          ({ deployment }) => replaceDeployment(deployment),
          uiCopy.apps.targetSelected,
        ).finally(() => {
          if (!requiresTurnstile) return;
          setTurnstileToken("");
          setTurnstileResetKey((value) => value + 1);
        });
        return;
      }
      if (cloudflareConfig.byocEnabled !== true || !connectionId) return;
      void runAction(
        "target",
        (options) =>
          api.selectAppDeploymentTarget(
            selectedDeployment.id,
            { target: "byoc", connectionId },
            options,
          ),
        ({ deployment }) => {
          setRequiredOauthPermissions([]);
          replaceDeployment(deployment);
        },
        uiCopy.apps.targetSelected,
        (error) => {
          if (error instanceof ApiError && error.code === "needs_oauth") {
            setRequiredOauthPermissions(error.requiredPermissionNames);
          }
        },
      );
    },
    [
      acceptedPrivacy,
      acceptedTerms,
      cloudflareConfig,
      connectionId,
      replaceDeployment,
      runAction,
      selectedDeployment,
      turnstileToken,
    ],
  );

  const attachWorkerCustomDomain = useCallback(() => {
    if (!selectedApp || !domainImpactConfirmed) return;
    const zone = domainZones.find((candidate) => candidate.id === domainZoneId);
    const hostname = normalizeHostname(domainHostname);
    if (
      !domainConnectionId ||
      !zone ||
      !exactHostnameBelongsToZone(hostname, zone.name) ||
      hostname.includes("*")
    ) {
      return;
    }
    void runAction(
      "domain-attach",
      (options) =>
        api.setAppWorkerCustomDomain(
          selectedApp.id,
          {
            connectionId: domainConnectionId,
            zoneId: zone.id,
            hostname,
            confirmImpact: true,
          },
          options,
        ),
      ({ app }) => {
        replaceApp(app);
        setDomainImpactConfirmed(false);
      },
      uiCopy.apps.workerDomain.attached,
    );
  }, [
    domainConnectionId,
    domainHostname,
    domainImpactConfirmed,
    domainZoneId,
    domainZones,
    replaceApp,
    runAction,
    selectedApp,
  ]);

  const detachWorkerCustomDomain = useCallback(() => {
    if (!selectedApp?.customDomain || !domainImpactConfirmed) return;
    const connection = selectedApp.customDomain.connectionId || domainConnectionId;
    const zone =
      domainZones.find((candidate) => candidate.id === selectedApp.customDomain?.zoneId) ||
      domainZones.find((candidate) => candidate.id === domainZoneId) ||
      domainZones.find((candidate) =>
        exactHostnameBelongsToZone(selectedApp.customDomain?.hostname || "", candidate.name),
      );
    if (!connection || !zone) return;
    void runAction(
      "domain-detach",
      (options) =>
        api.removeAppWorkerCustomDomain(
          selectedApp.id,
          {
            connectionId: connection,
            zoneId: zone.id,
            hostname: selectedApp.customDomain!.hostname,
            confirmImpact: true,
          },
          options,
        ),
      ({ app }) => {
        replaceApp(app);
        setDomainHostname("");
        setDomainImpactConfirmed(false);
      },
      uiCopy.apps.workerDomain.detached,
    );
  }, [
    domainConnectionId,
    domainImpactConfirmed,
    domainZoneId,
    domainZones,
    replaceApp,
    runAction,
    selectedApp,
  ]);

  const archiveSelectedApp = useCallback(() => {
    if (!selectedApp || !window.confirm(uiCopy.apps.archiveConfirm(selectedApp.displayName)))
      return;
    void runAction(
      "archive",
      (options) => api.archiveApp(selectedApp.id, options),
      ({ app }) => replaceApp(app),
      uiCopy.apps.archived,
    );
  }, [replaceApp, runAction, selectedApp]);

  const oauthOutcome =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("cloudflare");
  const listEmpty = !loading && !loadError && apps.length === 0;
  const empty = emptyCopy(scope);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border bg-card px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <Button
            aria-label={uiCopy.apps.backToWorkbench}
            size="sm"
            variant="ghost"
            onPress={() => navigateHome(false)}
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            {uiCopy.apps.backToWorkbench}
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold leading-7">{uiCopy.apps.title}</h1>
            <p className="text-sm text-muted-foreground">{uiCopy.apps.description}</p>
          </div>
          <Button
            aria-label={uiCopy.apps.refresh}
            size="sm"
            variant="secondary"
            loading={loading}
            onPress={() => setReloadToken((value) => value + 1)}
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            {uiCopy.apps.refresh}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-7xl space-y-5">
          <SegmentedControl
            ariaLabel={uiCopy.apps.filterLabel}
            value={scope}
            onChange={(value) => setScope(value as AppListScope)}
            items={[
              { id: "current-session", label: uiCopy.apps.filters.currentSession },
              { id: "mine", label: uiCopy.apps.filters.mine },
              { id: "tenant", label: uiCopy.apps.filters.tenant },
            ]}
          />

          {oauthOutcome === "denied" ? (
            <Alert status="warning" title={uiCopy.apps.oauthCancelled} />
          ) : null}
          {oauthOutcome === "connected" ? (
            <Alert status="success" title={uiCopy.apps.oauthConnected} />
          ) : null}
          {notice && !selectedAppId ? (
            <Alert status={notice.status} title={notice.message} />
          ) : null}
          {scope === "current-session" && !currentSessionId ? (
            <Alert status="info" title={uiCopy.apps.noCurrentSession} />
          ) : null}
          {loadError ? (
            <Alert
              status="danger"
              title={`${uiCopy.apps.loadFailed}: ${loadError}`}
              action={
                <Button size="sm" variant="secondary" onPress={() => setReloadToken((v) => v + 1)}>
                  {uiCopy.apps.retry}
                </Button>
              }
            />
          ) : null}

          {loading ? <AppsGridSkeleton /> : null}
          {listEmpty ? (
            <EmptyState
              icon={<Boxes aria-hidden="true" className="h-7 w-7" />}
              title={empty.title}
              description={empty.description}
            />
          ) : null}
          {!loading && apps.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {apps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  language={language}
                  onManage={() => setSelectedAppId(app.id)}
                  onPreview={() => {
                    if (app.stableUrl) {
                      setPreviewTarget({ name: app.displayName, url: app.stableUrl });
                    }
                  }}
                  onNotice={setNotice}
                />
              ))}
            </div>
          ) : null}
          {nextCursor ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={loadingMore}
                onPress={() => void loadApps(nextCursor)}
              >
                {uiCopy.apps.loadMore}
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <Sheet
        closeLabel={uiCopy.apps.closeDetails}
        description={uiCopy.apps.detailsDescription}
        isOpen={Boolean(selectedAppId)}
        onOpenChange={(open) => {
          if (!open) setSelectedAppId("");
        }}
        title={uiCopy.apps.detailsTitle(
          selectedApp?.displayName ||
            apps.find((app) => app.id === selectedAppId)?.displayName ||
            uiCopy.apps.title,
        )}
      >
        {detailsLoading ? (
          <div className="space-y-3" aria-label={uiCopy.common.loading}>
            <Skeleton label={uiCopy.common.loading} className="h-24 w-full" />
            <Skeleton label={uiCopy.common.loading} className="h-40 w-full" />
          </div>
        ) : detailsError ? (
          <Alert status="danger" title={detailsError} />
        ) : selectedApp ? (
          <div className="space-y-6 pb-4">
            {notice ? <Alert status={notice.status} title={notice.message} /> : null}
            <AppOverview app={selectedApp} language={language} />
            {selectedDeployment ? (
              <DeploymentRecovery
                deployment={selectedDeployment}
                busyAction={busyAction}
                onConnect={() => void startOAuth(selectedDeployment)}
                onRedeploy={continueDevelopment}
              />
            ) : null}
            {deploymentNeedsTarget(selectedDeployment) && selectedDeployment ? (
              <DeploymentTargetSection
                acceptedPrivacy={acceptedPrivacy}
                acceptedTerms={acceptedTerms}
                busyAction={busyAction}
                cloudflareConfig={cloudflareConfig}
                cloudflareConfigError={cloudflareConfigError}
                connectionId={connectionId}
                connections={connections}
                connectionsError={connectionsError}
                requiredOauthPermissions={requiredOauthPermissions}
                targetChoice={targetChoice}
                turnstileResetKey={turnstileResetKey}
                turnstileToken={turnstileToken}
                onAcceptedPrivacyChange={setAcceptedPrivacy}
                onAcceptedTermsChange={setAcceptedTerms}
                onConnect={() => void startOAuth(selectedDeployment)}
                onConnectionChange={(value) => {
                  setConnectionId(value);
                  setRequiredOauthPermissions([]);
                }}
                onContinueDevelopment={continueDevelopment}
                onSubmit={submitTarget}
                onTargetChoiceChange={(value) => {
                  setTargetChoice(value);
                  if (value === "temporary") return;
                  setTurnstileToken("");
                  setTurnstileResetKey((current) => current + 1);
                }}
                onTurnstileToken={setTurnstileToken}
              />
            ) : null}
            {selectedDeployment ? (
              <CurrentDeploymentSection
                app={selectedApp}
                byocEnabled={cloudflareConfig?.byocEnabled === true}
                deployment={selectedDeployment}
                language={language}
                currentUserId={currentUser?.uuid || currentUser?.userId || ""}
                busyAction={busyAction}
                onConnect={() => void startOAuth(selectedDeployment)}
                onClaimOpened={() =>
                  replaceDeployment({
                    ...selectedDeployment,
                    phase: "claim_pending",
                    errorCode: null,
                    errorMessage: null,
                  })
                }
              />
            ) : null}
            {selectedApp.status === "ready" &&
            selectedApp.targetKind === "byoc" &&
            (Boolean(selectedApp.customDomain) ||
              Boolean(selectedDeployment?.requestedCustomDomain)) ? (
              <WorkerCustomDomainSection
                app={selectedApp}
                busyAction={busyAction}
                connectionId={domainConnectionId}
                connections={connections}
                confirmedImpact={domainImpactConfirmed}
                hostname={domainHostname}
                zoneId={domainZoneId}
                zones={domainZones}
                zonesError={domainZonesError}
                zonesLoading={domainZonesLoading}
                onAttach={attachWorkerCustomDomain}
                onConfirmedImpactChange={setDomainImpactConfirmed}
                onConnectionChange={(value) => {
                  setDomainConnectionId(value);
                  setDomainZoneId("");
                  setDomainImpactConfirmed(false);
                }}
                onDetach={detachWorkerCustomDomain}
                onHostnameChange={setDomainHostname}
                onZoneChange={(value) => {
                  setDomainZoneId(value);
                  setDomainImpactConfirmed(false);
                }}
              />
            ) : null}
            <DeploymentEventsSection
              error={eventsError}
              events={deploymentEvents}
              language={language}
            />
            <DeploymentHistorySection
              app={selectedApp}
              busyAction={busyAction}
              deployments={deployments}
              error={deploymentsError}
              language={language}
              onRollback={(deployment) => {
                void runAction(
                  `rollback:${deployment.id}`,
                  (options) => api.rollbackApp(selectedApp.id, deployment.id, options),
                  ({ app, deployment: nextDeployment }) => {
                    replaceApp(app);
                    replaceDeployment(nextDeployment);
                  },
                  uiCopy.apps.rollbackSucceeded,
                );
              }}
            />
            <div className="flex flex-wrap gap-2 border-t border-border pt-5">
              <Button
                variant="secondary"
                loading={busyAction === "continue"}
                isDisabled={!selectedApp.canManage}
                onPress={continueDevelopment}
              >
                <Settings2 aria-hidden="true" className="h-4 w-4" />
                {busyAction === "continue"
                  ? uiCopy.apps.continuingDevelopment
                  : uiCopy.apps.continueDevelopment}
              </Button>
              {selectedApp.status === "archived" ? (
                <Button
                  loading={busyAction === "unarchive"}
                  isDisabled={!selectedApp.canManage}
                  onPress={() =>
                    void runAction(
                      "unarchive",
                      (options) => api.unarchiveApp(selectedApp.id, options),
                      ({ app }) => replaceApp(app),
                      uiCopy.apps.unarchived,
                    )
                  }
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  {busyAction === "unarchive" ? uiCopy.apps.unarchiving : uiCopy.apps.unarchive}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  loading={busyAction === "archive"}
                  isDisabled={!selectedApp.canManage}
                  onPress={archiveSelectedApp}
                >
                  <Archive aria-hidden="true" className="h-4 w-4" />
                  {busyAction === "archive" ? uiCopy.apps.archiving : uiCopy.apps.archive}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </Sheet>

      <Dialog
        closeLabel={uiCopy.apps.closePreview}
        description={uiCopy.apps.previewDescription}
        isOpen={Boolean(previewTarget)}
        onOpenChange={(open) => {
          if (!open) setPreviewTarget(null);
        }}
        size="lg"
        title={uiCopy.apps.previewTitle(previewTarget?.name || uiCopy.apps.title)}
        bodyClassName="p-0"
      >
        {previewTarget ? (
          <AppPreviewFrame
            appName={previewTarget.name}
            className="h-[min(70dvh,760px)] rounded-none border-0"
            url={previewTarget.url}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function AppsGridSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      aria-label={uiCopy.apps.loading}
    >
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} label={uiCopy.apps.loading} className="h-80 w-full" />
      ))}
    </div>
  );
}

function AppCard({
  app,
  language,
  onManage,
  onNotice,
  onPreview,
}: {
  app: PublishedAppSummary;
  language: "zh-CN" | "en-US";
  onManage: () => void;
  onNotice: (notice: Notice) => void;
  onPreview: () => void;
}) {
  const safeStableUrl = app.stableUrl ? isIndependentAppUrl(app.stableUrl) : false;
  return (
    <Card className="items-stretch overflow-hidden p-0" variant="default">
      <div className="relative aspect-video overflow-hidden border-b border-border bg-muted">
        {app.screenshotUrl ? (
          <img
            alt={uiCopy.apps.screenshotAlt(app.displayName)}
            className="h-full w-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={app.screenshotUrl}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-sm text-muted-foreground">
            <Boxes aria-hidden="true" className="h-7 w-7" />
            {uiCopy.apps.screenshotPending}
          </div>
        )}
      </div>
      <Card.Header className="px-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Card.Title className="truncate">{app.displayName}</Card.Title>
            <Card.Description className="truncate font-mono-code">{app.slug}</Card.Description>
          </div>
          <StatusBadge status={statusTone(app.status)}>{statusLabel(app.status)}</StatusBadge>
        </div>
      </Card.Header>
      <Card.Content className="space-y-3 px-4 text-sm">
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span>{uiCopy.apps.owner}</span>
          <span className="truncate text-foreground">{app.ownerDisplayName}</span>
        </div>
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span>{uiCopy.apps.deploymentTarget}</span>
          <span className="text-foreground">{targetLabel(app.targetKind)}</span>
        </div>
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span>{uiCopy.apps.updatedAt(formatDate(app.updatedAt, language))}</span>
          {app.latestDeploymentNumber ? (
            <span className="text-foreground">
              {uiCopy.apps.version(app.latestDeploymentNumber)}
            </span>
          ) : null}
        </div>
        {app.status === "archived" ? (
          <div className="rounded-[var(--piwork-control-radius)] bg-warning-muted px-3 py-2 text-xs text-warning">
            {uiCopy.apps.archivedResourcesRemain}
          </div>
        ) : null}
      </Card.Content>
      <Card.Footer className="mt-auto flex flex-wrap gap-2 border-t border-border px-4 py-3">
        <Button size="sm" variant="secondary" isDisabled={!safeStableUrl} onPress={onPreview}>
          <Cloud aria-hidden="true" className="h-4 w-4" />
          {uiCopy.apps.preview}
        </Button>
        <Button size="sm" variant="ghost" onPress={onManage}>
          <Settings2 aria-hidden="true" className="h-4 w-4" />
          {uiCopy.apps.manage}
        </Button>
        <Button
          aria-label={uiCopy.apps.copyUrl}
          size="sm"
          variant="ghost"
          isDisabled={!safeStableUrl || !app.stableUrl}
          onPress={() => {
            if (!app.stableUrl) return;
            void navigator.clipboard
              .writeText(app.stableUrl)
              .then(() => onNotice({ status: "success", message: uiCopy.apps.urlCopied }))
              .catch(() => onNotice({ status: "danger", message: uiCopy.apps.actionFailed }));
          }}
        >
          <Clipboard aria-hidden="true" className="h-4 w-4" />
          {uiCopy.apps.copyUrl}
        </Button>
        <a
          aria-label={uiCopy.apps.open}
          className={`ml-auto inline-flex h-8 items-center gap-1.5 rounded-[var(--piwork-control-radius)] px-2 text-sm font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            !safeStableUrl ? "pointer-events-none opacity-50" : "hover:bg-muted"
          }`}
          href={safeStableUrl && app.stableUrl ? app.stableUrl : undefined}
          rel="noopener noreferrer"
          target="_blank"
        >
          {uiCopy.apps.open}
          <ExternalLink aria-hidden="true" className="h-4 w-4" />
        </a>
      </Card.Footer>
    </Card>
  );
}

function SectionHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      {icon}
      <h2 className="text-base font-semibold">{title}</h2>
    </div>
  );
}

function AppOverview({ app, language }: { app: PublishedApp; language: "zh-CN" | "en-US" }) {
  const safeStableUrl = app.stableUrl ? isIndependentAppUrl(app.stableUrl) : false;
  return (
    <section>
      <SectionHeading
        icon={<Boxes aria-hidden="true" className="h-4 w-4" />}
        title={uiCopy.apps.overview}
      />
      <div className="space-y-3 rounded-[var(--piwork-panel-radius)] border border-border bg-muted p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={statusTone(app.status)}>{statusLabel(app.status)}</StatusBadge>
          <StatusBadge>{targetLabel(app.targetKind)}</StatusBadge>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted-foreground">{uiCopy.apps.stableUrl}</div>
          {safeStableUrl && app.stableUrl ? (
            <a
              className="break-all font-mono-code text-primary underline-offset-2 hover:underline"
              href={app.stableUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {app.stableUrl}
            </a>
          ) : (
            <div className="text-muted-foreground">{uiCopy.apps.urlNotReady}</div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <div className="text-xs font-semibold text-muted-foreground">{uiCopy.apps.owner}</div>
            <div>{app.ownerDisplayName}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground">
              {uiCopy.apps.sourceSession}
            </div>
            <div className="truncate font-mono-code">{app.sourceSessionId}</div>
          </div>
        </div>
        {app.archivedAt ? (
          <Alert
            status="warning"
            title={uiCopy.apps.archivedAt(formatDate(app.archivedAt, language))}
          />
        ) : null}
        {app.lastFailure ? <Alert status="danger" title={app.lastFailure} /> : null}
      </div>
    </section>
  );
}

function DeploymentTargetSection({
  acceptedPrivacy,
  acceptedTerms,
  busyAction,
  cloudflareConfig,
  cloudflareConfigError,
  connectionId,
  connections,
  connectionsError,
  requiredOauthPermissions,
  targetChoice,
  turnstileResetKey,
  turnstileToken,
  onAcceptedPrivacyChange,
  onAcceptedTermsChange,
  onConnect,
  onConnectionChange,
  onContinueDevelopment,
  onSubmit,
  onTargetChoiceChange,
  onTurnstileToken,
}: {
  acceptedPrivacy: boolean;
  acceptedTerms: boolean;
  busyAction: string;
  cloudflareConfig: AppCloudflareBrowserConfig | null;
  cloudflareConfigError: string;
  connectionId: string;
  connections: AppCloudflareConnection[];
  connectionsError: string;
  requiredOauthPermissions: string[];
  targetChoice: DeploymentTargetChoice;
  turnstileResetKey: number;
  turnstileToken: string;
  onAcceptedPrivacyChange: (value: boolean) => void;
  onAcceptedTermsChange: (value: boolean) => void;
  onConnect: () => void;
  onConnectionChange: (value: string) => void;
  onContinueDevelopment: () => void;
  onSubmit: (target: DeploymentTargetChoice) => void;
  onTargetChoiceChange: (value: DeploymentTargetChoice) => void;
  onTurnstileToken: (value: string) => void;
}) {
  const activeConnections = connections.filter((connection) => connection.status === "active");
  const enabledTargets = enabledDeploymentTargets(cloudflareConfig);
  const selectedTarget = selectedDeploymentTarget(cloudflareConfig, targetChoice);
  const canSubmit =
    selectedTarget === "temporary"
      ? cloudflareConfig?.temporaryEnabled === true &&
        acceptedTerms &&
        acceptedPrivacy &&
        (!cloudflareConfig?.turnstileEnabled ||
          (Boolean(cloudflareConfig.siteKey) && Boolean(turnstileToken)))
      : selectedTarget === "byoc" &&
        cloudflareConfig?.byocEnabled === true &&
        Boolean(connectionId);
  const unavailableAction = (
    <Button
      size="sm"
      variant="secondary"
      loading={busyAction === "continue"}
      onPress={onContinueDevelopment}
    >
      {busyAction === "continue"
        ? uiCopy.apps.continuingDevelopment
        : uiCopy.apps.deploymentTargetsUnavailableAction}
    </Button>
  );
  return (
    <section>
      <SectionHeading
        icon={<Cloud aria-hidden="true" className="h-4 w-4" />}
        title={uiCopy.apps.chooseTarget}
      />
      <p className="mb-3 text-sm text-muted-foreground">{uiCopy.apps.chooseTargetDescription}</p>
      {cloudflareConfigError ? (
        <Alert
          status="danger"
          title={uiCopy.apps.deploymentTargetsConfigUnavailable}
          action={unavailableAction}
        />
      ) : !cloudflareConfig ? (
        <div className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {uiCopy.apps.deploymentTargetsLoading}
        </div>
      ) : !selectedTarget ? (
        <Alert
          status="warning"
          title={uiCopy.apps.deploymentTargetsUnavailable}
          action={unavailableAction}
        />
      ) : (
        <>
          <SegmentedControl
            ariaLabel={uiCopy.apps.chooseTarget}
            value={selectedTarget}
            onChange={(value) => onTargetChoiceChange(value as DeploymentTargetChoice)}
            items={enabledTargets.map((target) => ({
              id: target,
              label: target === "temporary" ? uiCopy.apps.temporaryTarget : uiCopy.apps.byocTarget,
            }))}
          />
          {selectedTarget === "temporary" ? (
            <div className="mt-4 space-y-3 rounded-[var(--piwork-panel-radius)] border border-border p-4">
              <p className="text-sm text-muted-foreground">{uiCopy.apps.temporaryDescription}</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  aria-label={uiCopy.apps.acceptCloudflareTerms}
                  checked={acceptedTerms}
                  className="mt-0.5 h-4 w-4 rounded border-input text-primary"
                  type="checkbox"
                  onChange={(event) => onAcceptedTermsChange(event.currentTarget.checked)}
                />
                <span>
                  {uiCopy.apps.acceptTermsPrefix}{" "}
                  <a
                    className="text-primary underline underline-offset-2"
                    href={CLOUDFLARE_TERMS_URL}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {uiCopy.apps.cloudflareTerms}
                  </a>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  aria-label={uiCopy.apps.acceptCloudflarePrivacy}
                  checked={acceptedPrivacy}
                  className="mt-0.5 h-4 w-4 rounded border-input text-primary"
                  type="checkbox"
                  onChange={(event) => onAcceptedPrivacyChange(event.currentTarget.checked)}
                />
                <span>
                  {uiCopy.apps.acceptPrivacyPrefix}{" "}
                  <a
                    className="text-primary underline underline-offset-2"
                    href={CLOUDFLARE_PRIVACY_URL}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {uiCopy.apps.cloudflarePrivacy}
                  </a>
                </span>
              </label>
              {cloudflareConfig.turnstileEnabled ? (
                cloudflareConfig.siteKey ? (
                  <CloudflareTurnstileWidget
                    key={turnstileResetKey}
                    siteKey={cloudflareConfig.siteKey}
                    onToken={onTurnstileToken}
                  />
                ) : (
                  <Alert status="danger" title={uiCopy.apps.turnstile.configUnavailable} />
                )
              ) : null}
            </div>
          ) : (
            <div className="mt-4 space-y-3 rounded-[var(--piwork-panel-radius)] border border-border p-4">
              <p className="text-sm text-muted-foreground">{uiCopy.apps.byocDescription}</p>
              {requiredOauthPermissions.length > 0 ? (
                <Alert
                  status="warning"
                  title={uiCopy.apps.additionalOAuthPermissionsRequired(requiredOauthPermissions)}
                />
              ) : null}
              {connectionsError ? <Alert status="danger" title={connectionsError} /> : null}
              {activeConnections.length > 0 ? (
                <label className="block text-sm font-semibold">
                  <span>{uiCopy.apps.cloudflareAccount}</span>
                  <select
                    aria-label={uiCopy.apps.cloudflareAccount}
                    className="mt-1 h-9 w-full rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring"
                    value={connectionId}
                    onChange={(event) => onConnectionChange(event.currentTarget.value)}
                  >
                    <option value="">{uiCopy.apps.selectCloudflareAccount}</option>
                    {activeConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {uiCopy.apps.cloudflareAccountOption(
                          connection.accountName,
                          connection.accountId,
                        )}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <Alert status="info" title={uiCopy.apps.noCloudflareConnection} />
              )}
              <Button
                size="sm"
                variant="secondary"
                loading={busyAction === "oauth"}
                onPress={onConnect}
              >
                <Link2 aria-hidden="true" className="h-4 w-4" />
                {busyAction === "oauth"
                  ? uiCopy.apps.connectingCloudflare
                  : uiCopy.apps.connectCloudflare}
              </Button>
            </div>
          )}
          <div className="mt-3">
            <Button
              loading={busyAction === "target"}
              isDisabled={!canSubmit}
              onPress={() => onSubmit(selectedTarget)}
            >
              {busyAction === "target" ? uiCopy.apps.selectingTarget : uiCopy.apps.deployToTarget}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function CloudflareTurnstileWidget({
  onToken,
  siteKey,
}: {
  onToken: (value: string) => void;
  siteKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let api: CloudflareTurnstileApi | null = null;
    setLoading(true);
    setVerified(false);
    setFailed(false);
    onToken("");
    void loadCloudflareTurnstile()
      .then((loadedApi) => {
        if (!active || !containerRef.current) return;
        api = loadedApi;
        widgetIdRef.current = loadedApi.render(containerRef.current, {
          sitekey: siteKey,
          action: "temporary-preview",
          theme: "auto",
          callback: (token) => {
            if (!active) return;
            setLoading(false);
            setFailed(false);
            setVerified(true);
            onToken(token);
          },
          "expired-callback": () => {
            if (!active) return;
            setLoading(true);
            setVerified(false);
            onToken("");
            if (widgetIdRef.current) loadedApi.reset(widgetIdRef.current);
          },
          "error-callback": () => {
            if (!active) return;
            setLoading(false);
            setVerified(false);
            setFailed(true);
            onToken("");
          },
        });
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
        setVerified(false);
        setFailed(true);
        onToken("");
      });
    return () => {
      active = false;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (!api || !widgetId) return;
      if (api.remove) api.remove(widgetId);
      else api.reset(widgetId);
    };
  }, [attempt, onToken, siteKey]);

  const retry = () => {
    setFailed(false);
    setVerified(false);
    setLoading(true);
    onToken("");
    setAttempt((value) => value + 1);
  };

  return (
    <div
      aria-label={uiCopy.apps.turnstile.label}
      className="space-y-2 rounded-[var(--piwork-control-radius)] border border-border bg-muted p-3"
    >
      <div ref={containerRef} />
      {loading ? (
        <div className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {uiCopy.apps.turnstile.loading}
        </div>
      ) : null}
      {verified ? (
        <div className="text-sm text-success" role="status" aria-live="polite">
          {uiCopy.apps.turnstile.verified}
        </div>
      ) : null}
      {failed ? (
        <Alert
          status="danger"
          title={uiCopy.apps.turnstile.failed}
          action={
            <Button size="sm" variant="secondary" onPress={retry}>
              {uiCopy.apps.turnstile.retry}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function WorkerCustomDomainSection({
  app,
  busyAction,
  connectionId,
  connections,
  confirmedImpact,
  hostname,
  zoneId,
  zones,
  zonesError,
  zonesLoading,
  onAttach,
  onConfirmedImpactChange,
  onConnectionChange,
  onDetach,
  onHostnameChange,
  onZoneChange,
}: {
  app: PublishedApp;
  busyAction: string;
  connectionId: string;
  connections: AppCloudflareConnection[];
  confirmedImpact: boolean;
  hostname: string;
  zoneId: string;
  zones: AppCloudflareZone[];
  zonesError: string;
  zonesLoading: boolean;
  onAttach: () => void;
  onConfirmedImpactChange: (value: boolean) => void;
  onConnectionChange: (value: string) => void;
  onDetach: () => void;
  onHostnameChange: (value: string) => void;
  onZoneChange: (value: string) => void;
}) {
  const fixedConnectionId = app.customDomain?.connectionId || app.cloudflareConnectionId;
  const eligibleConnections = connections.filter(
    (connection) =>
      connection.status === "active" && (!fixedConnectionId || connection.id === fixedConnectionId),
  );
  const activeZones = zones.filter((zone) => zone.status === "active");
  const selectedZone = activeZones.find((zone) => zone.id === zoneId);
  const normalizedHostname = normalizeHostname(hostname);
  const wildcard = normalizedHostname.includes("*");
  const hostnameInvalid = Boolean(
    normalizedHostname &&
    selectedZone &&
    !exactHostnameBelongsToZone(normalizedHostname, selectedZone.name),
  );
  const canAttach = Boolean(
    connectionId &&
    selectedZone &&
    normalizedHostname &&
    !wildcard &&
    !hostnameInvalid &&
    confirmedImpact,
  );
  const canDetach = Boolean(app.customDomain && connectionId && selectedZone && confirmedImpact);

  return (
    <section>
      <SectionHeading
        icon={<Link2 aria-hidden="true" className="h-4 w-4" />}
        title={uiCopy.apps.workerDomain.title}
      />
      <div className="space-y-3 rounded-[var(--piwork-panel-radius)] border border-border p-4 text-sm">
        <p className="text-muted-foreground">{uiCopy.apps.workerDomain.description}</p>
        <Alert status="info" title={uiCopy.apps.workerDomain.defaultUrlRetained} />
        {app.customDomain ? (
          <div className="space-y-3">
            <div className="rounded-[var(--piwork-control-radius)] bg-muted p-3">
              <div className="break-all font-semibold">{app.customDomain.hostname}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <StatusBadge
                  status={
                    app.customDomain.status === "active"
                      ? "success"
                      : app.customDomain.status === "failed"
                        ? "danger"
                        : "info"
                  }
                >
                  {uiCopy.apps.workerDomain.status[app.customDomain.status]}
                </StatusBadge>
                <StatusBadge
                  status={
                    app.customDomain.sslStatus === "active"
                      ? "success"
                      : app.customDomain.sslStatus === "failed"
                        ? "danger"
                        : "info"
                  }
                >
                  {uiCopy.apps.workerDomain.sslStatus[app.customDomain.sslStatus]}
                </StatusBadge>
              </div>
              {app.customDomain.error ? (
                <div className="mt-2 text-danger">{app.customDomain.error}</div>
              ) : null}
            </div>
            <Alert status="warning" title={uiCopy.apps.workerDomain.detachCertificateImpact} />
          </div>
        ) : (
          <>
            <label className="block font-semibold">
              <span>{uiCopy.apps.workerDomain.connection}</span>
              <select
                aria-label={uiCopy.apps.workerDomain.connection}
                className="mt-1 h-9 w-full rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring"
                value={connectionId}
                onChange={(event) => onConnectionChange(event.currentTarget.value)}
              >
                <option value="">{uiCopy.apps.workerDomain.selectConnection}</option>
                {eligibleConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {uiCopy.apps.cloudflareAccountOption(
                      connection.accountName,
                      connection.accountId,
                    )}
                  </option>
                ))}
              </select>
            </label>
            <label className="block font-semibold">
              <span>{uiCopy.apps.workerDomain.zone}</span>
              <select
                aria-label={uiCopy.apps.workerDomain.zone}
                className="mt-1 h-9 w-full rounded-[var(--piwork-control-radius)] border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-ring disabled:opacity-50"
                disabled={!connectionId || zonesLoading}
                value={zoneId}
                onChange={(event) => onZoneChange(event.currentTarget.value)}
              >
                <option value="">
                  {zonesLoading
                    ? uiCopy.apps.workerDomain.loadingZones
                    : uiCopy.apps.workerDomain.selectZone}
                </option>
                {activeZones.map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {zone.name}
                  </option>
                ))}
              </select>
            </label>
            {zonesError ? <Alert status="danger" title={zonesError} /> : null}
            {!zonesLoading && connectionId && !zonesError && activeZones.length === 0 ? (
              <Alert status="warning" title={uiCopy.apps.workerDomain.noActiveZones} />
            ) : null}
            <TextField
              label={uiCopy.apps.workerDomain.hostname}
              description={uiCopy.apps.workerDomain.hostnameDescription}
              error={
                wildcard
                  ? uiCopy.apps.workerDomain.wildcardNotAllowed
                  : hostnameInvalid
                    ? uiCopy.apps.workerDomain.invalidHostname
                    : undefined
              }
              isInvalid={wildcard || hostnameInvalid}
              inputProps={{
                autoCapitalize: "none",
                autoComplete: "off",
                placeholder: uiCopy.apps.workerDomain.hostnamePlaceholder,
                spellCheck: false,
                readOnly: true,
                value: hostname,
                onChange: (event) => onHostnameChange(event.currentTarget.value),
              }}
            />
          </>
        )}
        <label className="flex items-start gap-2">
          <input
            aria-label={uiCopy.apps.workerDomain.confirmImpact}
            checked={confirmedImpact}
            className="mt-0.5 h-4 w-4 rounded border-input text-primary"
            type="checkbox"
            onChange={(event) => onConfirmedImpactChange(event.currentTarget.checked)}
          />
          <span>
            {app.customDomain
              ? uiCopy.apps.workerDomain.confirmDetachImpact
              : uiCopy.apps.workerDomain.confirmAttachImpact}
          </span>
        </label>
        {app.customDomain ? (
          <Button
            variant="secondary"
            loading={busyAction === "domain-detach"}
            isDisabled={!canDetach}
            onPress={onDetach}
          >
            {busyAction === "domain-detach"
              ? uiCopy.apps.workerDomain.detaching
              : uiCopy.apps.workerDomain.detach}
          </Button>
        ) : (
          <Button
            loading={busyAction === "domain-attach"}
            isDisabled={!canAttach}
            onPress={onAttach}
          >
            {busyAction === "domain-attach"
              ? uiCopy.apps.workerDomain.attaching
              : uiCopy.apps.workerDomain.attach}
          </Button>
        )}
      </div>
    </section>
  );
}

function useCountdown(expiresAt: string | null): { expired: boolean; label: string } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return { expired: false, label: uiCopy.apps.countdown.unavailable };
  const expires = new Date(expiresAt).valueOf();
  if (!Number.isFinite(expires)) {
    return { expired: false, label: uiCopy.apps.countdown.unavailable };
  }
  const remainingSeconds = Math.max(0, Math.ceil((expires - now) / 1_000));
  if (remainingSeconds === 0) {
    return { expired: true, label: uiCopy.apps.countdown.expired };
  }
  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  return {
    expired: false,
    label:
      hours > 0
        ? uiCopy.apps.countdown.hoursMinutes(hours, minutes)
        : uiCopy.apps.countdown.minutesSeconds(minutes, seconds),
  };
}

function CurrentDeploymentSection({
  app,
  byocEnabled,
  busyAction,
  currentUserId,
  deployment,
  language,
  onClaimOpened,
  onConnect,
}: {
  app: PublishedApp;
  byocEnabled: boolean;
  busyAction: string;
  currentUserId: string;
  deployment: AppDeployment;
  language: "zh-CN" | "en-US";
  onClaimOpened: () => void;
  onConnect: () => void;
}) {
  const previewCountdown = useCountdown(deployment.temporaryPreview?.expiresAt || null);
  const claimCountdown = useCountdown(deployment.temporaryPreview?.claimExpiresAt || null);
  const isOwner = Boolean(currentUserId) && currentUserId === app.ownerUserId;
  const stableUrl = deployment.stableUrl || app.stableUrl;
  const canClaimTemporaryPreview =
    byocEnabled &&
    deployment.temporaryPreview?.claimAvailable === true &&
    !previewCountdown.expired &&
    !claimCountdown.expired &&
    isOwner;
  return (
    <section>
      <SectionHeading
        icon={<Cloud aria-hidden="true" className="h-4 w-4" />}
        title={uiCopy.apps.currentDeployment}
      />
      <div className="space-y-3 rounded-[var(--piwork-panel-radius)] border border-border p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{uiCopy.apps.version(deployment.number)}</span>
          <StatusBadge status={phaseTone(deployment.phase)}>
            {phaseLabel(deployment.phase)}
          </StatusBadge>
          <StatusBadge>{targetLabel(deployment.targetKind)}</StatusBadge>
        </div>
        <div className="text-xs text-muted-foreground">
          {formatDate(deployment.createdAt, language)}
        </div>
        {stableUrl && isIndependentAppUrl(stableUrl) ? (
          <a
            className="block break-all font-mono-code text-primary underline-offset-2 hover:underline"
            href={stableUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {stableUrl}
          </a>
        ) : null}
        {deployment.temporaryPreview ? (
          <div className="space-y-2 rounded-[var(--piwork-control-radius)] bg-muted p-3">
            <div>{uiCopy.apps.previewExpiresIn(previewCountdown.label)}</div>
            <div>{uiCopy.apps.claimExpiresIn(claimCountdown.label)}</div>
            {canClaimTemporaryPreview ? (
              <div className="flex flex-wrap gap-2">
                <a
                  className="inline-flex h-8 items-center gap-2 rounded-[var(--piwork-control-radius)] bg-primary px-3 text-sm font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={api.getAppDeploymentClaimUrl(deployment.id)}
                  onClick={onClaimOpened}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                  {uiCopy.apps.claimTemporaryPreview}
                </a>
                {deployment.phase === "claim_pending" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busyAction === "oauth"}
                    onPress={onConnect}
                  >
                    <Link2 aria-hidden="true" className="h-4 w-4" />
                    {uiCopy.apps.claimThenConnectCloudflare}
                  </Button>
                ) : null}
              </div>
            ) : !byocEnabled &&
              deployment.temporaryPreview.claimAvailable &&
              !previewCountdown.expired &&
              !claimCountdown.expired ? (
              <Alert status="info" title={uiCopy.apps.claimRequiresByoc} />
            ) : deployment.temporaryPreview.claimAvailable &&
              !previewCountdown.expired &&
              !claimCountdown.expired ? (
              <Alert status="info" title={uiCopy.apps.claimOwnerOnly} />
            ) : previewCountdown.expired || claimCountdown.expired ? (
              <Alert status="danger" title={uiCopy.apps.temporaryExpired} />
            ) : null}
            {deployment.phase === "claim_pending" ? (
              <p className="text-xs text-muted-foreground">{uiCopy.apps.claimThenOAuth}</p>
            ) : null}
          </div>
        ) : null}
        {deployment.errorMessage ? <Alert status="danger" title={deployment.errorMessage} /> : null}
      </div>
    </section>
  );
}

function DeploymentRecovery({
  busyAction,
  deployment,
  onConnect,
  onRedeploy,
}: {
  busyAction: string;
  deployment: AppDeployment;
  onConnect: () => void;
  onRedeploy: () => void;
}) {
  if (isOAuthMismatch(deployment.errorCode)) {
    return (
      <Alert
        status="danger"
        title={uiCopy.apps.oauthAccountMismatch}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={busyAction === "oauth"}
              onPress={onConnect}
            >
              {uiCopy.apps.chooseClaimedAccount}
            </Button>
            <Button size="sm" variant="ghost" onPress={onRedeploy}>
              {uiCopy.apps.redeployToAnotherAccount}
            </Button>
          </div>
        }
      />
    );
  }
  if (isOAuthCancelled(deployment.errorCode)) {
    return (
      <Alert
        status="warning"
        title={uiCopy.apps.oauthCancelled}
        action={
          <Button
            size="sm"
            variant="secondary"
            loading={busyAction === "oauth"}
            onPress={onConnect}
          >
            {uiCopy.apps.retryOAuth}
          </Button>
        }
      />
    );
  }
  if (isTemporaryExpired(deployment)) {
    return (
      <Alert
        status="danger"
        title={uiCopy.apps.temporaryExpired}
        action={
          <Button size="sm" variant="secondary" onPress={onRedeploy}>
            {uiCopy.apps.createNewTemporaryPreview}
          </Button>
        }
      />
    );
  }
  if (deployment.phase === "failed") {
    return (
      <Alert
        status="danger"
        title={deployment.errorMessage || uiCopy.apps.deploymentFailed}
        action={
          <Button size="sm" variant="secondary" onPress={onRedeploy}>
            {uiCopy.apps.retryDeployment}
          </Button>
        }
      />
    );
  }
  return null;
}

function DeploymentEventsSection({
  error,
  events,
  language,
}: {
  error: string;
  events: AppDeploymentEvent[];
  language: "zh-CN" | "en-US";
}) {
  const orderedEvents = useMemo(
    () => [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    [events],
  );
  return (
    <section>
      <SectionHeading
        icon={<History aria-hidden="true" className="h-4 w-4" />}
        title={uiCopy.apps.deploymentEvents}
      />
      {error ? (
        <Alert status="danger" title={error} />
      ) : orderedEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{uiCopy.apps.deploymentEventsEmpty}</p>
      ) : (
        <ol className="space-y-2">
          {orderedEvents.map((event) => (
            <li
              key={event.id}
              className="rounded-[var(--piwork-control-radius)] border border-border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={phaseTone(event.phase)}>{phaseLabel(event.phase)}</StatusBadge>
                <span className="text-xs text-muted-foreground">
                  {formatDate(event.timestamp, language)}
                </span>
              </div>
              {event.message ? <p className="mt-2 text-muted-foreground">{event.message}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DeploymentHistorySection({
  app,
  busyAction,
  deployments,
  error,
  language,
  onRollback,
}: {
  app: PublishedApp;
  busyAction: string;
  deployments: AppDeployment[];
  error: string;
  language: "zh-CN" | "en-US";
  onRollback: (deployment: AppDeployment) => void;
}) {
  return (
    <section>
      <SectionHeading
        icon={<History aria-hidden="true" className="h-4 w-4" />}
        title={uiCopy.apps.deploymentHistory}
      />
      {error ? (
        <Alert status="danger" title={error} />
      ) : deployments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{uiCopy.apps.deploymentsEmpty}</p>
      ) : (
        <div className="space-y-2">
          {deployments.map((deployment) => {
            const current = deployment.current || deployment.id === app.latestDeploymentId;
            return (
              <div
                key={deployment.id}
                className="flex items-center gap-3 rounded-[var(--piwork-control-radius)] border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{uiCopy.apps.version(deployment.number)}</span>
                    {current ? (
                      <StatusBadge status="success">{uiCopy.apps.currentVersion}</StatusBadge>
                    ) : null}
                    <StatusBadge status={phaseTone(deployment.phase)}>
                      {phaseLabel(deployment.phase)}
                    </StatusBadge>
                    <StatusBadge>{targetLabel(deployment.targetKind)}</StatusBadge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDate(deployment.createdAt, language)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busyAction === `rollback:${deployment.id}`}
                  isDisabled={!app.canManage || current || deployment.phase !== "ready"}
                  onPress={() => onRollback(deployment)}
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  {busyAction === `rollback:${deployment.id}`
                    ? uiCopy.apps.rollingBack
                    : uiCopy.apps.rollback}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
