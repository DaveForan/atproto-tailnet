import { describe, it, expect } from "vitest";
import { demuxDockerStream } from "../orchestrator/headscale.js";

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("demuxDockerStream", () => {
  it("strips frame headers so no control bytes reach the output", () => {
    const { stdout } = demuxDockerStream(frame(1, "hskey-api-abc123-secret\n"));
    expect(stdout).toBe("hskey-api-abc123-secret\n");
    expect(stdout).not.toContain("\0");
  });

  it("separates stdout from stderr across interleaved frames", () => {
    const raw = Buffer.concat([
      frame(2, "WRN deprecated flag\n"),
      frame(1, "line one\n"),
      frame(2, "WRN again\n"),
      frame(1, "the-key\n"),
    ]);
    expect(demuxDockerStream(raw)).toEqual({
      stdout: "line one\nthe-key\n",
      stderr: "WRN deprecated flag\nWRN again\n",
    });
  });

  it("handles empty output and empty frames", () => {
    expect(demuxDockerStream(Buffer.alloc(0))).toEqual({ stdout: "", stderr: "" });
    expect(demuxDockerStream(frame(1, ""))).toEqual({ stdout: "", stderr: "" });
  });

  it("passes unframed (TTY) output through unchanged", () => {
    expect(demuxDockerStream(Buffer.from("plain tty output\n"))).toEqual({
      stdout: "plain tty output\n",
      stderr: "",
    });
  });

  it("does not misread a truncated frame", () => {
    const truncated = frame(1, "complete").subarray(0, 12);
    expect(demuxDockerStream(truncated).stdout).toBe(truncated.toString());
  });
});
