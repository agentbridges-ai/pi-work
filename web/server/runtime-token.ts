import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type RuntimeAction = "provision" | "status" | "launch" | "stop";

export interface RuntimeTokenClaims {
  tenantId: string;
  userId: string;
  sessionId: string;
  agentVersionId: string;
  action: RuntimeAction;
  aud: "piwork-tenant-runtime";
  iat: number;
  exp: number;
  jti: string;
}

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function sign(value: string, secret: string): string {
  return encode(createHmac("sha256", secret).update(value).digest());
}

export function issueRuntimeToken(
  input: Omit<RuntimeTokenClaims, "aud" | "iat" | "exp" | "jti">,
  secret: string,
  options: { ttlSeconds?: number; now?: number } = {},
): string {
  if (secret.length < 32) throw new Error("Runtime token secret must be at least 32 characters.");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: RuntimeTokenClaims = {
    ...input,
    aud: "piwork-tenant-runtime",
    iat: now,
    exp: now + Math.max(1, Math.min(options.ttlSeconds ?? 60, 300)),
    jti: randomUUID(),
  };
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyRuntimeToken(
  token: string,
  secret: string,
  expected: { action: RuntimeAction; tenantId?: string; sessionId?: string },
  now = Math.floor(Date.now() / 1000),
): RuntimeTokenClaims {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("Invalid runtime token.");
  const expectedSignature = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new Error("Invalid runtime token signature.");
  let claims: RuntimeTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RuntimeTokenClaims;
  } catch {
    throw new Error("Invalid runtime token payload.");
  }
  if (claims.aud !== "piwork-tenant-runtime") throw new Error("Invalid runtime token audience.");
  if (claims.exp <= now || claims.iat > now + 5)
    throw new Error("Runtime token expired or not yet valid.");
  if (claims.action !== expected.action) throw new Error("Runtime token action mismatch.");
  if (expected.tenantId && claims.tenantId !== expected.tenantId)
    throw new Error("Runtime token tenant mismatch.");
  if (expected.sessionId && claims.sessionId !== expected.sessionId)
    throw new Error("Runtime token session mismatch.");
  if (!claims.jti || !claims.userId || !claims.agentVersionId)
    throw new Error("Incomplete runtime token.");
  return claims;
}
