/** Handles come from the account's own DID document, for accounts on any PDS. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));

import { handleFromDidDocument } from "../identity/handles.js";

describe("handleFromDidDocument", () => {
  it("reads the at:// entry of alsoKnownAs", () => {
    expect(handleFromDidDocument({ alsoKnownAs: ["at://alice.example.com"] })).toBe("alice.example.com");
    expect(handleFromDidDocument({ alsoKnownAs: ["https://x.example", "at://Bob.Example.org"] })).toBe("bob.example.org");
  });

  it("ignores documents without a usable handle", () => {
    for (const doc of [
      null,
      {},
      { alsoKnownAs: "at://alice.example.com" },
      { alsoKnownAs: [42, "https://alice.example.com"] },
      { alsoKnownAs: ["at://not a handle"] },
      { alsoKnownAs: ["at://localhost"] },
    ]) {
      expect(handleFromDidDocument(doc)).toBeNull();
    }
  });

  it("drops any path after the handle", () => {
    expect(handleFromDidDocument({ alsoKnownAs: ["at://alice.example.com/app.bsky.actor.profile/self"] })).toBe(
      "alice.example.com",
    );
  });
});
