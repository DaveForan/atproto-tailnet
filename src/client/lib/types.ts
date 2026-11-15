export interface User {
  id: string;
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: "provisioning" | "running" | "stopped" | "error";
  isOriginator: boolean;
  roleId?: string;
  roleName?: string;
  coordinatorTenantId?: string;
}

export interface Role {
  id: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
  isDefault?: boolean;
}

export interface Settings {
  lockdownMode: boolean;
  requireDeviceApproval: boolean;
  requireServiceDeviceApproval: boolean;
  requireServiceApproval: boolean;
  allowJoinRequests: boolean;
  allowAgentTokens: boolean;
  allowMemberAgentTokens: boolean;
  boardEnabled: boolean;
  maxBoardPosts: number;
  maxBoardPostsDisplayed: number;
  hibernateAfterDays: number;
}

export interface Invitation {
  id: string;
  tenantId: string;
  tenantName: string;
  inviterHandle: string;
  inviterDisplayName?: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  createdAt: string;
}

export interface SentInvitation {
  id: string;
  inviteeHandle: string;
  inviteeDisplayName?: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  createdAt: string;
}

export interface Device {
  id: string;
  name: string;
  givenName?: string;
  ipAddresses: string[];
  online: boolean;
  lastSeen?: string;
}

export interface DeviceGroup {
  hsUsername: string;
  devices: Device[];
}

export interface DevicesData {
  byUser: DeviceGroup[];
  total: number;
}

export interface Member {
  id: string;
  userId: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  isOriginator: boolean;
  roleId?: string;
  roleName?: string;
  isLocked?: boolean;
}

export interface FederationLink {
  id: string;
  peerName?: string;
  peerSlug: string;
  direction: "incoming" | "outgoing";
  status: "pending" | "active" | "rejected" | "revoked";
  localCidrs?: string[];
  peerCidrs?: string[];
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToken {
  id: string;
  name: string;
  tokenPrefix: string;
  ownerId: string;
  ownerHandle?: string;
  ownerDisplayName?: string;
  permissions: string[];
  status: "active" | "revoked";
  expiresAt: string;
  lastUsedAt?: string;
}

export interface AclPolicy {
  acls: AclRule[];
  groups: Record<string, string[]>;
  hosts: Record<string, string>;
}

export interface AclRule {
  action: string;
  src: string[];
  dst: string[];
}

export interface DerpRegion {
  regionId: number;
  regionCode: string;
  regionName: string;
  nodes: DerpNode[];
}

export interface DerpNode {
  name: string;
  hostname: string;
  stunPort?: number;
  derpPort?: number;
}

export interface DerpConfig {
  regions: DerpRegion[];
  embeddedDerpEnabled: boolean;
  usePublicDerp: boolean;
}

export interface RouteData {
  exitNodes: RouteEntry[];
  subnets: RouteEntry[];
}

export interface RouteEntry {
  id: string;
  prefix: string;
  enabled: boolean;
  node?: { name: string; givenName?: string; online: boolean };
}

export interface UsageData {
  currentDevices: number;
  currentMembers: number;
  maxDevices: number;
  maxMembers: number;
  planName: string;
  snapshots: UsageSnapshot[];
}

export interface UsageSnapshot {
  timestamp: string;
  devices: number;
  members: number;
}

export interface ServiceDevice {
  id: string;
  name: string;
  description?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface Service {
  id: string;
  name: string;
  url: string;
  description?: string;
  serviceDeviceId: string;
  status: "pending" | "approved" | "rejected";
  isActive: boolean;
  createdAt: string;
}

export interface BoardPost {
  id: string;
  content: string;
  serviceName?: string;
  createdAt: string;
  authorHandle: string;
  authorDisplayName?: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorHandle?: string;
  actorDisplayName?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface DeviceApproval {
  id: string;
  membershipId: string;
  handle: string;
  displayName?: string;
  machineKey: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface JoinRequest {
  id: string;
  userHandle: string;
  userDisplayName?: string;
  message?: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
}

export interface IpConfig {
  ipv4Prefix: string;
  ipv6Prefix: string;
  ipAllocation: "sequential" | "random";
}

export interface Stats {
  totalDevices: number;
  onlineDevices: number;
  totalMembers: number;
}

// Federation sub-types
export interface PostureData {
  posture: string;
}

export interface ScopeData {
  allowedCidrs: string[];
  blockedCidrs: string[];
}

export interface DidData {
  did: string;
}

export interface BrokerData {
  sessionCount: number;
  importedRoutes: number;
  exportedRoutes: number;
}

// Collectives sub-types
export interface Ancestor {
  id: string;
  name: string;
  slug: string;
}

export interface SubCollective {
  id: string;
  name: string;
  slug: string;
  status: string;
  deviceCount: number;
  createdAt: string;
}

export interface ComplianceViolation {
  type: string;
  message: string;
  severity: "warning" | "error";
}

export interface ComplianceData {
  violations: ComplianceViolation[];
}

// Status sub-types
export interface HealthData {
  status: string;
  message?: string;
}

// Traversal sub-types
export interface TraversalEvalResult {
  allowed: boolean;
  matchedRule?: string;
  detail?: string;
}

// Device lock info
export interface DeviceLockInfo {
  memberId: string;
  locked: boolean;
}

// Connect tab response
export interface AuthKeyResponse {
  authKey: string;
  loginServer: string;
}

// ACL data (flattened policy)
export interface AclData {
  acls: AclRule[];
  groups: Record<string, string[]>;
  hosts: Record<string, string>;
  tagOwners?: Record<string, string[]>;
  autoApprovers?: Record<string, string[]>;
}

// ACL API response
export interface AclGetResponse {
  policy: AclData;
  users: string[];
}

// Credential service types
export interface CredentialResult {
  jwt?: string;
  bundle?: string;
}

export interface VerifyResult {
  valid: boolean;
  claims?: Record<string, unknown>;
  error?: string;
}

export interface ChallengeResult {
  challenge: string;
}

export type TabId =
  | "status"
  | "derp"
  | "ipconfig"
  | "routes"
  | "devices"
  | "members"
  | "connect"
  | "invite"
  | "services"
  | "board"
  | "federation"
  | "collectives"
  | "traversal"
  | "roles"
  | "agents"
  | "acl"
  | "credentials"
  | "usage"
  | "security"
  | "audit";
