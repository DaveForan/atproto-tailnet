/**
 * @module credentials/issuer
 * Issue VC-JWT credentials signed by a collective's Ed25519 key (ADR-0012).
 */

import * as jose from "jose";
import { randomBytes } from "node:crypto";
import type {
  CredentialType,
  MembershipCredential,
  RoleAttestationCredential,
  CapabilityToken,
  SignedCredential,
  CredentialBundle,
  HolderBindingChallenge,
} from "./types.js";

const DEFAULT_MEMBERSHIP_TTL_HOURS = 24;
const DEFAULT_CAPABILITY_TTL_HOURS = 4;
const DEFAULT_ROLE_TTL_HOURS = 24;

type SigningKey = jose.CryptoKey | jose.KeyObject;

export interface IssuerKeyPair {
  privateKey: SigningKey;
  publicKey: SigningKey;
  did: string;
}

export async function generateIssuerKeyPair(did: string): Promise<IssuerKeyPair> {
  const { privateKey, publicKey } = await jose.generateKeyPair("EdDSA", {
    crv: "Ed25519",
  });
  return { privateKey, publicKey, did };
}

export async function importIssuerKeyPair(
  did: string,
  privateKeyJwk: jose.JWK,
  publicKeyJwk: jose.JWK,
): Promise<IssuerKeyPair> {
  const privateKey = await jose.importJWK(privateKeyJwk, "EdDSA");
  const publicKey = await jose.importJWK(publicKeyJwk, "EdDSA");
  return { privateKey: privateKey as SigningKey, publicKey: publicKey as SigningKey, did };
}

async function signCredentialJwt(
  issuer: IssuerKeyPair,
  subject: string,
  credentialType: CredentialType,
  claims: Record<string, unknown>,
  ttlHours: number,
): Promise<{ jwt: string; issuedAt: Date; expiresAt: Date }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000);
  const credentialId = randomBytes(16).toString("hex");

  const jwt = await new jose.SignJWT({
    vc: {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiableCredential", credentialType],
      credentialSubject: { id: subject, ...claims },
    },
    jti: credentialId,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(issuer.did)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(issuer.privateKey);

  return { jwt, issuedAt: now, expiresAt };
}

export async function issueMembershipCredential(
  issuer: IssuerKeyPair,
  subject: Omit<MembershipCredential, "id">,
  userDid: string,
  ttlHours = DEFAULT_MEMBERSHIP_TTL_HOURS,
): Promise<SignedCredential> {
  const { jwt, issuedAt, expiresAt } = await signCredentialJwt(
    issuer,
    userDid,
    "MembershipCredential",
    {
      collectiveDid: subject.collectiveDid,
      collectiveId: subject.collectiveId,
      collectiveName: subject.collectiveName,
      joinedAt: subject.joinedAt,
    },
    ttlHours,
  );

  return {
    type: "MembershipCredential",
    jwt,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    issuerDid: issuer.did,
  };
}

export async function issueRoleAttestation(
  issuer: IssuerKeyPair,
  subject: Omit<RoleAttestationCredential, "id">,
  userDid: string,
  ttlHours = DEFAULT_ROLE_TTL_HOURS,
): Promise<SignedCredential> {
  const { jwt, issuedAt, expiresAt } = await signCredentialJwt(
    issuer,
    userDid,
    "RoleAttestationCredential",
    {
      collectiveDid: subject.collectiveDid,
      collectiveId: subject.collectiveId,
      permissions: subject.permissions,
    },
    ttlHours,
  );

  return {
    type: "RoleAttestationCredential",
    jwt,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    issuerDid: issuer.did,
  };
}

export async function issueCapabilityToken(
  issuer: IssuerKeyPair,
  subject: Omit<CapabilityToken, "id">,
  userDid: string,
  ttlHours = DEFAULT_CAPABILITY_TTL_HOURS,
): Promise<SignedCredential> {
  const { jwt, issuedAt, expiresAt } = await signCredentialJwt(
    issuer,
    userDid,
    "CapabilityToken",
    {
      collectiveDid: subject.collectiveDid,
      scope: subject.scope,
      traversalPath: subject.traversalPath,
    },
    ttlHours,
  );

  return {
    type: "CapabilityToken",
    jwt,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    issuerDid: issuer.did,
  };
}

export function assembleBundle(
  holderDid: string,
  credentials: SignedCredential[],
): CredentialBundle {
  return {
    holder: holderDid,
    credentials,
    assembledAt: new Date().toISOString(),
  };
}

export function generateHolderChallenge(ttlSeconds = 60): HolderBindingChallenge {
  const now = new Date();
  return {
    nonce: randomBytes(32).toString("base64url"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
}
