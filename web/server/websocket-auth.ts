export interface SocketAuthBinding {
  userId: string;
  tenantId: string;
}

export interface SocketAuthState {
  identityUserId: string | null;
  activeTenantId: string | null;
  runtimeUserId: string | null;
  runtimeTenantId: string | null;
  authorityActive: boolean;
}

/** The live identity must still match the exact user/tenant bound at upgrade. */
export function socketAuthorizationMatches(
  binding: SocketAuthBinding,
  state: SocketAuthState,
): boolean {
  return (
    state.identityUserId === binding.userId &&
    state.activeTenantId === binding.tenantId &&
    state.runtimeUserId === binding.userId &&
    state.runtimeTenantId === binding.tenantId &&
    state.authorityActive
  );
}

/** Close idle sockets too, so revoked clients cannot keep receiving output. */
export function startPeriodicSocketAuthorization(
  validate: () => Promise<boolean>,
  onExpired: () => void,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void validate()
      .then((valid) => {
        if (!valid) onExpired();
      })
      .catch(onExpired);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
