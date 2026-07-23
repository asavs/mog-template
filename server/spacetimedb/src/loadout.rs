//! Loadout presets and ability grants (authority side).
//!
//! Mirrors the client avatar catalog contract (`client/src/avatar/`):
//! classes are **preset ids**, capabilities come from **grants**, not mesh packs.
//! Full `item_def` / equipment tables land later; until then preset → grant lists
//! stay in sync by convention with the TypeScript catalog.

/// Normalize legacy join strings onto a loadout preset id.
pub fn normalize_preset_id(character_class: &str) -> Result<String, String> {
    match character_class.trim().to_ascii_lowercase().as_str() {
        "paladin" | "pally" => Ok("paladin".to_string()),
        "wizard" | "wizard2" => Ok("wizard".to_string()),
        _ => Err("Unsupported character class".to_string()),
    }
}

/// Ability grant ids — keep names aligned with `client/src/avatar/catalog.ts`.
pub mod grants {
    pub const MELEE_SLASH: &str = "melee_slash";
    pub const BLOCK: &str = "block";
    pub const CAST_FIREBALL: &str = "cast_fireball";
    pub const CAST_LIGHTNING: &str = "cast_lightning";
    pub const DRINK_POTION: &str = "drink_potion";
}

/// Derived combat gates used by reducers (presentation uses the richer client form).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub melee: bool,
    pub block: bool,
    pub cast: bool,
    pub drink_potion: bool,
}

/// Grants for a loadout preset (Phase A: static rows; later: equipped items + extras).
pub fn preset_grants(preset_id: &str) -> &'static [&'static str] {
    match preset_id {
        "paladin" => &[
            grants::MELEE_SLASH,
            grants::BLOCK,
            grants::DRINK_POTION,
        ],
        // wizard and unknown-after-normalize default
        _ => &[
            grants::CAST_FIREBALL,
            grants::CAST_LIGHTNING,
            grants::DRINK_POTION,
        ],
    }
}

pub fn capabilities_from_grants(grant_list: &[&str]) -> Capabilities {
    let mut melee = false;
    let mut block = false;
    let mut cast = false;
    let mut drink_potion = false;
    for grant in grant_list {
        match *grant {
            grants::MELEE_SLASH => melee = true,
            grants::BLOCK => block = true,
            grants::CAST_FIREBALL | grants::CAST_LIGHTNING => cast = true,
            grants::DRINK_POTION => drink_potion = true,
            _ => {}
        }
    }
    Capabilities {
        melee,
        block,
        cast,
        drink_potion,
    }
}

/// Capability lookup for a stored `character_class` / preset string.
/// Un-normalizable values fall back to wizard (same as prior client default).
pub fn capabilities_for_class(class: &str) -> Capabilities {
    let preset = normalize_preset_id(class).unwrap_or_else(|_| "wizard".to_string());
    capabilities_from_grants(preset_grants(&preset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_legacy_class_strings() {
        assert_eq!(normalize_preset_id("paladin").unwrap(), "paladin");
        assert_eq!(normalize_preset_id("pally").unwrap(), "paladin");
        assert_eq!(normalize_preset_id("  PALADIN ").unwrap(), "paladin");
        assert_eq!(normalize_preset_id("wizard").unwrap(), "wizard");
        assert_eq!(normalize_preset_id("wizard2").unwrap(), "wizard");
        assert_eq!(normalize_preset_id("Wizard2").unwrap(), "wizard");
        assert!(normalize_preset_id("knight").is_err());
        assert!(normalize_preset_id("").is_err());
    }

    #[test]
    fn paladin_grants_melee_block_potion_not_cast() {
        let caps = capabilities_for_class("paladin");
        assert!(caps.melee);
        assert!(caps.block);
        assert!(caps.drink_potion);
        assert!(!caps.cast);
    }

    #[test]
    fn wizard_grants_cast_potion_not_melee() {
        let caps = capabilities_for_class("wizard");
        assert!(!caps.melee);
        assert!(!caps.block);
        assert!(caps.cast);
        assert!(caps.drink_potion);
        let caps_legacy = capabilities_for_class("wizard2");
        assert!(caps_legacy.cast);
    }

    #[test]
    fn grants_drive_capabilities() {
        let only_slash = capabilities_from_grants(&[grants::MELEE_SLASH]);
        assert!(only_slash.melee);
        assert!(!only_slash.block);
        assert!(!only_slash.cast);
    }
}
