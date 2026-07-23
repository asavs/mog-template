//! Loadout presets, appearance seeds, and ability grants (authority side).
//!
//! Mirrors the client avatar catalog contract (`client/src/avatar/`):
//! classes are **preset ids**, capabilities come from **grants**, not mesh packs.
//! Keep grant / item / body ids aligned with the TypeScript catalog by convention
//! until a shared data file exists.

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

/// Equipment slot names — keep aligned with client `EquipSlot`.
pub mod slots {
    pub const MAIN_HAND: &str = "main_hand";
    pub const OFF_HAND: &str = "off_hand";
}

/// Item ids — keep aligned with client catalog `ItemId`s.
pub mod items {
    pub const SWORD_1H: &str = "sword_1h";
    pub const SHIELD: &str = "shield";
    pub const STAFF: &str = "staff";
    pub const POTION: &str = "potion";
}

/// Body mesh ids — keep aligned with client `BodyId`.
pub mod bodies {
    pub const BODY_M: &str = "body_m";
    pub const BODY_F: &str = "body_f";
}

/// Derived combat gates used by reducers (presentation uses the richer client form).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub melee: bool,
    pub block: bool,
    pub cast: bool,
    pub drink_potion: bool,
}

/// Public appearance fields stored on `player_appearance`.
#[derive(Debug, Clone, PartialEq)]
pub struct AppearanceSeed {
    pub body_id: &'static str,
    pub scale: f32,
    pub loadout_preset: &'static str,
}

/// One equipped item row for `player_equipment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EquipmentSeed {
    pub slot: &'static str,
    pub item_id: &'static str,
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

pub fn preset_appearance(preset_id: &str) -> AppearanceSeed {
    match preset_id {
        "paladin" => AppearanceSeed {
            body_id: bodies::BODY_M,
            scale: 1.0,
            loadout_preset: "paladin",
        },
        _ => AppearanceSeed {
            body_id: bodies::BODY_F,
            scale: 1.0,
            loadout_preset: "wizard",
        },
    }
}

/// Starting equipment for a preset (including utility attaches like potion).
pub fn preset_equipment(preset_id: &str) -> &'static [EquipmentSeed] {
    match preset_id {
        "paladin" => &[
            EquipmentSeed {
                slot: slots::MAIN_HAND,
                item_id: items::SWORD_1H,
            },
            EquipmentSeed {
                slot: slots::OFF_HAND,
                item_id: items::SHIELD,
            },
            // Utility: potion is not an exclusive off-hand in presentation yet;
            // stored as a second off_hand-ish row under slot "utility_potion".
            EquipmentSeed {
                slot: "utility_potion",
                item_id: items::POTION,
            },
        ],
        _ => &[
            EquipmentSeed {
                slot: slots::MAIN_HAND,
                item_id: items::STAFF,
            },
            EquipmentSeed {
                slot: slots::OFF_HAND,
                item_id: items::POTION,
            },
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

/// Future: derive capabilities from equipped item grants (+ learned skills).
/// Phase A still uses preset grants; this helper is the seam for equipment tables.
pub fn capabilities_for_equipment_item_ids(item_ids: &[&str]) -> Capabilities {
    let mut grant_list: Vec<&str> = Vec::new();
    for item_id in item_ids {
        match *item_id {
            items::SWORD_1H => grant_list.push(grants::MELEE_SLASH),
            items::SHIELD => grant_list.push(grants::BLOCK),
            items::STAFF => {
                grant_list.push(grants::CAST_FIREBALL);
                grant_list.push(grants::CAST_LIGHTNING);
            }
            items::POTION => grant_list.push(grants::DRINK_POTION),
            _ => {}
        }
    }
    // Potion drinking is baseline for all humanoid PCs even if unequipped later.
    if !grant_list.contains(&grants::DRINK_POTION) {
        grant_list.push(grants::DRINK_POTION);
    }
    capabilities_from_grants(&grant_list)
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

    #[test]
    fn preset_appearance_and_equipment_match_catalog() {
        let paladin = preset_appearance("paladin");
        assert_eq!(paladin.body_id, bodies::BODY_M);
        assert_eq!(paladin.loadout_preset, "paladin");
        let paladin_gear = preset_equipment("paladin");
        assert!(paladin_gear.iter().any(|e| e.item_id == items::SWORD_1H));
        assert!(paladin_gear.iter().any(|e| e.item_id == items::SHIELD));

        let wizard = preset_appearance("wizard");
        assert_eq!(wizard.body_id, bodies::BODY_F);
        let wizard_gear = preset_equipment("wizard");
        assert!(wizard_gear.iter().any(|e| e.item_id == items::STAFF));
    }

    #[test]
    fn equipment_items_derive_same_caps_as_preset() {
        let from_items = capabilities_for_equipment_item_ids(&[items::SWORD_1H, items::SHIELD]);
        let from_preset = capabilities_for_class("paladin");
        assert_eq!(from_items.melee, from_preset.melee);
        assert_eq!(from_items.block, from_preset.block);
        assert_eq!(from_items.cast, from_preset.cast);
    }
}
