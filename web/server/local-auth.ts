import { auth } from "./better-auth.js";
import type { AuthenticatedUser } from "./auth-types.js";
import { LocalUserProfileStore, type LocalUserProfileRecord } from "./local-user-profile-store.js";
import { LocalUserPreferencesStore } from "./local-user-preferences-store.js";
import type { RbacService } from "./rbac-service.js";
import { environment } from "./environment.js";
import { isLoopbackHost } from "./network-security.js";

export type LocalAuthResult =
  | {
      ok: true;
      user: LocalUserProfileRecord;
    }
  | {
      ok: false;
      response: Response;
    };

export type LocalIdentityAuthResult =
  | {
      ok: true;
      user: AuthenticatedUser;
    }
  | {
      ok: false;
      response: Response;
    };

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function publicUser(user: AuthenticatedUser): AuthenticatedUser {
  return {
    userId: user.userId,
    uuid: user.uuid,
    username: user.username,
    displayName: user.displayName,
    orgId: user.orgId,
    orgName: user.orgName,
    tenantId: user.tenantId,
    tenantName: user.tenantName,
    tenantType: user.tenantType,
    membershipId: user.membershipId,
    roles: user.roles,
    email: user.email,
    permissions: user.permissions || [],
    departments: user.departments || [],
  };
}

function usernameFromEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapBetterAuthUser(user: {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}): AuthenticatedUser & { uuid: string } {
  const userId = user.id.trim();
  const email = user.email.trim().toLowerCase();
  const displayName = user.name?.trim() || email;
  return {
    userId,
    uuid: userId,
    username: usernameFromEmail(email),
    displayName,
    orgId: "local",
    orgName: "Local",
    roles: ["user"],
    email,
  };
}

export class LocalAuth {
  private readonly profiles = new LocalUserProfileStore();
  private readonly preferences = new LocalUserPreferencesStore();

  constructor(
    private readonly rbac?: RbacService,
    private readonly resolveActiveUser: (
      user: AuthenticatedUser,
    ) => Promise<AuthenticatedUser> = async (user) => user,
    private readonly listenerHost = environment.host,
  ) {}

  private async isPublicRegistrationEnabled(): Promise<boolean> {
    if (!isLoopbackHost(this.listenerHost)) return false;
    return this.rbac ? this.rbac.isRegistrationEnabled().catch(() => false) : true;
  }

  /** Resolve only the live Better Auth identity, without mutating user data. */
  async getSessionUser(headers: Headers): Promise<AuthenticatedUser | null> {
    const session = await auth.api.getSession({ headers });
    return session?.user ? mapBetterAuthUser(session.user) : null;
  }

  /** Authenticate the Better Auth session without product-state side effects. */
  async authenticateIdentity(req: Request): Promise<LocalIdentityAuthResult> {
    const user = await this.getSessionUser(req.headers);
    return user
      ? { ok: true, user }
      : { ok: false, response: json({ error: "Unauthorized" }, { status: 401 }) };
  }

  async handlePublicRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/mode" && req.method === "GET") {
      const signUpEnabled = await this.isPublicRegistrationEnabled();
      return json({
        mode: "better-auth",
        runtimeMode: "local",
        emailAndPassword: true,
        signUpEnabled,
      });
    }
    if (url.pathname.startsWith("/api/auth/")) {
      if (url.pathname.startsWith("/api/auth/sign-up/")) {
        const signUpEnabled = await this.isPublicRegistrationEnabled();
        if (!signUpEnabled) return json({ error: "Registration is disabled." }, { status: 403 });
      }
      return auth.handler(req);
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
      const authResult = await this.authenticate(req);
      if (!authResult.ok) return authResult.response;
      const activeUser = await this.resolveActiveUser(authResult.user);
      return json({
        runtimeMode: "local",
        user: publicUser(activeUser),
      });
    }
    if (url.pathname === "/api/preferences" && req.method === "GET") {
      const authResult = await this.authenticate(req);
      if (!authResult.ok) return authResult.response;
      return json({ preferences: this.preferences.read(authResult.user.uuid) });
    }
    if (url.pathname === "/api/preferences" && req.method === "PUT") {
      const authResult = await this.authenticate(req);
      if (!authResult.ok) return authResult.response;
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const value =
        body && typeof body === "object" && "preferences" in body
          ? (body as { preferences: unknown }).preferences
          : body;
      return json({ preferences: this.preferences.write(authResult.user.uuid, value) });
    }
    return null;
  }

  async authenticate(req: Request): Promise<LocalAuthResult> {
    const identity = await this.authenticateIdentity(req);
    if (!identity.ok) return identity;
    const mapped = identity.user;
    const user = this.profiles.writeSeenProfile(mapped);
    if (!this.rbac) return { ok: true, user };
    const enriched = await this.rbac.syncAuthenticatedUser(user);
    return {
      ok: true,
      user: {
        ...user,
        roles: enriched.roles,
        permissions: enriched.permissions,
        departments: enriched.departments,
      },
    };
  }
}
