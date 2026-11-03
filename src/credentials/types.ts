/**
 * @module credentials/types
 * Types for the AT Proto identity passport system (ADR-0012).
 */

export interface CredentialSubject {
  id: string; // user DID
}

export interface MembershipCredential extends CredentialSubject {
  collectiveDid: string;
  collectiveId: string;
  collectiveName: string;
  joinedAt: string; // ISO 8601
}

export interface RoleAttestationCredential extends CredentialSubject {
  collectiveDid: string;
  collectiveId: string;
  permissions: string[];
}

export interface CapabilityToken extends CredentialSubject {
  collectiveDid: string;
  scope: string[];
  traversalPath?: string[];
}

export interface ReputationToken extends CredentialSubject {
  issuingCollectiveDid: string;
  score: number; // 0.0 - 1.0
  domain: string; // e.g. "network-citizenship", "content-quality"
}

export type CredentialType =
  | "MembershipCredential"
  | "RoleAttestationCredential"
  | "CapabilityToken"
  | "ReputationToken";

export interface CredentialBundle {
  holder: string; // user DID
  credentials: SignedCredential[];
  assembledAt: string; // ISO 8601
}

export interface SignedCredential {
  type: CredentialType;
  jwt: string;
  issuedAt: string;
  expiresAt: string;
  issuerDid: string;
}

export interface CredentialVerificationResult {
  valid: boolean;
  credentialType?: CredentialType;
  subject?: string;
  issuer?: string;
  error?: string;
  expiresAt?: Date;
}

export interface HolderBindingChallenge {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface HolderBindingProof {
  nonce: string;
  signature: string; // base64url-encoded Ed25519 signature
  did: string;
}

export interface CredentialStatusResponse {
  status: "valid" | "revoked";
  checked: string; // ISO 8601
}
