export const PI_PLAN_OPTIONS = ["execute", "continue_planning", "refine"] as const;

const PLAN_REQUEST_KIND = "piwork_plan_request";

interface PiPlanRequest {
  toolCallId: string;
  plan: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

export function encodePiPlanRequestTitle(toolCallId: string, plan: string): string {
  if (!nonEmptyString(toolCallId) || !nonEmptyString(plan) || plan.length > 100_000) {
    throw new Error("Plan request is invalid.");
  }
  return JSON.stringify({
    kind: PLAN_REQUEST_KIND,
    version: 1,
    toolCallId: toolCallId.trim(),
    plan: plan.trim(),
  });
}

export function parsePiPlanRequest(title: unknown, options: unknown): PiPlanRequest | undefined {
  if (
    typeof title !== "string" ||
    !Array.isArray(options) ||
    options.length !== PI_PLAN_OPTIONS.length ||
    !PI_PLAN_OPTIONS.every((option) => options.includes(option))
  ) {
    return undefined;
  }
  try {
    const payload = JSON.parse(title) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      (payload as Record<string, unknown>).kind !== PLAN_REQUEST_KIND ||
      (payload as Record<string, unknown>).version !== 1 ||
      !nonEmptyString((payload as Record<string, unknown>).toolCallId) ||
      !nonEmptyString((payload as Record<string, unknown>).plan) ||
      ((payload as Record<string, unknown>).plan as string).length > 100_000
    ) {
      return undefined;
    }
    const record = payload as Record<string, string>;
    return {
      toolCallId: record.toolCallId.trim(),
      plan: record.plan.trim(),
    };
  } catch {
    return undefined;
  }
}
