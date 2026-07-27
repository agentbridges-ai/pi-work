import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  CheckCircle2,
  FileLock2,
  Network,
  PackageCheck,
  RefreshCw,
  Upload,
} from "lucide-react";
import { api, type GovernedAgent, type TenantMembership } from "../api.js";
import { uiCopy } from "../ui-copy.js";

export function AgentGovernancePanel() {
  const [agents, setAgents] = useState<GovernedAgent[]>([]);
  const [tenant, setTenant] = useState<TenantMembership | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.listGovernedAgents();
      setAgents(result.agents);
      setTenant(result.tenant);
      setSelectedId((current) => current || result.agents[0]?.id || "");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  const selected = agents.find((agent) => agent.id === selectedId) || null;
  useEffect(
    () => setInstructions(selected?.draft.instructions || ""),
    [selected?.id, selected?.draft.instructions],
  );

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      await api.updateGovernedAgentDraft(selected.id, { ...selected.draft, instructions });
      setMessage(uiCopy.agentGovernance.savedMessage);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      await api.updateGovernedAgentDraft(selected.id, { ...selected.draft, instructions });
      const result = await api.publishGovernedAgent(selected.id);
      setMessage(uiCopy.agentGovernance.publishedMessage(result.version.version));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[19rem_1fr]"
      aria-label={uiCopy.agentGovernance.governance}
    >
      <aside className="overflow-y-auto border-b border-border bg-muted/20 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              {tenant?.tenantType || "tenant"}
            </div>
            <h2 className="mt-1 text-lg font-semibold text-foreground">
              {tenant?.tenantName || uiCopy.agentGovernance.controlPlane}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={uiCopy.agentGovernance.refresh}
          >
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="space-y-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setSelectedId(agent.id)}
              className={`w-full rounded-lg px-3 py-3 text-left transition-colors ${selectedId === agent.id ? "bg-foreground text-background" : "hover:bg-accent"}`}
            >
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{agent.name}</span>
              </div>
              <div
                className={`mt-1.5 text-xs ${selectedId === agent.id ? "text-background/65" : "text-muted-foreground"}`}
              >
                {agent.currentVersionId
                  ? uiCopy.agentGovernance.published
                  : uiCopy.agentGovernance.draftOnly}{" "}
                · {agent.kind}
              </div>
            </button>
          ))}
          {!busy && agents.length === 0 && (
            <p className="px-3 py-8 text-sm leading-6 text-muted-foreground">
              {uiCopy.agentGovernance.empty}
            </p>
          )}
        </div>
      </aside>

      <div className="min-h-0 overflow-y-auto p-5 sm:p-7">
        {selected ? (
          <div className="mx-auto max-w-4xl">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {selected.name}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selected.description || uiCopy.agentGovernance.defaultDescription}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save()}
                  className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                >
                  {uiCopy.agentGovernance.saveDraft}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void publish()}
                  className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  <Upload className="h-4 w-4" />
                  {uiCopy.agentGovernance.publish}
                </button>
              </div>
            </div>
            {message && (
              <div
                role="status"
                className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
              >
                {message}
              </div>
            )}
            <label className="mt-6 block">
              <span className="text-sm font-semibold text-foreground">
                {uiCopy.agentGovernance.instructions}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                {uiCopy.agentGovernance.instructionsHint}
              </span>
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={10}
                className="mt-2 w-full resize-y rounded-lg border border-border bg-background p-4 text-sm leading-6 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                placeholder={uiCopy.agentGovernance.instructionsPlaceholder}
              />
            </label>
            <div className="mt-7 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              <PolicyStat
                icon={FileLock2}
                label={uiCopy.agentGovernance.knowledgeDirectories}
                value={selected.draft.knowledgeRootIds.length}
              />
              <PolicyStat
                icon={PackageCheck}
                label={uiCopy.agentGovernance.approvedSkills}
                value={selected.draft.skillPackageIds.length}
              />
              <PolicyStat
                icon={Network}
                label={uiCopy.agentGovernance.mcpConnections}
                value={selected.draft.mcpConnectionIds.length}
              />
              <PolicyStat
                icon={CheckCircle2}
                label={uiCopy.agentGovernance.networkPolicies}
                value={selected.draft.networkPolicyId ? 1 : 0}
              />
            </div>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              {uiCopy.agentGovernance.policyHint}
            </p>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {uiCopy.agentGovernance.selectAgent}
          </div>
        )}
      </div>
    </section>
  );
}

function PolicyStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3 bg-card px-4 py-4">
      <Icon className="h-4 w-4 text-primary" />
      <span className="flex-1 text-sm text-muted-foreground">{label}</span>
      <strong className="text-sm text-foreground">{value}</strong>
    </div>
  );
}
