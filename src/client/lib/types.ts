export interface User {
  id: string;
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  features?: { federation?: boolean };
  isOperator?: boolean;
  canCreateTailnet?: boolean;
  access?: "member" | "no_access";
  /** Signed in with a recovery code: must trust this device before anything else. */
  mustEnrollDevice?: boolean;
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
  /** The instance runs the Rust coordinator (no per-tailnet Headscale container). */
  coordinatorMode?: boolean;
  suspended?: boolean;
  /** Primary public address label (`<address>.<BASE_DOMAIN>`). */
  address?: string;
}

export interface TailnetHostname {
  name: string;
  primary: boolean;
  createdAt: string;
  retiredAt: string | null;
}

export interface HostnamesData {
  baseDomain: string;
  /** URL devices use as --login-server. */
  loginServer: string;
  /** True when all tailnets share one control URL (the address is then a public name only). */
  sharedControl: boolean;
  primary: string;
  hostnames: TailnetHostname[];
  canManage: boolean;
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
  inviteeDid?: string;
  inviteeDisplayName?: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  createdAt: string;
  inviteUrl?: string;
}

export interface InvitationDetail {
  id: string;
  tenant: { id: string; name: string; address: string | null };
  inviterHandle: string;
  status: "pending" | "accepted" | "declined" | "revoked";
}

export interface InstanceInfo {
  name?: string;
  /** `address` is the public name (never the internal slug). */
  defaultTailnet: { id: string; address: string; name: string; acceptsJoinRequests: boolean } | null;
  inviteOnly: boolean;
}

export interface PublicTenant {
  id: string;
  address: string;
  name: string;
  joinOpen: boolean;
}

export interface MyJoinRequest {
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
}

export interface OperatorTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  suspended: boolean;
  parentId: string | null;
  createdAt: string;
  owner: { userId: string; did: string; handle: string } | null;
  memberCount: number;
  deviceCount: number | null;
}

export interface OperatorUser {
  id: string;
  did: string;
  handle: string;
  createdAt: string;
  disabled: boolean;
  tenantCount: number;
  isOperator: boolean;
}

export interface OperatorSettings {
  singleTailnet: boolean;
  defaultTailnetId: string | null;
}

export interface OperatorAuditEntry {
  id: string;
  tenantId: string | null;
  tenantSlug: string | null;
  actorUserId: string;
  actorHandle: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface OperatorAuditPage {
  entries: OperatorAuditEntry[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface OperatorOverview {
  tenants: OperatorTenant[];
  users: OperatorUser[];
  settings: OperatorSettings;
}

export interface TailnetCreator {
  id: string;
  did: string;
  handle: string | null;
  addedBy: string;
  createdAt: string;
  hasTailnet: boolean;
}

export interface McpConnection {
  id: string;
  clientName: string;
  /** Grant includes the instance-operator scope. */
  operator?: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Device {
  id: string;
  name: string;
  givenName?: string;
  ipAddresses: string[];
  online: boolean;
  lastSeen?: string;
  owner?: OwnerRef | null;
  /** Who must admit the device before it gets access. `none`: admitted. */
  hold?: DeviceHold;
  fingerprint?: string | null;
  os?: string | null;
}

export type DeviceHold = "none" | "approver" | "owner";

/** A device that waits for admission. */
export interface WaitingDevice {
  id: string;
  name: string;
  os: string;
  /** Short form of the key that the device made. It identifies that exact machine. */
  fingerprint: string;
  hold: DeviceHold;
  /** The caller may take the next step for this device. */
  canAdmit: boolean;
  /** When the device is removed if nobody admits it. */
  expiresAt: string | null;
  owner: OwnerRef | null;
}

export interface OwnDeviceApproval {
  on: boolean;
  /** The tailnet's second approval forces it on. */
  locked: boolean;
  /** After the caller admits a new device, another member must admit it too. */
  needsApprover?: boolean;
  supported?: boolean;
}

export interface WaitingDevices {
  /** The caller's own devices that wait. */
  mine: WaitingDevice[];
  /** Devices of other members that the caller may admit as an approver. */
  queue: WaitingDevice[];
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
  /** Hours after which a device that waits for admission is removed. */
  waitingDeviceHours: number;
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
  requesterHandle: string;
  requesterDisplayName?: string | null;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
}

export interface JoinRequest {
  id: string;
  requesterHandle: string;
  requesterDisplayName?: string | null;
  message?: string | null;
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

export interface HealthData {
  status: string;
  healthy?: boolean;
  message?: string;
}

export interface TraversalEvalResult {
  allowed: boolean;
  matchedRule?: string;
  detail?: string;
}

export interface DeviceLockInfo {
  memberId: string;
  locked: boolean;
}

export type AuthKeyResponse =
  | { key: string; command: string; loginServer: string }
  | { approvalId: string; status: "pending_approval" };

export interface AuthKeyOptions {
  reusable?: boolean;
  expiresInHours?: number;
}

// The ACL policy in flattened form.
export interface AclData {
  acls: AclRule[];
  groups: Record<string, string[]>;
  hosts: Record<string, string>;
  tagOwners?: Record<string, string[]>;
  autoApprovers?: Record<string, string[]>;
}

export interface AclGetResponse {
  policy: AclData;
  users: string[];
}

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
  | "overview"
  | "devices"
  | "people"
  | "board"
  | "sharing"
  | "settings"
  | "account"
  | "instance";

export type SettingsSectionId =
  | "security"
  | "limits"
  | "notifications"
  | "roles"
  | "acl"
  | "relays"
  | "routes"
  | "ipconfig"
  | "agents"
  | "collectives"
  | "audit"
  | "federation"
  | "traversal"
  | "credentials";
