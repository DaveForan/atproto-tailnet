//! RFC 8785 JSON Canonicalization Scheme (JCS) — the single signing
//! canonicalization of CFP messages, shared with the TypeScript service
//! (`src/federation/jcs.ts`). Both are pinned by `tests/fixtures/cfp_vectors.json`.
//!
//! - object members sorted by their names' UTF-16 code units, no whitespace
//! - strings escaped as ECMAScript `JSON.stringify` does
//! - numbers formatted as ECMAScript `Number.prototype.toString` (IEEE-754
//!   doubles; integers beyond 2^53 are rounded the way a JS peer sees them)

use std::cmp::Ordering;
use std::fmt::Write as _;

use serde_json::Value;

/// Error for values JCS cannot represent (non-finite numbers, excessive nesting).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JcsError(pub String);

impl std::fmt::Display for JcsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JCS: {}", self.0)
    }
}

impl std::error::Error for JcsError {}

const MAX_DEPTH: usize = 64;

/// RFC 8785 canonical JSON text of `value`.
pub fn canonicalize(value: &Value) -> Result<String, JcsError> {
    let mut out = String::new();
    write_value(&mut out, value, 0)?;
    Ok(out)
}

fn write_value(out: &mut String, value: &Value, depth: usize) -> Result<(), JcsError> {
    if depth > MAX_DEPTH {
        return Err(JcsError("nesting too deep".into()));
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n)?,
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| utf16_cmp(a.0, b.0));
            out.push('{');
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_value(out, v, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// ECMAScript `JSON.stringify` string escaping.
fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0A}' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\u{0D}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn write_number(out: &mut String, n: &serde_json::Number) -> Result<(), JcsError> {
    if let Some(u) = n.as_u64() {
        if u <= MAX_SAFE_INTEGER {
            let _ = write!(out, "{u}");
            return Ok(());
        }
    } else if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= MAX_SAFE_INTEGER {
            let _ = write!(out, "{i}");
            return Ok(());
        }
    }
    let f = n
        .as_f64()
        .ok_or_else(|| JcsError("number not representable as f64".into()))?;
    out.push_str(&es_number_to_string(f)?);
    Ok(())
}

/// ECMAScript `Number::toString(x)` (ECMA-262 §6.1.6.1.20) for finite doubles.
pub fn es_number_to_string(f: f64) -> Result<String, JcsError> {
    if !f.is_finite() {
        return Err(JcsError("non-finite number".into()));
    }
    if f == 0.0 {
        return Ok("0".into());
    }
    let mut out = String::new();
    if f < 0.0 {
        out.push('-');
    }
    // Rust's `{:e}` prints the shortest digits that round-trip, like ES.
    let sci = format!("{:e}", f.abs());
    let (mantissa, exp) = sci
        .split_once('e')
        .ok_or_else(|| JcsError("unexpected float format".into()))?;
    let exp: i32 = exp
        .parse()
        .map_err(|_| JcsError("unexpected float exponent".into()))?;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1; // value = 0.d1d2…dk × 10^n

    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        let _ = write!(out, "{}", (n - 1).abs());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // The vectors are written as published (ECMAScript / RFC 8785 examples)
    #[allow(clippy::excessive_precision)]
    fn es_numbers() {
        let cases: &[(f64, &str)] = &[
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (123.456, "123.456"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (333333333.33333329, "333333333.3333333"),
            (-0.0, "0"),
        ];
        for (f, s) in cases {
            assert_eq!(es_number_to_string(*f).unwrap(), *s, "{f}");
        }
        assert!(es_number_to_string(f64::NAN).is_err());
    }

    #[test]
    fn sorts_by_utf16_code_units() {
        // U+FB33 sorts after U+1F600 in UTF-16 (surrogates are 0xD83D…) but
        // before it in UTF-8 / code point order.
        let v: Value = serde_json::from_str(r#"{"דּ":1,"😀":2}"#).unwrap();
        assert_eq!(canonicalize(&v).unwrap(), "{\"\u{1F600}\":2,\"\u{FB33}\":1}");
    }
}
