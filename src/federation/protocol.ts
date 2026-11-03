/**
 * @module federation/protocol
 * Collective Federation Protocol (CFP) message types and constants (ADR-0014).
 */

export const CFP_VERSION = "1.0.0";
export const MAX_MESSAGE_BYTES = 1_048_576; // 1MB
export const DEFAULT_KEEPALIVE_SECONDS = 60;
export const KEEPALIVE_RANGE = { min: 10, max: 300 } as const;
export const HELLO_RATE_LIMIT_PER_DID = 10; // per minute
export const CHALLENGE_EXPIRY_DEFAULT_SECONDS = 120;
export const CHALLENGE_EXPIRY_MAX_SECONDS = 600;
export const DRAIN_PERIOD_SECONDS = 30;

export type FederationType = "peer" | "parent-child" | "transit" | "mesh";

export type Capability =
  | "route-exchange"
  | "dns-forward"
  | "transit"
  | "mesh";

export interface FederationDescriptor {
  collectiveDid: string;
  cfpVersions: string[];
  federationPolicy: "open" | "selective" | "closed";
  capabilities: Capability[];
  derpEndpoints: string[];
  brokerUrl: string;
  signature: string; // detached JWS
}

export type HandshakePhase = "idle" | "hello_sent" | "challenge_sent" | "commit_sent" | "established" | "failed";

export interface HelloMessage {
  type: "HELLO";
  collectiveDid: string;
  federationType: FederationType;
  offeredCidrs: string[];
  capabilities: Capability[];
  protocolVersion: string;
  meshId?: string;
  signature: string;
  timestamp: string;
}

export interface ChallengeMessage {
  type: "CHALLENGE";
  collectiveDid: string;
  nonce: string;
  expiresAt: string;
  acceptedType: FederationType;
  acceptedCidrs: string[];
  acceptedCapabilities: Capability[];
  negotiatedVersion: string;
  negotiatedKeepaliveSeconds: number;
  signature: string;
  timestamp: string;
}

export interface CommitMessage {
  type: "COMMIT";
  collectiveDid: string;
  challengeNonce: string;
  challengeSignature: string; // signed nonce proving identity
  initialRoutes: RouteAnnouncement[];
  signature: string;
  timestamp: string;
}

export interface EstablishedMessage {
  type: "ESTABLISHED";
  sessionId: string;
  collectiveDid: string;
  initialRoutes: RouteAnnouncement[];
  keepaliveIntervalSeconds: number;
  signature: string;
  timestamp: string;
}

export interface KeepaliveMessage {
  type: "KEEPALIVE";
  sessionId: string;
  sequenceNumber: number;
  timestamp: string;
}

export interface RouteAnnouncement {
  prefix: string;
  originDid: string;
  pathVector: string[]; // collective DIDs traversed
  communityTags?: string[];
  preference: number; // higher = more preferred
  originSignature: string; // detached JWS from origin
}

export interface RouteUpdate {
  type: "ROUTE_UPDATE";
  sessionId: string;
  announcements: RouteAnnouncement[];
  withdrawals: string[]; // prefixes being withdrawn
  continuationToken?: string;
  signature: string;
  timestamp: string;
}

export interface RevokeMessage {
  type: "REVOKE";
  sessionId: string;
  reason?: string;
  permanent: boolean;
  signature: string;
  timestamp: string;
}

export type CFPMessage =
  | HelloMessage
  | ChallengeMessage
  | CommitMessage
  | EstablishedMessage
  | KeepaliveMessage
  | RouteUpdate
  | RevokeMessage;
