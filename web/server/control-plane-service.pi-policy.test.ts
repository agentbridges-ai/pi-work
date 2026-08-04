import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSecretService } from "./mcp-secret-service.js";
import { ControlPlaneService } from "./control-plane-service.js";

vi.mock("pg", () => ({
  Pool: class MockPool {},
}));

function queryResult(rows: Array<Record<string, unknown>> = []) {
  return { rows, rowCount: rows.length };
}

const emptyResources = {
  knowledgeRootIds: [],
  skillPackageIds: [],
  mcpConnectionIds: [],
};

describe("Agent Pi publication policy", () => {
  it("publishes the immutable general Agent during personal tenant initialization", async () => {
    const draft = {
      ...emptyResources,
      modelAllowlist: ["*/*"],
      defaultThinkingLevel: "medium",
    };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.startsWith("select current_version_id, draft")) {
        return queryResult([{ current_version_id: null, draft }]);
      }
      if (normalized.includes("coalesce(max(version)")) {
        return queryResult([{ version: 1 }]);
      }
      return queryResult();
    });
    const service = new ControlPlaneService({ query: vi.fn() } as unknown as Pool);

    await (
      service as unknown as {
        ensureGeneralAgent(
          db: { query: typeof query },
          tenantId: string,
          membershipId: string,
          userId: string,
        ): Promise<void>;
      }
    ).ensureGeneralAgent({ query }, "tenant-1", "membership-1", "user-1");

    const versionInsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into agent_versions"),
    );
    expect(versionInsert?.[1]?.[1]).toBe("general-membership-1");
    expect(versionInsert?.[1]?.[3]).toBe(JSON.stringify(draft));
    expect(versionInsert?.[1]?.[4]).toBe(
      createHash("sha256").update(JSON.stringify(draft)).digest("hex"),
    );
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).replace(/\s+/gu, " ").includes("set current_version_id=$1"),
      ),
    ).toBe(true);
  });

  it("publishes only the normalized Pi model policy and hashes that exact snapshot", async () => {
    const draft = {
      ...emptyResources,
      mcpConnectionIds: ["mcp-1"],
      modelAllowlist: [" openai/gpt-* ", "openai/gpt-*"],
      defaultModel: {
        key: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
      },
      defaultThinkingLevel: "high",
    };
    const client = {
      query: vi.fn(async (sql: string, _params?: unknown[]) => {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        if (normalized.includes("from tenant_memberships m join tenants")) {
          return queryResult([
            {
              id: "membership-1",
              tenant_id: "tenant-1",
              tenant_name: "Tenant",
              tenant_type: "personal",
              user_id: "user-1",
              status: "active",
              is_default: true,
            },
          ]);
        }
        if (normalized.startsWith("select * from agent_definitions")) {
          return queryResult([{ id: "agent-1", owner_membership_id: "membership-1", draft }]);
        }
        if (normalized.startsWith("select id from mcp_connections")) {
          expect(_params).toEqual(["tenant-1", ["mcp-1"], "membership-1"]);
          return queryResult([{ id: "mcp-1" }]);
        }
        if (normalized.includes("coalesce(max(version)")) {
          return queryResult([{ version: 3 }]);
        }
        return queryResult();
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from tenant_memberships m join tenants")) {
          return queryResult([
            {
              id: "membership-1",
              tenant_id: "tenant-1",
              tenant_name: "Tenant",
              tenant_type: "personal",
              user_id: "user-1",
              status: "active",
              is_default: true,
            },
          ]);
        }
        return queryResult();
      }),
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const service = new ControlPlaneService(pool);

    const published = await service.publishOwnedAgent("user-1", "tenant-1", "agent-1");

    const expectedConfig = {
      ...emptyResources,
      mcpConnectionIds: ["mcp-1"],
      modelAllowlist: ["openai/gpt-*"],
      defaultModel: draft.defaultModel,
      defaultThinkingLevel: "high",
    };
    const insert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into agent_versions"),
    );
    expect(insert?.[1]?.[3]).toBe(JSON.stringify(expectedConfig));
    expect(insert?.[1]?.[4]).toBe(
      createHash("sha256").update(JSON.stringify(expectedConfig)).digest("hex"),
    );
    expect(published.config).toEqual(expectedConfig);
  });
});

describe("pinned Pi session authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves non-secret Agent model policy without materializing MCP credentials", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([
          {
            id: "membership-1",
            tenant_id: "tenant-1",
            tenant_name: "Tenant",
            tenant_type: "personal",
            user_id: "user-1",
            status: "active",
            is_default: true,
          },
        ]);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        return queryResult([{ allowed: true }]);
      }
      if (normalized.startsWith("select v.config from agent_definitions")) {
        return queryResult([
          {
            config: {
              ...emptyResources,
              mcpConnectionIds: ["mcp-secret"],
              modelAllowlist: ["openai/gpt-*"],
              defaultThinkingLevel: "low",
            },
          },
        ]);
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    const reveal = vi
      .spyOn(McpSecretService.prototype, "revealForRuntime")
      .mockResolvedValue("must-not-be-read");
    const service = new ControlPlaneService({ query } as unknown as Pool);

    await expect(service.resolveAgentModelPolicy("user-1", "tenant-1", "agent-1")).resolves.toEqual(
      {
        modelAllowlist: ["openai/gpt-*"],
        defaultThinkingLevel: "low",
      },
    );
    expect(reveal).not.toHaveBeenCalled();
  });

  it("maps the legacy default agent alias to the governed general Agent", async () => {
    const generalAgentId = "general-membership-1";
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([
          {
            id: "membership-1",
            tenant_id: "tenant-1",
            tenant_name: "Tenant",
            tenant_type: "personal",
            user_id: "user-1",
            status: "active",
            is_default: true,
          },
        ]);
      }
      if (normalized.startsWith("select a.id, a.tenant_id")) {
        return queryResult([
          {
            id: generalAgentId,
            tenant_id: "tenant-1",
            owner_membership_id: "membership-1",
            kind: "general",
            name: "通用 Agent",
            description: "",
            immutable: true,
            current_version_id: "version-1",
            draft: {
              ...emptyResources,
              modelAllowlist: ["*/*"],
              defaultThinkingLevel: "medium",
            },
            created_at: new Date(0),
            updated_at: new Date(0),
          },
        ]);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        expect(params?.[2]).toBe(generalAgentId);
        return queryResult([{ allowed: true }]);
      }
      if (normalized.startsWith("select v.config from agent_definitions")) {
        expect(params?.[0]).toBe(generalAgentId);
        return queryResult([
          {
            config: {
              ...emptyResources,
              modelAllowlist: ["*/*"],
              defaultThinkingLevel: "medium",
            },
          },
        ]);
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    const service = new ControlPlaneService({ query } as unknown as Pool);

    await expect(service.resolveAgentModelPolicy("user-1", "tenant-1", "agent")).resolves.toEqual({
      modelAllowlist: ["*/*"],
      defaultThinkingLevel: "medium",
    });
  });

  it("resolves the exact immutable Agent version with in-memory managed MCP credentials", async () => {
    const hash = "a".repeat(64);
    const authority = {
      tenantId: "tenant-1",
      userId: "user-1",
      membershipId: "membership-1",
      orgNodeId: "org-root",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-2",
      effectivePolicyHash: hash,
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([
          {
            id: "membership-1",
            tenant_id: "tenant-1",
            tenant_name: "Tenant",
            tenant_type: "personal",
            user_id: "user-1",
            status: "active",
            is_default: true,
          },
        ]);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        return queryResult([{ allowed: true }]);
      }
      if (
        normalized.includes("join agent_versions v on v.agent_definition_id=a.id") &&
        normalized.includes("v.id=$3")
      ) {
        expect(params).toEqual(["agent-1", "tenant-1", "version-2", hash]);
        expect(normalized).not.toContain("current_version_id");
        return queryResult([
          {
            agent_definition_id: "agent-1",
            agent_version_id: "version-2",
            effective_policy_hash: hash,
            config: {
              ...emptyResources,
              mcpConnectionIds: ["mcp-stdio", "mcp-sse", "mcp-http"],
              modelAllowlist: ["openai/gpt-*"],
              defaultModel: {
                key: "openai/gpt-5",
                provider: "openai",
                modelId: "gpt-5",
              },
              defaultThinkingLevel: "minimal",
            },
          },
        ]);
      }
      if (normalized.includes("from mcp_connections")) {
        expect(normalized).toContain("owner_membership_id is null");
        expect(normalized).toContain("user_id=$3");
        expect(params).toEqual(["tenant-1", ["mcp-stdio", "mcp-sse", "mcp-http"], "user-1"]);
        return queryResult([
          {
            id: "mcp-stdio",
            name: "local_index",
            transport: "stdio",
            secret_id: null,
            config: {
              command: "/usr/bin/local-index-mcp",
              args: ["--read-only"],
              env: { LOG_LEVEL: "warn" },
            },
          },
          {
            id: "mcp-sse",
            name: "events",
            transport: "sse",
            secret_id: null,
            config: {
              url: "https://mcp.example.test/events",
            },
          },
          {
            id: "mcp-http",
            name: "documents",
            transport: "streamable-http",
            secret_id: "secret-1",
            config: {
              url: "https://mcp.example.test/rpc",
              toolPolicies: { search: { readOnly: true } },
            },
          },
        ]);
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    vi.spyOn(McpSecretService.prototype, "revealForRuntime").mockResolvedValue("mcp-secret-canary");
    const service = new ControlPlaneService({ query } as unknown as Pool);

    const resolved = await service.resolvePinnedSessionAuthority(authority);

    expect(resolved.authority).toEqual(authority);
    expect(resolved.launch.modelPolicy).toEqual({
      modelAllowlist: ["openai/gpt-*"],
      defaultModel: {
        key: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
      },
      defaultThinkingLevel: "minimal",
    });
    expect(resolved.launch.managedMcpServers).toEqual([
      {
        name: "local_index",
        enabled: true,
        transport: "stdio",
        command: "/usr/bin/local-index-mcp",
        args: ["--read-only"],
        env: { LOG_LEVEL: "warn" },
      },
      {
        name: "events",
        enabled: true,
        transport: "sse",
        url: "https://mcp.example.test/events",
      },
      {
        name: "documents",
        enabled: true,
        transport: "streamable-http",
        url: "https://mcp.example.test/rpc",
        toolPolicies: { search: { readOnly: true } },
      },
    ]);
    expect(JSON.stringify(resolved.launch)).not.toContain("mcp-secret-canary");
    expect(resolved.launch).not.toHaveProperty("secretEnv");
    expect(resolved.launch).not.toHaveProperty("mcpServers");
  });

  it("fails closed for a changed version hash before materializing runtime resources", async () => {
    const hash = "b".repeat(64);
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([
          {
            id: "membership-1",
            tenant_id: "tenant-1",
            tenant_name: "Tenant",
            tenant_type: "personal",
            user_id: "user-1",
            status: "active",
            is_default: true,
          },
        ]);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        return queryResult([{ allowed: true }]);
      }
      return queryResult();
    });
    const reveal = vi
      .spyOn(McpSecretService.prototype, "revealForRuntime")
      .mockResolvedValue("must-not-be-read");
    const service = new ControlPlaneService({ query } as unknown as Pool);

    await expect(
      service.resolvePinnedSessionAuthority({
        tenantId: "tenant-1",
        userId: "user-1",
        membershipId: "membership-1",
        orgNodeId: "org-root",
        agentDefinitionId: "agent-1",
        agentVersionId: "version-2",
        effectivePolicyHash: hash,
      }),
    ).rejects.toThrow("no longer valid");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("rejects malformed pinned authority before any database or secret access", async () => {
    const query = vi.fn();
    const reveal = vi
      .spyOn(McpSecretService.prototype, "revealForRuntime")
      .mockResolvedValue("must-not-be-read");
    const service = new ControlPlaneService({ query } as unknown as Pool);
    await expect(
      service.resolvePinnedSessionAuthority({
        tenantId: "tenant-1",
        userId: "user-1",
        membershipId: "membership-1",
        orgNodeId: "org-root",
        agentDefinitionId: "agent-1",
        agentVersionId: "version-1",
        effectivePolicyHash: "not-a-sha256",
      }),
    ).rejects.toThrow("Pinned Agent authority is invalid");
    expect(query).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("fails closed when current grants or published policy disappear", async () => {
    const membership = {
      id: "membership-1",
      tenant_id: "tenant-1",
      tenant_name: "Tenant",
      tenant_type: "personal",
      user_id: "user-1",
      status: "active",
      is_default: true,
    };
    const deniedQuery = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([membership]);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        return queryResult();
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    const denied = new ControlPlaneService({ query: deniedQuery } as unknown as Pool);
    await expect(denied.resolveSessionAuthority("user-1", "tenant-1", "agent-1")).rejects.toThrow(
      "not found or not granted",
    );
    await expect(denied.resolveAgentModelPolicy("user-1", "tenant-1", "agent-1")).rejects.toThrow(
      "not found or not granted",
    );

    const unpublishedQuery = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([membership]);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        return queryResult([{ allowed: true }]);
      }
      if (
        normalized.includes("join agent_versions v on v.id = a.current_version_id") ||
        normalized.startsWith("select v.config from agent_definitions")
      ) {
        return queryResult();
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    const unpublished = new ControlPlaneService({ query: unpublishedQuery } as unknown as Pool);
    await expect(
      unpublished.resolveSessionAuthority("user-1", "tenant-1", "agent-1"),
    ).rejects.toThrow("Agent has no published version");
    await expect(
      unpublished.resolveAgentModelPolicy("user-1", "tenant-1", "agent-1"),
    ).rejects.toThrow("Agent has no published version");
  });

  it("rechecks both current grant and exact immutable version for active sessions", async () => {
    const hash = "c".repeat(64);
    const authority = {
      tenantId: "tenant-1",
      userId: "user-1",
      membershipId: "membership-1",
      orgNodeId: "org-root",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      effectivePolicyHash: hash,
    };
    const membership = {
      id: "membership-1",
      tenant_id: "tenant-1",
      tenant_name: "Tenant",
      tenant_type: "personal",
      user_id: "user-1",
      status: "active",
      is_default: true,
    };
    let pinned = true;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([membership]);
      }
      if (normalized.includes("join agent_versions v on v.agent_definition_id=a.id")) {
        expect(params).toEqual(["agent-1", "tenant-1", "version-1", hash]);
        return queryResult(pinned ? [{ active: true }] : []);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        return queryResult([{ allowed: true }]);
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    const service = new ControlPlaneService({ query } as unknown as Pool);
    await expect(service.isSessionAuthorityActive(authority)).resolves.toBe(true);
    pinned = false;
    await expect(service.isSessionAuthorityActive(authority)).resolves.toBe(false);

    const broken = new ControlPlaneService({
      query: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as Pool);
    await expect(broken.isSessionAuthorityActive(authority)).resolves.toBe(false);
  });

  it.each([
    {
      label: "knowledge",
      config: { ...emptyResources, knowledgeRootIds: ["knowledge-1"] },
      error: "knowledge authority",
    },
    {
      label: "network",
      config: { ...emptyResources, networkPolicyId: "network-1" },
      error: "network authority",
    },
    {
      label: "Skill",
      config: { ...emptyResources, skillPackageIds: ["skill-1"] },
      error: "Skill authority",
    },
    {
      label: "MCP",
      config: { ...emptyResources, mcpConnectionIds: ["mcp-1"] },
      error: "MCP authority",
    },
  ])("rejects missing pinned $label resources", async ({ config, error }) => {
    const hash = "d".repeat(64);
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("from tenant_memberships m join tenants")) {
        return queryResult([
          {
            id: "membership-1",
            tenant_id: "tenant-1",
            tenant_name: "Tenant",
            tenant_type: "personal",
            user_id: "user-1",
            status: "active",
            is_default: true,
          },
        ]);
      }
      if (normalized.startsWith("select 1 from agent_definitions a")) {
        return queryResult([{ allowed: true }]);
      }
      if (
        normalized.includes("join agent_versions v on v.agent_definition_id=a.id") &&
        normalized.includes("v.id=$3")
      ) {
        return queryResult([
          {
            agent_definition_id: "agent-1",
            agent_version_id: "version-1",
            effective_policy_hash: hash,
            config,
          },
        ]);
      }
      if (
        normalized.includes("from knowledge_roots") ||
        normalized.includes("from network_policies") ||
        normalized.includes("from skill_packages") ||
        normalized.includes("from mcp_connections")
      ) {
        return queryResult();
      }
      throw new Error(`Unexpected query: ${normalized}`);
    });
    const service = new ControlPlaneService({ query } as unknown as Pool);
    await expect(
      service.resolvePinnedSessionAuthority({
        tenantId: "tenant-1",
        userId: "user-1",
        membershipId: "membership-1",
        orgNodeId: "org-root",
        agentDefinitionId: "agent-1",
        agentVersionId: "version-1",
        effectivePolicyHash: hash,
      }),
    ).rejects.toThrow(error);
  });
});

describe("ControlPlaneService scoped helpers", () => {
  it("uses query-only doubles without leaking membership or role scope", async () => {
    const membershipRow = {
      id: "membership-1",
      tenant_id: "tenant-1",
      tenant_name: "Tenant",
      tenant_type: "team",
      user_id: "user-1",
      status: "active",
      is_default: true,
      org_node_id: "org-root",
    };
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("tenant_memberships")) return queryResult([membershipRow]);
      if (normalized.includes("scoped_role_assignments")) return queryResult([{}]);
      return queryResult();
    });
    const pool = { query } as unknown as Pool;
    const service = new ControlPlaneService(pool);
    const activator = vi.fn(async () => undefined);
    const revoker = vi.fn(async () => undefined);
    service.setMembershipActivator(activator);
    service.setMembershipRevoker(revoker);

    expect(service.getDatabasePool()).toBe(pool);
    await expect(service.listMemberships("user-1")).resolves.toEqual([
      {
        id: "membership-1",
        tenantId: "tenant-1",
        tenantName: "Tenant",
        tenantType: "team",
        userId: "user-1",
        status: "active",
        isDefault: true,
        primaryOrgNodeId: "org-root",
      },
    ]);
    await expect(service.getActiveMembership("user-1")).resolves.toMatchObject({
      tenantId: "tenant-1",
      primaryOrgNodeId: "org-root",
    });
    await expect(service.can("user-1", "tenant-1", "agent:create")).resolves.toBe(true);
    await service.syncLegacySystemAdmin("user-1", true);
    await service.syncLegacySystemAdmin("user-1", false);
    expect(activator).not.toHaveBeenCalled();
    expect(revoker).not.toHaveBeenCalled();
  });
});
