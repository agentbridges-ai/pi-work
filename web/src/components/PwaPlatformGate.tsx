import { useState, type ReactNode } from "react";
import { CircleCheck, CircleX, Download, Monitor, RefreshCw, WifiOff, X } from "lucide-react";
import { clientEnvironment } from "../environment.js";
import { activatePwaUpdate, requestPwaInstall } from "../pwa/lifecycle.js";
import type { ClientPlatform, PlatformSupportResult } from "../pwa/platform-support.js";
import { usePwaLifecycle } from "../pwa/use-pwa-lifecycle.js";
import { useStore } from "../store.js";
import { uiCopy } from "../ui-copy.js";

export interface PwaPlatformGateProps {
  support: PlatformSupportResult;
  children: ReactNode;
}

export function PwaPlatformGate({ support, children }: PwaPlatformGateProps) {
  useStore((state) => state.uiLanguage);
  const copy = uiCopy.pwaPlatform;

  if (!support.supported) {
    return <UnsupportedPlatform platform={support.platform} copy={copy} />;
  }

  return (
    <>
      {children}
      <PwaNotice support={support} copy={copy} />
    </>
  );
}
type LocalizedCopy = typeof uiCopy.pwaPlatform;

function UnsupportedPlatform({
  platform,
  copy,
}: {
  platform: ClientPlatform;
  copy: LocalizedCopy;
}) {
  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-background px-6 py-8 text-foreground sm:px-10">
      <div className="relative mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-6xl flex-col">
        <div className="flex items-center gap-3 text-sm font-bold tracking-tight">
          <img
            src="/icons/piwork-192.png"
            alt=""
            className="h-9 w-9 rounded-[var(--piwork-panel-radius)]"
          />
          Piwork
        </div>

        <div className="grid flex-1 items-center gap-16 py-14 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
          <section aria-labelledby="unsupported-title" className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
              {copy.eyebrow}
            </p>
            <h1
              id="unsupported-title"
              className="mt-5 text-balance text-4xl font-semibold leading-[1.04] tracking-[-0.045em] sm:text-6xl"
            >
              {copy.titles[platform]}
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              {copy.descriptions[platform]}
            </p>
            <p className="mt-3 max-w-2xl text-base font-semibold leading-7 text-foreground">
              {copy.requirement}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-9 inline-flex min-h-11 items-center gap-2 rounded-[var(--piwork-control-radius)] bg-primary px-5 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {copy.retry}
            </button>
          </section>

          <aside
            aria-label={copy.matrixTitle}
            className="piwork-superellipse-panel border border-border bg-card p-1"
          >
            <div className="flex items-center gap-3 border-b border-border px-5 py-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-[var(--piwork-control-radius)] bg-accent text-accent-foreground">
                <Monitor className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="text-sm font-bold">{copy.matrixTitle}</h2>
            </div>
            <SupportRow
              label={copy.desktopChromium}
              supported
              supportedLabel={copy.supported}
              unsupportedLabel={copy.unsupported}
            />
            <SupportRow
              label={copy.safariFirefox}
              supported={false}
              supportedLabel={copy.supported}
              unsupportedLabel={copy.unsupported}
            />
            <SupportRow
              label={copy.mobileDevices}
              supported={false}
              supportedLabel={copy.supported}
              unsupportedLabel={copy.unsupported}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}

function SupportRow({
  label,
  supported,
  supportedLabel,
  unsupportedLabel,
}: {
  label: string;
  supported: boolean;
  supportedLabel: string;
  unsupportedLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-5 border-b border-border px-5 py-4 last:border-b-0">
      <span className="text-sm font-semibold">{label}</span>
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-bold ${supported ? "text-success" : "text-muted-foreground"}`}
      >
        {supported ? (
          <CircleCheck className="h-4 w-4" aria-hidden="true" />
        ) : (
          <CircleX className="h-4 w-4" aria-hidden="true" />
        )}
        {supported ? supportedLabel : unsupportedLabel}
      </span>
    </div>
  );
}

function PwaNotice({ support, copy }: { support: PlatformSupportResult; copy: LocalizedCopy }) {
  const lifecycle = usePwaLifecycle();
  const [installDismissed, setInstallDismissed] = useState(false);
  const [capabilityDismissed, setCapabilityDismissed] = useState(false);
  const [actionMessage, setActionMessage] = useState("");

  if (!lifecycle.online) {
    return (
      <Notice
        icon={<WifiOff className="h-5 w-5" aria-hidden="true" />}
        title={copy.offlineTitle}
        body={copy.offlineBody}
        tone="warning"
      />
    );
  }

  if (lifecycle.updateAvailable) {
    return (
      <Notice
        icon={
          <RefreshCw
            className={`h-5 w-5 ${lifecycle.updateActivating ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
        }
        title={copy.updateTitle}
        body={actionMessage || copy.updateBody}
        tone={actionMessage ? "warning" : "info"}
        action={{
          label: lifecycle.updateActivating ? copy.updating : copy.update,
          disabled: lifecycle.updateActivating,
          onClick: () => {
            setActionMessage("");
            void activatePwaUpdate().then((result) => {
              if (result === "blocked") setActionMessage(copy.updateBlocked);
              if (result === "failed" || result === "unavailable")
                setActionMessage(copy.updateFailed);
            });
          },
        }}
      />
    );
  }

  if (
    lifecycle.installAvailable &&
    !lifecycle.installed &&
    !lifecycle.standalone &&
    !installDismissed
  ) {
    return (
      <Notice
        icon={<Download className="h-5 w-5" aria-hidden="true" />}
        title={copy.installTitle}
        body={copy.installBody}
        tone="info"
        action={{
          label: lifecycle.installPrompting ? copy.installing : copy.install,
          disabled: lifecycle.installPrompting,
          onClick: () => void requestPwaInstall(),
        }}
        dismiss={{ label: copy.dismiss, onClick: () => setInstallDismissed(true) }}
      />
    );
  }

  if (!clientEnvironment.isDevelopment && !support.pwa.available && !capabilityDismissed) {
    const body = support.pwa.issues.includes("insecure-context")
      ? copy.pwaUnavailableBody
      : copy.swUnavailableBody;
    return (
      <Notice
        icon={<Monitor className="h-5 w-5" aria-hidden="true" />}
        title={copy.pwaUnavailableTitle}
        body={body}
        tone="warning"
        dismiss={{ label: copy.dismiss, onClick: () => setCapabilityDismissed(true) }}
      />
    );
  }

  if (lifecycle.registrationStatus === "error" && !capabilityDismissed) {
    return (
      <Notice
        icon={<CircleX className="h-5 w-5" aria-hidden="true" />}
        title={copy.registrationErrorTitle}
        body={copy.registrationErrorBody}
        tone="warning"
        action={{ label: copy.reload, onClick: () => window.location.reload() }}
        dismiss={{ label: copy.dismiss, onClick: () => setCapabilityDismissed(true) }}
      />
    );
  }

  return null;
}

function Notice({
  icon,
  title,
  body,
  tone,
  action,
  dismiss,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  tone: "info" | "warning";
  action?: { label: string; disabled?: boolean; onClick: () => void };
  dismiss?: { label: string; onClick: () => void };
}) {
  return (
    <section
      role="status"
      aria-live="polite"
      className="piwork-superellipse-panel fixed bottom-4 left-4 z-50 w-[min(390px,calc(100vw-2rem))] border border-border bg-card p-1 text-foreground"
    >
      <div className="flex gap-3 px-3 pb-3 pt-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] ${tone === "warning" ? "bg-warning-muted text-warning" : "bg-info-muted text-info"}`}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1 pr-1">
          <h2 className="text-sm font-bold">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
          {action && (
            <button
              type="button"
              disabled={action.disabled}
              onClick={action.onClick}
              className="mt-3 inline-flex min-h-10 items-center justify-center rounded-[var(--piwork-control-radius)] bg-primary px-3 text-xs font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {action.label}
            </button>
          )}
        </div>
        {dismiss && (
          <button
            type="button"
            aria-label={dismiss.label}
            title={dismiss.label}
            onClick={dismiss.onClick}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}
