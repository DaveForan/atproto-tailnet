import { describe, it, expect } from "vitest";
import {
  createSession,
  generateKeepalive,
  handleKeepaliveReceived,
  checkKeepaliveHealth,
  initiateRevoke,
  finalizeRevoke,
  handleRemoteRevoke,
} from "../federation/session.js";
import type { RevokeMessage } from "../federation/protocol.js";

describe("FederationSession", () => {
  it("creates a session in established state", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", ["10.0.0.0/8"], ["route-exchange"], 60,
    );
    expect(session.status).toBe("established");
    expect(session.sessionId).toBe("sess-1");
    expect(session.missedKeepalives).toBe(0);
  });

  it("generates keepalive with incrementing sequence", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", [], [], 60,
    );
    const ka1 = generateKeepalive(session);
    expect(ka1.type).toBe("KEEPALIVE");
    expect(ka1.sequenceNumber).toBe(1);

    const ka2 = generateKeepalive(session);
    expect(ka2.sequenceNumber).toBe(2);
  });

  it("resets missed count on keepalive received", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", [], [], 60,
    );
    session.missedKeepalives = 3;
    session.status = "degraded";

    handleKeepaliveReceived(session);
    expect(session.missedKeepalives).toBe(0);
    expect(session.status).toBe("established");
  });

  it("degrades after 3 missed keepalives", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", [], [], 1,
    );
    session.lastKeepaliveReceived = new Date(Date.now() - 4000);

    const status = checkKeepaliveHealth(session);
    expect(status).toBe("degraded");
    expect(session.status).toBe("degraded");
  });

  it("marks down after 5 missed keepalives", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", [], [], 1,
    );
    session.lastKeepaliveReceived = new Date(Date.now() - 6000);

    const status = checkKeepaliveHealth(session);
    expect(status).toBe("down");
    expect(session.status).toBe("down");
  });

  it("initiates graceful revocation with drain period", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", [], [], 60,
    );
    const { message, drainDeadline } = initiateRevoke(session, "maintenance", false);
    expect(session.status).toBe("draining");
    expect(message.type).toBe("REVOKE");
    expect(message.permanent).toBe(false);
    expect(drainDeadline.getTime()).toBeGreaterThan(Date.now());
  });

  it("finalizes revocation", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", [], [], 60,
    );
    session.status = "draining";
    finalizeRevoke(session);
    expect(session.status).toBe("revoked");
  });

  it("handles remote revoke", () => {
    const session = createSession(
      "sess-1", "did:web:a", "did:web:b", "peer", [], [], 60,
    );
    const msg: RevokeMessage = {
      type: "REVOKE",
      sessionId: "sess-1",
      permanent: true,
      signature: "",
      timestamp: new Date().toISOString(),
    };
    handleRemoteRevoke(session, msg);
    expect(session.status).toBe("revoked");
  });
});
