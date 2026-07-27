import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getDatabaseUrl } from "./database-url.js";
import { ENV, environment } from "./environment.js";
import { decryptSecret, encryptSecret } from "./secret-cipher.js";
import { ScopedAuthorizationService } from "./scoped-authorization.js";

export class McpSecretService {
  private readonly pool: Pool;
  private readonly authorization: ScopedAuthorizationService;
  constructor(pool?: Pool, authorization?: ScopedAuthorizationService) {
    this.pool =
      pool || new Pool({ connectionString: getDatabaseUrl() || "postgres://missing-database-url" });
    this.authorization = authorization || new ScopedAuthorizationService(this.pool);
  }

  private masterKey(): string {
    const key = environment.optionalString(ENV.PIWORK_MCP_MASTER_KEY, false);
    if (!key) throw new Error("PIWORK_MCP_MASTER_KEY is required for MCP secrets.");
    return key;
  }

  async create(input: {
    actorUserId: string;
    tenantId: string;
    membershipId?: string;
    purpose: string;
    plaintext: string;
  }) {
    if (!input.membershipId)
      await this.authorization.require(input.actorUserId, "mcp:manage", {
        tenantId: input.tenantId,
      });
    const id = randomUUID();
    const payload = encryptSecret(input.plaintext, this.masterKey(), 1, `${input.tenantId}:${id}`);
    await this.pool.query(
      `insert into encrypted_secrets
       (id,tenant_id,owner_membership_id,purpose,ciphertext,iv,auth_tag,key_version,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.tenantId,
        input.membershipId || null,
        input.purpose,
        payload.ciphertext,
        payload.iv,
        payload.authTag,
        payload.keyVersion,
        input.actorUserId,
      ],
    );
    return {
      id,
      tenantId: input.tenantId,
      ownerMembershipId: input.membershipId || null,
      purpose: input.purpose,
      keyVersion: 1,
    };
  }

  async revealForRuntime(id: string, tenantId: string): Promise<string> {
    const result = await this.pool.query(
      `select ciphertext,iv,auth_tag,key_version from encrypted_secrets
       where id=$1 and tenant_id=$2 and revoked_at is null`,
      [id, tenantId],
    );
    if (!result.rows[0]) throw new Error("MCP secret not found or revoked.");
    await this.pool.query(`update encrypted_secrets set last_used_at=now() where id=$1`, [id]);
    return decryptSecret(
      {
        ciphertext: result.rows[0].ciphertext,
        iv: result.rows[0].iv,
        authTag: result.rows[0].auth_tag,
        keyVersion: Number(result.rows[0].key_version),
      },
      this.masterKey(),
      `${tenantId}:${id}`,
    );
  }

  async revoke(
    actorUserId: string,
    tenantId: string,
    membershipId: string,
    id: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `select owner_membership_id from encrypted_secrets where id=$1 and tenant_id=$2`,
      [id, tenantId],
    );
    if (!result.rows[0]) throw new Error("MCP secret not found.");
    if (result.rows[0].owner_membership_id && result.rows[0].owner_membership_id !== membershipId) {
      throw new Error("Forbidden by scoped authorization.");
    }
    if (!result.rows[0].owner_membership_id)
      await this.authorization.require(actorUserId, "mcp:manage", { tenantId });
    await this.pool.query(
      `update encrypted_secrets set revoked_at=now() where id=$1 and tenant_id=$2`,
      [id, tenantId],
    );
  }
}
