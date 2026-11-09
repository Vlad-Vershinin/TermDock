//! Language of user-facing backend messages (error strings shown in the UI).
//! Mirrors the `language` setting: set at startup and whenever settings are saved.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_language(lang: &str) {
    ENGLISH.store(lang == "en", Ordering::Relaxed);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// `format!` with a Russian and an English template; picks one by the current UI language.
/// Both templates take the same arguments (inline `{name}` captures work too).
macro_rules! tr {
    ($ru:literal, $en:literal $(, $($arg:tt)*)?) => {
        if $crate::i18n::is_english() {
            format!($en $(, $($arg)*)?)
        } else {
            format!($ru $(, $($arg)*)?)
        }
    };
}
