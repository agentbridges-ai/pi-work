import { join } from "node:path";
import { homedir } from "node:os";
import { environment, ENV } from "./environment.js";

/**
 * Base directory for all Piwork configuration and state.
 * Defaults to ~/.piwork/ for self-hosted installs.
 * Override with PIWORK_HOME env var for managed deployments
 * (e.g. PIWORK_HOME=/data/piwork on Fly.io volumes).
 */
export const PIWORK_HOME = environment.string(ENV.PIWORK_HOME, join(homedir(), ".piwork"), false);
