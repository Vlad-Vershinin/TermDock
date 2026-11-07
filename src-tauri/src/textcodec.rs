//! Text encodings for the built-in editor: BOM sniffing, charset detection, and
//! encoding back without silent data loss.

use std::borrow::Cow;

use encoding_rs::{EncoderResult, Encoding};
use serde::Serialize;

/// A decoded text file as sent to the editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    pub text: String,
    /// Canonical name: "UTF-8", "UTF-16LE", "windows-1251", "KOI8-R", ...
    pub encoding: String,
    pub bom: bool,
    /// Some bytes were invalid in the encoding and were replaced with U+FFFD.
    pub lossy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Codec {
    Utf8,
    Utf16 { le: bool },
    /// Real ISO-8859-1: encoding_rs maps that label to windows-1252 (WHATWG rules).
    Latin1,
    Other(&'static Encoding),
}

impl Codec {
    fn parse(name: &str) -> Result<Codec, String> {
        let n = name.trim().to_ascii_lowercase();
        Ok(match n.as_str() {
            "utf-8" | "utf8" => Codec::Utf8,
            "utf-16le" | "utf-16" | "utf16le" => Codec::Utf16 { le: true },
            "utf-16be" | "utf16be" => Codec::Utf16 { le: false },
            "iso-8859-1" | "latin1" | "iso8859-1" => Codec::Latin1,
            _ => match Encoding::for_label(n.as_bytes()) {
                Some(e) if e == encoding_rs::UTF_8 => Codec::Utf8,
                Some(e) if e == encoding_rs::UTF_16LE => Codec::Utf16 { le: true },
                Some(e) if e == encoding_rs::UTF_16BE => Codec::Utf16 { le: false },
                Some(e) if e != encoding_rs::REPLACEMENT => Codec::Other(e),
                _ => return Err(format!("неизвестная кодировка: {name}")),
            },
        })
    }

    fn name(self) -> String {
        match self {
            Codec::Utf8 => "UTF-8".into(),
            Codec::Utf16 { le: true } => "UTF-16LE".into(),
            Codec::Utf16 { le: false } => "UTF-16BE".into(),
            Codec::Latin1 => "ISO-8859-1".into(),
            Codec::Other(e) => e.name().into(),
        }
    }
}

fn sniff_bom(b: &[u8]) -> Option<(Codec, usize)> {
    if b.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some((Codec::Utf8, 3))
    } else if b.starts_with(&[0xFF, 0xFE]) {
        Some((Codec::Utf16 { le: true }, 2))
    } else if b.starts_with(&[0xFE, 0xFF]) {
        Some((Codec::Utf16 { le: false }, 2))
    } else {
        None
    }
}

fn looks_binary(b: &[u8]) -> bool {
    b.iter().take(8192).any(|&c| c == 0)
}

const BINARY: &str = "похоже на двоичный файл — встроенный редактор открывает только текст";

/// Decodes file bytes. `forced` re-decodes in a user-chosen encoding (with replacement
/// characters if the bytes don't fit); otherwise BOM → UTF-8 → charset detection.
pub fn decode(bytes: &[u8], forced: Option<&str>) -> Result<Decoded, String> {
    let bom = sniff_bom(bytes);
    let (codec, body, has_bom) = match forced {
        Some(name) => {
            let c = Codec::parse(name)?;
            match bom {
                Some((bc, n)) if bc == c => (c, &bytes[n..], true),
                _ => (c, bytes, false),
            }
        }
        None => match bom {
            Some((c, n)) => (c, &bytes[n..], true),
            None => {
                // UTF-16 always has a BOM at this point, so NULs mean binary data.
                if looks_binary(bytes) {
                    return Err(BINARY.into());
                }
                if std::str::from_utf8(bytes).is_ok() {
                    (Codec::Utf8, bytes, false)
                } else {
                    let mut det = chardetng::EncodingDetector::new();
                    det.feed(bytes, true);
                    (Codec::Other(det.guess(Some(b"ru"), false)), bytes, false)
                }
            }
        },
    };
    if forced.is_some() && !matches!(codec, Codec::Utf16 { .. }) && looks_binary(body) {
        return Err(BINARY.into());
    }
    let (text, lossy) = decode_with(codec, body);
    // chardetng reports KOI8-U for any KOI8; without Ukrainian letters both decode the same,
    // and KOI8-R is what Russian servers actually use.
    let codec = if forced.is_none() && codec == Codec::Other(encoding_rs::KOI8_U) && !text.contains(['і', 'ї', 'є', 'ґ', 'І', 'Ї', 'Є', 'Ґ']) {
        Codec::Other(encoding_rs::KOI8_R)
    } else {
        codec
    };
    Ok(Decoded { text, encoding: codec.name(), bom: has_bom, lossy })
}

fn decode_with(codec: Codec, b: &[u8]) -> (String, bool) {
    match codec {
        Codec::Utf8 => match String::from_utf8_lossy(b) {
            Cow::Borrowed(s) => (s.to_owned(), false),
            Cow::Owned(s) => (s, true),
        },
        Codec::Utf16 { le } => {
            let units = b.chunks_exact(2).map(|p| if le { u16::from_le_bytes([p[0], p[1]]) } else { u16::from_be_bytes([p[0], p[1]]) });
            let mut lossy = b.len() % 2 != 0;
            let text = char::decode_utf16(units)
                .map(|r| {
                    r.unwrap_or_else(|_| {
                        lossy = true;
                        char::REPLACEMENT_CHARACTER
                    })
                })
                .collect();
            (text, lossy)
        }
        Codec::Latin1 => (b.iter().map(|&c| c as char).collect(), false),
        Codec::Other(e) => {
            let (s, had_errors) = e.decode_without_bom_handling(b);
            (s.into_owned(), had_errors)
        }
    }
}

fn unrepresentable(text: &str, at: usize, c: char, enc: &str) -> String {
    let line = text[..at].matches('\n').count() + 1;
    format!(
        "символ «{c}» (U+{:04X}, строка {line}) нельзя сохранить в кодировке {enc}. Выберите для сохранения UTF-8 (или уберите этот символ)",
        c as u32
    )
}

/// Encodes text for writing. Fails (instead of writing '?' or HTML entities) when a
/// character has no representation in the target encoding.
pub fn encode(text: &str, encoding: &str, bom: bool) -> Result<Vec<u8>, String> {
    let codec = Codec::parse(encoding)?;
    match codec {
        Codec::Utf8 => {
            let mut out = Vec::with_capacity(text.len() + 3);
            if bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        Codec::Utf16 { le } => {
            let mut out = Vec::with_capacity(text.len() * 2 + 2);
            let mut push = |u: u16| out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
            if bom {
                push(0xFEFF);
            }
            text.encode_utf16().for_each(&mut push);
            Ok(out)
        }
        Codec::Latin1 => {
            let mut out = Vec::with_capacity(text.len());
            for (i, c) in text.char_indices() {
                if c as u32 > 0xFF {
                    return Err(unrepresentable(text, i, c, &codec.name()));
                }
                out.push(c as u8);
            }
            Ok(out)
        }
        Codec::Other(e) => {
            let mut enc = e.new_encoder();
            let mut out = Vec::with_capacity(text.len() + 16);
            let mut pos = 0;
            loop {
                let (res, read) = enc.encode_from_utf8_to_vec_without_replacement(&text[pos..], &mut out, true);
                pos += read;
                match res {
                    EncoderResult::InputEmpty => return Ok(out),
                    EncoderResult::OutputFull => out.reserve(text.len() - pos + 16),
                    EncoderResult::Unmappable(c) => return Err(unrepresentable(text, pos - c.len_utf8(), c, e.name())),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RU: &str = "Привет, мир! Это конфигурационный файл сервера.\nПараметр = значение # комментарий\nЕщё одна строка с текстом на русском языке.\n";

    #[test]
    fn utf8_plain() {
        let d = decode(RU.as_bytes(), None).unwrap();
        assert_eq!((d.encoding.as_str(), d.bom, d.lossy), ("UTF-8", false, false));
        assert_eq!(d.text, RU);
    }

    #[test]
    fn utf8_bom_roundtrip() {
        let bytes = encode(RU, "UTF-8", true).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let d = decode(&bytes, None).unwrap();
        assert_eq!((d.encoding.as_str(), d.bom), ("UTF-8", true));
        assert_eq!(d.text, RU);
        assert_eq!(encode(&d.text, &d.encoding, d.bom).unwrap(), bytes);
    }

    #[test]
    fn cp1251_detect_roundtrip() {
        let bytes = encode(RU, "windows-1251", false).unwrap();
        let d = decode(&bytes, None).unwrap();
        assert_eq!(d.encoding, "windows-1251");
        assert_eq!(d.text, RU);
        assert_eq!(encode(&d.text, &d.encoding, false).unwrap(), bytes);
    }

    #[test]
    fn koi8r_detect_roundtrip() {
        let bytes = encode(RU, "KOI8-R", false).unwrap();
        let d = decode(&bytes, None).unwrap();
        assert_eq!(d.encoding, "KOI8-R");
        assert_eq!(d.text, RU);
        assert_eq!(encode(&d.text, &d.encoding, false).unwrap(), bytes);
    }

    #[test]
    fn cp866_forced() {
        let bytes = encode(RU, "IBM866", false).unwrap();
        let d = decode(&bytes, Some("cp866")).unwrap();
        assert_eq!((d.encoding.as_str(), d.lossy), ("IBM866", false));
        assert_eq!(d.text, RU);
    }

    #[test]
    fn utf16_bom_roundtrip() {
        for (name, bom) in [("UTF-16LE", [0xFF, 0xFE]), ("UTF-16BE", [0xFE, 0xFF])] {
            let text = "Windows\r\nконфиг 😀\r\n";
            let bytes = encode(text, name, true).unwrap();
            assert_eq!(&bytes[..2], &bom);
            // ASCII in UTF-16 is full of NULs; must not be taken for binary.
            let d = decode(&bytes, None).unwrap();
            assert_eq!((d.encoding.as_str(), d.bom, d.lossy), (name, true, false));
            assert_eq!(d.text, text);
            assert_eq!(encode(&d.text, &d.encoding, d.bom).unwrap(), bytes);
        }
    }

    #[test]
    fn utf16_without_bom_forced() {
        let bytes = encode("abc", "UTF-16LE", false).unwrap();
        assert!(decode(&bytes, None).is_err());
        let d = decode(&bytes, Some("UTF-16LE")).unwrap();
        assert_eq!((d.text.as_str(), d.bom), ("abc", false));
    }

    #[test]
    fn binary_detected() {
        let bytes = [0x7F, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0x10, 0x20];
        assert!(decode(&bytes, None).unwrap_err().contains("двоичный"));
        assert!(decode(&bytes, Some("windows-1251")).is_err());
    }

    #[test]
    fn forced_reinterpret_is_lossy_when_invalid() {
        let bytes = encode(RU, "windows-1251", false).unwrap();
        let d = decode(&bytes, Some("UTF-8")).unwrap();
        assert!(d.lossy);
        let d = decode(&bytes, Some("KOI8-R")).unwrap();
        assert!(!d.lossy);
        assert_ne!(d.text, RU);
    }

    #[test]
    fn latin1_is_real_iso_8859_1() {
        // 0x80 is a control char in ISO-8859-1 but '€' in windows-1252.
        let d = decode(&[b'a', 0x80, 0xE9], Some("ISO-8859-1")).unwrap();
        assert_eq!(d.text, "a\u{80}é");
        assert_eq!(encode(&d.text, "ISO-8859-1", false).unwrap(), vec![b'a', 0x80, 0xE9]);
        assert!(encode("€", "ISO-8859-1", false).unwrap_err().contains("U+20AC"));
    }

    #[test]
    fn unrepresentable_chars_error() {
        let err = encode("строка\nещё 😀 тут", "windows-1251", false).unwrap_err();
        assert!(err.contains("U+1F600") && err.contains("строка 2") && err.contains("UTF-8"), "{err}");
        let err = encode("Grüße € 中", "windows-1252", false).unwrap_err();
        assert!(err.contains("U+4E2D"), "{err}");
        assert!(encode("Привет", "KOI8-R", false).is_ok());
    }

    #[test]
    fn unknown_encoding() {
        assert!(encode("x", "nope", false).is_err());
        assert!(decode(b"x", Some("nope")).is_err());
    }
}
