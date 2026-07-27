export interface TenantRuntimeStatus {
  tenantId: string;
  state: "missing" | "provisioning" | "ready" | "degraded" | "stopped";
  endpoint?: string;
  checkedAt: string;
  message?: string;
}

export interface TenantRuntimeDriver {
  provision(tenantId: string): Promise<TenantRuntimeStatus>;
  resolveEndpoint(tenantId: string): Promise<URL>;
  status(tenantId: string): Promise<TenantRuntimeStatus>;
  restart(tenantId: string): Promise<TenantRuntimeStatus>;
  stop(tenantId: string): Promise<TenantRuntimeStatus>;
}

export class EmbeddedTenantRuntimeDriver implements TenantRuntimeDriver {
  constructor(private readonly baseUrl: URL) {}
  private result(tenantId: string, state: TenantRuntimeStatus["state"]): TenantRuntimeStatus {
    return {
      tenantId,
      state,
      endpoint: this.baseUrl.toString(),
      checkedAt: new Date().toISOString(),
    };
  }
  async provision(tenantId: string) {
    return this.result(tenantId, "ready");
  }
  async resolveEndpoint(_tenantId: string) {
    return new URL(this.baseUrl);
  }
  async status(tenantId: string) {
    return this.result(tenantId, "ready");
  }
  async restart(tenantId: string) {
    return this.result(tenantId, "ready");
  }
  async stop(tenantId: string) {
    return this.result(tenantId, "stopped");
  }
}
