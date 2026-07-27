import { ENV, environment } from "./environment.js";

/** Lightweight database configuration shared by auth and control-plane services. */
export function getDatabaseUrl(): string {
  return environment.optionalString(ENV.DATABASE_URL, false)?.trim() || "";
}
