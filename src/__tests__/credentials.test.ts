import { describe, it, expect } from "vitest";
import {
  generateIssuerKeyPair,
  issueMembershipCredential,
  issueRoleAttestation,
  issueCapabilityToken,
  assembleBundle,
  generateHolderChallenge,
} from "../credentials/issuer.js";
import {
  verifyCredential,
  verifyBundle,
} from "../credentials/verifier.js";
import type { PublicKeyResolver } from "../credentials/verifier.js";
import type { IssuerKeyPair } from "../credentials/issuer.js";

const USER_DID = "did:plc:testuser123";
const COLLECTIVE_DID = "did:web:collective.example.com";

let issuer: IssuerKeyPair;
let resolver: PublicKeyResolver;

describe("credentials", () => {
  it("generates a key pair", async () => {
    issuer = await generateIssuerKeyPair(COLLECTIVE_DID);
    expect(issuer.did).toBe(COLLECTIVE_DID);
    expect(issuer.privateKey).toBeDefined();
    expect(issuer.publicKey).toBeDefined();

    resolver = {
      resolve: async (did: string) => {
        if (did === COLLECTIVE_DID) return issuer.publicKey;
        return null;
      },
    };
  });

  describe("membership credential", () => {
    it("issues and verifies a membership credential", async () => {
      const cred = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "tenant-123",
          collectiveName: "Test Collective",
          joinedAt: new Date().toISOString(),
        },
        USER_DID,
      );

      expect(cred.type).toBe("MembershipCredential");
      expect(cred.jwt).toBeTruthy();
      expect(cred.issuerDid).toBe(COLLECTIVE_DID);

      const result = await verifyCredential(cred.jwt, resolver);
      expect(result.valid).toBe(true);
      expect(result.credentialType).toBe("MembershipCredential");
      expect(result.subject).toBe(USER_DID);
      expect(result.issuer).toBe(COLLECTIVE_DID);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("rejects credential with unknown issuer", async () => {
      const cred = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "tenant-123",
          collectiveName: "Test",
          joinedAt: new Date().toISOString(),
        },
        USER_DID,
      );

      const badResolver: PublicKeyResolver = {
        resolve: async () => null,
      };

      const result = await verifyCredential(cred.jwt, badResolver);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Cannot resolve");
    });

    it("rejects tampered JWT", async () => {
      const cred = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "tenant-123",
          collectiveName: "Test",
          joinedAt: new Date().toISOString(),
        },
        USER_DID,
      );

      const tampered = cred.jwt.slice(0, -5) + "XXXXX";
      const result = await verifyCredential(tampered, resolver);
      expect(result.valid).toBe(false);
    });
  });

  describe("role attestation", () => {
    it("issues and verifies a role attestation", async () => {
      const cred = await issueRoleAttestation(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "tenant-123",
          permissions: ["manage_devices", "invite"],
        },
        USER_DID,
      );

      expect(cred.type).toBe("RoleAttestationCredential");
      const result = await verifyCredential(cred.jwt, resolver);
      expect(result.valid).toBe(true);
      expect(result.credentialType).toBe("RoleAttestationCredential");
    });
  });

  describe("capability token", () => {
    it("issues and verifies a capability token", async () => {
      const cred = await issueCapabilityToken(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          scope: ["read:devices", "write:routes"],
          traversalPath: ["collective-a", "collective-b"],
        },
        USER_DID,
      );

      expect(cred.type).toBe("CapabilityToken");
      const result = await verifyCredential(cred.jwt, resolver);
      expect(result.valid).toBe(true);
      expect(result.credentialType).toBe("CapabilityToken");
    });

    it("capability token has shorter TTL than membership", async () => {
      const membership = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "t-1",
          collectiveName: "T",
          joinedAt: new Date().toISOString(),
        },
        USER_DID,
      );

      const capability = await issueCapabilityToken(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          scope: ["read"],
        },
        USER_DID,
      );

      const mExpiry = new Date(membership.expiresAt).getTime();
      const cExpiry = new Date(capability.expiresAt).getTime();
      expect(cExpiry).toBeLessThan(mExpiry);
    });
  });

  describe("bundle", () => {
    it("assembles and verifies a bundle", async () => {
      const membershipCred = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "tenant-123",
          collectiveName: "Test",
          joinedAt: new Date().toISOString(),
        },
        USER_DID,
      );

      const roleCred = await issueRoleAttestation(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "tenant-123",
          permissions: ["invite"],
        },
        USER_DID,
      );

      const bundle = assembleBundle(USER_DID, [membershipCred, roleCred]);
      expect(bundle.holder).toBe(USER_DID);
      expect(bundle.credentials).toHaveLength(2);

      const result = await verifyBundle(bundle, resolver);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.results).toHaveLength(2);
    });

    it("rejects bundle with mismatched holder", async () => {
      const cred = await issueMembershipCredential(
        issuer,
        {
          collectiveDid: COLLECTIVE_DID,
          collectiveId: "t-1",
          collectiveName: "T",
          joinedAt: new Date().toISOString(),
        },
        USER_DID,
      );

      const bundle = assembleBundle("did:plc:wrong", [cred]);
      const result = await verifyBundle(bundle, resolver);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("does not match"))).toBe(true);
    });
  });

  describe("holder binding challenge", () => {
    it("generates a challenge with nonce and expiry", () => {
      const challenge = generateHolderChallenge(30);
      expect(challenge.nonce).toBeTruthy();
      expect(challenge.nonce.length).toBeGreaterThan(20);
      expect(new Date(challenge.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("cross-issuer verification", () => {
    it("rejects credential signed by different issuer", async () => {
      const otherIssuer = await generateIssuerKeyPair("did:web:other.example.com");
      const cred = await issueMembershipCredential(
        otherIssuer,
        {
          collectiveDid: "did:web:other.example.com",
          collectiveId: "t-2",
          collectiveName: "Other",
          joinedAt: new Date().toISOString(),
        },
        USER_DID,
      );

      const result = await verifyCredential(cred.jwt, resolver);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Cannot resolve");
    });
  });
});
