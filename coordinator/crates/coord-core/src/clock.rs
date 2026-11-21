//! UTC timestamps and their text forms.
//! The text forms are part of the wire and storage format: the TS service and stored rows parse them.

use time::format_description::well_known::Rfc3339;
pub use time::{Duration, OffsetDateTime};
use time::{PrimitiveDateTime, UtcOffset};

/// The current time in UTC.
pub fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

/// The UTC time at `secs` Unix seconds, or `None` out of range.
pub fn from_unix(secs: i64) -> Option<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp(secs).ok()
}

/// 1970-01-01T00:00:00Z.
pub const EPOCH: OffsetDateTime = OffsetDateTime::UNIX_EPOCH;

fn utc_parts(t: OffsetDateTime) -> String {
    let t = t.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

/// Fraction with 0, 3, 6 or 9 digits, as few as keep the value exact.
fn fraction(t: OffsetDateTime) -> String {
    let ns = t.nanosecond();
    if ns == 0 {
        String::new()
    } else if ns.is_multiple_of(1_000_000) {
        format!(".{:03}", ns / 1_000_000)
    } else if ns.is_multiple_of(1_000) {
        format!(".{:06}", ns / 1_000)
    } else {
        format!(".{ns:09}")
    }
}

/// RFC 3339 with a `+00:00` offset, for example `2026-11-20T12:00:00.123456+00:00`.
pub fn to_rfc3339(t: OffsetDateTime) -> String {
    format!("{}{}+00:00", utc_parts(t), fraction(t))
}

/// RFC 3339 with a `Z` offset, for example `2026-11-20T12:00:00.123456Z`. This is the serde form.
pub fn to_rfc3339_z(t: OffsetDateTime) -> String {
    format!("{}{}Z", utc_parts(t), fraction(t))
}

/// RFC 3339 in whole seconds with a `Z` offset, for example `2026-11-20T12:00:00Z`.
pub fn to_rfc3339_secs(t: OffsetDateTime) -> String {
    format!("{}Z", utc_parts(t))
}

/// Parses RFC 3339 with any offset and returns the time in UTC.
pub fn parse_rfc3339(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok().map(|t| t.to_offset(UtcOffset::UTC))
}

/// SQLite text form, the same as `datetime('now')`: `2026-11-20 12:00:00`, UTC, whole seconds.
/// Stored rows compare as strings, so the format must not change.
pub fn to_sqlite(t: OffsetDateTime) -> String {
    utc_parts(t).replacen('T', " ", 1)
}

/// Parses SQLite text: `datetime('now')` form, `YYYY-MM-DDTHH:MM:SS[.f]` (UTC), or RFC 3339.
pub fn parse_sqlite(s: &str) -> Option<OffsetDateTime> {
    use time::macros::format_description;
    let space = format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
    let t_sep = format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
    let t_frac = format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]");
    PrimitiveDateTime::parse(s, space)
        .or_else(|_| PrimitiveDateTime::parse(s, t_sep))
        .or_else(|_| PrimitiveDateTime::parse(s, t_frac))
        .map(PrimitiveDateTime::assume_utc)
        .ok()
        .or_else(|| parse_rfc3339(s))
}

/// Serde as an RFC 3339 string with `Z`. Use with `#[serde(with = "coord_core::clock::serde_rfc3339")]`.
pub mod serde_rfc3339 {
    use super::OffsetDateTime;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(t: &OffsetDateTime, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::to_rfc3339_z(*t))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<OffsetDateTime, D::Error> {
        let s = String::deserialize(d)?;
        super::parse_rfc3339(&s).ok_or_else(|| serde::de::Error::custom(format!("invalid RFC 3339 time: {s}")))
    }

    /// The same for `Option<OffsetDateTime>`; `None` is `null`.
    pub mod option {
        use super::OffsetDateTime;
        use serde::{Deserialize, Deserializer, Serializer};

        pub fn serialize<S: Serializer>(t: &Option<OffsetDateTime>, s: S) -> Result<S::Ok, S::Error> {
            match t {
                Some(t) => s.serialize_str(&super::super::to_rfc3339_z(*t)),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<OffsetDateTime>, D::Error> {
            match Option::<String>::deserialize(d)? {
                Some(s) => super::super::parse_rfc3339(&s)
                    .map(Some)
                    .ok_or_else(|| serde::de::Error::custom(format!("invalid RFC 3339 time: {s}"))),
                None => Ok(None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ns: u32) -> OffsetDateTime {
        parse_rfc3339("2026-11-20T12:00:05Z").unwrap().replace_nanosecond(ns).unwrap()
    }

    #[test]
    fn rfc3339_text_forms_are_fixed() {
        assert_eq!(to_rfc3339(at(0)), "2026-11-20T12:00:05+00:00");
        assert_eq!(to_rfc3339(at(120_000_000)), "2026-11-20T12:00:05.120+00:00");
        assert_eq!(to_rfc3339(at(123_456_000)), "2026-11-20T12:00:05.123456+00:00");
        assert_eq!(to_rfc3339(at(123_456_789)), "2026-11-20T12:00:05.123456789+00:00");
        assert_eq!(to_rfc3339(at(1)), "2026-11-20T12:00:05.000000001+00:00");
        assert_eq!(to_rfc3339_z(at(515_068_417)), "2026-11-20T12:00:05.515068417Z");
        assert_eq!(to_rfc3339_z(at(0)), "2026-11-20T12:00:05Z");
        assert_eq!(to_rfc3339_secs(at(999_999_999)), "2026-11-20T12:00:05Z");
        assert_eq!(to_rfc3339(EPOCH), "1970-01-01T00:00:00+00:00");
    }

    #[test]
    fn offsets_normalise_to_utc() {
        let t = parse_rfc3339("2026-11-20T14:30:00.5+02:30").unwrap();
        assert_eq!(to_rfc3339(t), "2026-11-20T12:00:00.500+00:00");
        assert!(parse_rfc3339("not a time").is_none());
    }

    #[test]
    fn sqlite_text_round_trips_and_reads_old_forms() {
        assert_eq!(to_sqlite(at(999_000_000)), "2026-11-20 12:00:05");
        let want = at(0);
        assert_eq!(parse_sqlite("2026-11-20 12:00:05"), Some(want));
        assert_eq!(parse_sqlite("2026-11-20T12:00:05"), Some(want));
        assert_eq!(parse_sqlite("2026-11-20T12:00:05.25"), Some(at(250_000_000)));
        assert_eq!(parse_sqlite("2026-11-20T12:00:05+00:00"), Some(want));
        assert!(parse_sqlite("garbage").is_none());
    }

    #[test]
    fn serde_form_reads_both_offsets() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct W {
            #[serde(with = "serde_rfc3339")]
            a: OffsetDateTime,
            #[serde(with = "serde_rfc3339::option", default)]
            b: Option<OffsetDateTime>,
        }
        let w = W { a: at(515_068_417), b: None };
        let json = serde_json::to_string(&w).unwrap();
        assert_eq!(json, r#"{"a":"2026-11-20T12:00:05.515068417Z","b":null}"#);
        assert_eq!(serde_json::from_str::<W>(&json).unwrap(), w);
        let old: W = serde_json::from_str(r#"{"a":"2026-11-20T12:00:05.515068417+00:00"}"#).unwrap();
        assert_eq!(old.a, at(515_068_417));
    }
}
