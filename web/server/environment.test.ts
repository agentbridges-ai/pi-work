import { describe, expect, it } from "vitest";
import { ENV, validateProductionEnvironment } from "./environment.js";

const mcpMasterKey = Buffer.from("a".repeat(32)).toString("base64");

describe("ENV", () => {
  it("includes runtime variables used by local data, Pi isolation, and browser support", () => {
    expect(ENV.PIWORK_DATA_ROOT).toBe("PIWORK_DATA_ROOT");
    expect(ENV.DATABASE_URL).toBe("DATABASE_URL");
    expect(ENV.BETTER_AUTH_SECRET).toBe("BETTER_AUTH_SECRET");
    expect(ENV.BETTER_AUTH_URL).toBe("BETTER_AUTH_URL");
    expect(ENV.PIWORK_SESSION_SANDBOX).toBe("PIWORK_SESSION_SANDBOX");
    expect(ENV.PIWORK_MAINTENANCE_LOCK_DIR).toBe("PIWORK_MAINTENANCE_LOCK_DIR");
    expect(ENV.SANDBOX_RUNTIME).toBe("SANDBOX_RUNTIME");
    expect(ENV.http_proxy).toBe("http_proxy");
  });

  it("fails closed for incomplete production authentication and bounded configuration", () => {
    expect(() => validateProductionEnvironment({ NODE_ENV: "production" })).toThrow(
      "Production configuration is missing",
    );
    expect(() =>
      validateProductionEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://piwork",
        BETTER_AUTH_SECRET: "short",
        BETTER_AUTH_URL: "https://piwork.example.test/",
        PIWORK_MCP_MASTER_KEY: mcpMasterKey,
      }),
    ).toThrow("BETTER_AUTH_SECRET must be at least 32 characters");
    expect(() =>
      validateProductionEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://piwork",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://piwork.example.test/",
        PIWORK_MCP_MASTER_KEY: mcpMasterKey,
        PORT: "70000",
      }),
    ).toThrow("PORT must be an integer");
    expect(() =>
      validateProductionEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://piwork",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://piwork.example.test/",
        PIWORK_MCP_MASTER_KEY: mcpMasterKey,
        PORT: "3457",
      }),
    ).not.toThrow();
  });
});
