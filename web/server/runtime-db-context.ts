import { AsyncLocalStorage } from "node:async_hooks";

export interface RuntimeDbContext {
  userId: string;
  tenantId?: string;
  membershipId?: string;
  orgNodeId?: string;
}

const storage = new AsyncLocalStorage<RuntimeDbContext>();

export function getRuntimeDbContext(): RuntimeDbContext | undefined {
  return storage.getStore();
}

export async function runWithRuntimeDbContext<T>(
  context: RuntimeDbContext,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...context }, operation);
}

export function isCompleteRuntimeDbContext(
  context: RuntimeDbContext | undefined,
): context is RuntimeDbContext & {
  tenantId: string;
  membershipId: string;
  orgNodeId: string;
} {
  return Boolean(context?.userId && context.tenantId && context.membershipId && context.orgNodeId);
}
