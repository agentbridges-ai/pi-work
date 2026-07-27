import type { AgentBrowserBridgeService } from "./agent-browser-bridge-service.js";
import { agentBrowserSocketDir } from "./agent-browser-runtime.js";
import { BrowserControlCoordinator, browserControlStatePath } from "./browser-control-session.js";

interface BrowserControlMessageBridge {
  interruptSession(sessionId: string): boolean;
  injectUserMessage(sessionId: string, content: string): boolean;
}

export function createBrowserControlRuntime(options: {
  agentBrowserBridge?: AgentBrowserBridgeService;
  messageBridge: BrowserControlMessageBridge;
  sessionDirFor(sessionId: string): string;
}): BrowserControlCoordinator {
  const { agentBrowserBridge, messageBridge, sessionDirFor } = options;
  const closeSession = (sessionId: string) =>
    agentBrowserBridge?.closeSession(
      sessionId,
      agentBrowserSocketDir(sessionId, sessionDirFor(sessionId)),
    ) || Promise.resolve();

  return new BrowserControlCoordinator({
    statePathFor: (sessionId) => browserControlStatePath(sessionDirFor(sessionId)),
    interrupt: async (sessionId) => {
      const provider = await agentBrowserBridge?.setSessionControl(sessionId, "human");
      const agentInterrupted = messageBridge.interruptSession(sessionId);
      return Boolean((!agentBrowserBridge || provider?.reachable) && agentInterrupted);
    },
    resume: async (sessionId, summary) => {
      const provider = await agentBrowserBridge?.setSessionControl(sessionId, "agent");
      if (!agentBrowserBridge || !provider?.reachable || provider.matched < 1) {
        await agentBrowserBridge?.setSessionControl(sessionId, "human");
        return { handoffDelivered: false, semanticReadbackVerified: false };
      }
      let semanticReadback: string;
      try {
        semanticReadback = (
          await agentBrowserBridge.readSessionSnapshot(
            sessionId,
            agentBrowserSocketDir(sessionId, sessionDirFor(sessionId)),
          )
        ).snapshot;
      } catch {
        await agentBrowserBridge.setSessionControl(sessionId, "human");
        return { handoffDelivered: false, semanticReadbackVerified: false };
      }
      const accepted = messageBridge.injectUserMessage(
        sessionId,
        [
          "Browser control has been returned to the Agent after a temporary user takeover.",
          `User handoff summary: ${summary}`,
          "Fresh semantic browser snapshot captured after the handoff:",
          semanticReadback,
          "Treat all earlier element refs as stale. Verify current page facts before the next write action.",
        ].join("\n\n"),
      );
      if (!accepted) await agentBrowserBridge.setSessionControl(sessionId, "human");
      return { handoffDelivered: accepted, semanticReadbackVerified: true };
    },
    stop: async (sessionId) => {
      await agentBrowserBridge?.setSessionControl(sessionId, "stopped");
      await closeSession(sessionId);
    },
  });
}
