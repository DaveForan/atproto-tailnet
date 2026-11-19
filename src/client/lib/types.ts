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
  notificationWebhookUrl?: string | null;
  hasWebhookSecret?: boolean;
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
  owner?: OwnerRef | null;
}

export interface OwnerRef {
  userId: string;
  handle: string;
}

export interface AuthKeyInfo {
  id: string;
  prefix: string;
  owner: OwnerRef | null;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
}

export type NotificationType =
  | "device_approval_requested"
  | "join_request"
  | "service_device_approval_requested"
  | "service_approval_requested"
  | "device_limit_reached";

export interface AppNotification {
  id: string;
  type: NotificationType | string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationList {
  notifications: AppNotification[];
  unreadCount: number;
}

export interface WebhookTestResult {
  ok: boolean;
  status?: number;
  error?: string;
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
  peerDid: string;
  peerName?: string | null;
  peerBrokerUrl?: string | null;
  direction: "incoming" | "outgoing";
  status: "pending" | "active" | "rejected" | "revoked";
  localCidrs?: string[] | null;
  peerCidrs?: string[] | null;
  message?: string | null;
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

export interface UsageLimits {
  maxDevices: number;
  maxMembers: number;
}

export interface UsageData {
  current: {
    devices: number;
    onlineDevices: number;
    members: number;
    routes?: number;
  };
  limits: UsageLimits;
  overLimit: {
    devices: boolean;
    members: boolean;
  };
  history: UsageSnapshot[];
}

export interface UsageSnapshot {
  id: string;
  deviceCount: number;
  memberCount: number;
  routeCount: number;
  onlineDevices: number;
  recordedAt: string;
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
  description?: string | null;
  serviceDeviceId: string;
  status: "pending" | "active" | "disabled";
  ownerId?: string;
  ownerHandle?: string;
  ownerDisplayName?: string | null;
  deviceName?: string;
  createdAt: string;
}

export interface BoardPost {
  id: string;
  title: string;
  description?: string | null;
  status: "active" | "removed";
  serviceId: string;
  serviceName?: string;
  serviceUrl?: string;
  authorId: string;
  authorHandle: string;
  authorDisplayName?: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorHandle?: string;
  actorDisplayName?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogPage {
  entries: AuditEntry[];
  total: number;
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

export type FederationScope = "local" | "regional" | "global";

export interface ScopePolicyConfig {
  autoAccept: boolean;
  verification: "standard" | "strict";
}

export interface ScopeData {
  scopes: FederationScope[];
  region: string | null;
  coordinates: [number, number] | null;
  scopePolicies: Partial<Record<FederationScope, ScopePolicyConfig>> | null;
}

export interface ScopeUpdate {
  scopes: FederationScope[];
  region?: string;
  coordinates?: [number, number];
  scopePolicies?: Partial<Record<FederationScope, ScopePolicyConfig>>;
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
export type AuthKeyResponse =
  | { key: string; command: string; loginServer: string }
  | { approvalId: string; status: "pending_approval" };

export interface AuthKeyOptions {
  reusable?: boolean;
  expiresInHours?: number;
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
  challenge: { nonce: string; issuedAt: string; expiresAt: string };
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
