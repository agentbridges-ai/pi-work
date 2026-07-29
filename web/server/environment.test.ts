import { describe, expect, it } from "vitest";
import { ENV } from "./environment.js";

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
});
