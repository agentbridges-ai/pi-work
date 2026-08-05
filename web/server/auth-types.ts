export interface AuthenticatedUser {
  userId: string;
  uuid: string;
  username: string;
  displayName: string;
  orgId: string;
  orgName: string;
  /** Active tenant context. orgId/orgName remain during the compatibility migration. */
  tenantId?: string;
  tenantName?: string;
  tenantType?: "enterprise" | "team" | "personal";
  membershipId?: string;
  orgNodeId?: string;
  roles: string[];
  email?: string;
  permissions?: string[];
  departments?: Array<{
    id: string;
    name: string;
    parentId: string | null;
    primary: boolean;
  }>;
}
