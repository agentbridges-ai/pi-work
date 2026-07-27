import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { initAnalytics } from "./analytics.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { clientEnvironment } from "./environment.js";
import { previewResourceRegistry } from "./components/preview-resource-registry.js";
import "./index.css";
import { disposeLoadedUserSpaceRuntimeState } from "./user-space-runtime-lifecycle.js";
import { disconnectAll } from "./ws-runtime-lifecycle.js";
import { PwaPlatformGate } from "./components/PwaPlatformGate.js";
import { cleanupPiworkPwa } from "./pwa/cleanup.js";
import { initializePwaLifecycle } from "./pwa/lifecycle.js";
import { collectPlatformSupport } from "./pwa/platform-support.js";
import { installKeyboardNavigationMode } from "./keyboard-navigation-mode.js";

initAnalytics();

const root = createRoot(document.getElementById("root")!);
const platformSupport = collectPlatformSupport();
const disposeKeyboardNavigationMode = installKeyboardNavigationMode();
let pageRuntimeDisposed = false;

function disposePageRuntime(event: PageTransitionEvent): void {
  if (event.persisted || pageRuntimeDisposed) return;
  pageRuntimeDisposed = true;
  disconnectAll();
  disposeKeyboardNavigationMode();
  disposeLoadedUserSpaceRuntimeState();
  previewResourceRegistry.revokeAll();
  root.unmount();
}

window.addEventListener("pagehide", disposePageRuntime, { once: true });

root.render(
  <StrictMode>
    <AppErrorBoundary>
      <PwaPlatformGate support={platformSupport}>
        <App />
      </PwaPlatformGate>
    </AppErrorBoundary>
  </StrictMode>,
);

if (clientEnvironment.isDevelopment) {
  void import("./perf/user-space-perf-driver.js").catch(() => {});
  void cleanupPiworkPwa({ includeCurrent: true, includeLegacy: true }).catch(() => {});
} else if (!platformSupport.supported || !platformSupport.pwa.available) {
  void cleanupPiworkPwa({ includeCurrent: true, includeLegacy: true }).catch(() => {});
} else {
  void cleanupPiworkPwa({ includeCurrent: false, includeLegacy: true }).catch(() => {});
  void initializePwaLifecycle(true);
}
