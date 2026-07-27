import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { trustedBrowserOrigins } from "./browser-request-security.js";
import { getDatabaseUrl } from "./database-url.js";
import { ENV, environment } from "./environment.js";

export { getDatabaseUrl } from "./database-url.js";

export function assertBetterAuthDatabaseConfigured(): void {
  if (!getDatabaseUrl()) {
    throw new Error(
      "DATABASE_URL is required for Better Auth + Postgres. Create a Postgres database, set DATABASE_URL, then run make auth-migrate.",
    );
  }
}

function baseUrl(): string {
  const configured = environment.optionalString(ENV.BETTER_AUTH_URL, false)?.trim();
  if (configured) return configured;
  return trustedBrowserOrigins()[0];
}

export const betterAuthPool = new Pool({
  connectionString: getDatabaseUrl() || "postgres://missing-database-url",
});

export async function checkBetterAuthDatabaseReady(timeoutMs = 1_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      betterAuthPool.query("select 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database readiness timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const auth = betterAuth({
  appName: "Piwork",
  baseURL: baseUrl(),
  basePath: "/api/auth",
  secret: environment.optionalString(ENV.BETTER_AUTH_SECRET, false) || undefined,
  database: betterAuthPool,
  emailAndPassword: {
    enabled: true,
    disableSignUp: false,
    requireEmailVerification: false,
    autoSignIn: true,
  },
  emailVerification: {
    sendOnSignUp: false,
    sendOnSignIn: false,
  },
  trustedOrigins: trustedBrowserOrigins(),
});

export type BetterAuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
