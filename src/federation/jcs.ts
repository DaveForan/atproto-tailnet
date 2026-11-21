/**
 * @module federation/jcs
 * RFC 8785 JSON Canonicalization Scheme: the signing form of CFP messages, shared with the Rust coordinator.
 * Both implementations pass the vectors in `coordinator/crates/coord-federation/tests/fixtures/cfp_vectors.json`.
 */

export class JcsError extends Error {}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new JcsError("JCS: string contains a lone surrogate");
  return JSON.stringify(s);
}

function serialize(value: unknown, depth: number): string {
  if (depth > 64) throw new JcsError("JCS: nesting too deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new JcsError("JCS: non-finite number");
      // ECMAScript Number::toString matches RFC 8785 §3.2.2.3 exactly (-0 serialises as "0").
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : serialize(v, depth + 1))).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${serializeString(k)}:${serialize(obj[k], depth + 1)}`).join(",")}}`;
    }
    default:
      throw new JcsError(`JCS: cannot serialise ${typeof value}`);
  }
}

/** RFC 8785 canonical JSON text of `value`. Throws {@link JcsError} on unrepresentable input. */
export function canonicalize(value: unknown): string {
  return serialize(value, 0);
}
