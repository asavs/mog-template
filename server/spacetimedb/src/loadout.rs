//! Loadout presets, appearance seeds, and ability grants (authority side).
//!
//! Authority ids come from `shared/avatar-loadout.json` via
//! `loadout_authority.generated.rs` (issue #46).
//! Regenerate: `node scripts/gen-avatar-loadout.mjs`
//!
//! Presentation meshKeys / clips remain client-only (`client/src/avatar/catalog.ts`).

#[path = "loadout_authority.generated.rs"]
mod authority;

pub use authority::{
    BASELINE_GRANTS, BODY_IDS, DEFAULT_PRESET_ID, GRANT_IDS, ITEM_IDS, PRESET_IDS,
    item_grants, normalize_preset_id, preset_body_id, preset_equipment_pairs, preset_grants,
    preset_scale,
};

/// Ability grant id constants (stable string aliases for call sites / tests).
pub mod grants {
    pub const MELEE_SLASH: &str = "melee_slash";
    pub const BLOCK: &str = "block";
    pub const CAST_FIREBALL: &str = "cast_fireball";
    pub const CAST_LIGHTNING: &str = "cast_lightning";
    pub const DRINK_POTION: &str = "drink_potion";
}

/// Equipment slot names used by paper-doll seeds.
pub mod slots {
    pub const MAIN_HAND: &str = "main_hand";
    pub const OFF_HAND: &str = "off_hand";
}

/// Item id constants (stable string aliases for call sites / tests).
pub mod items {
    pub const SWORD_1H: &str = "sword_1h";
    pub const SHIELD: &str = "shield";
    pub const STAFF: &str = "staff";
    pub const POTION: &str = "potion";
}

/// Body mesh ids.
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

pub fn preset_appearance(preset_id: &str) -> AppearanceSeed {
    let id = if PRESET_IDS.contains(&preset_id) {
        // Keep a 'static loadout_preset string: map known ids.
        match preset_id {
            "paladin" => "paladin",
            "wizard" => "wizard",
            _ => DEFAULT_PRESET_ID,
        }
    } else {
        DEFAULT_PRESET_ID
    };
    AppearanceSeed {
        body_id: preset_body_id(id),
        scale: preset_scale(id),
        loadout_preset: id,
    }
}

/// Starting equipment for a preset (including utility attaches like potion).
pub fn preset_equipment(preset_id: &str) -> Vec<EquipmentSeed> {
    preset_equipment_pairs(preset_id)
        .iter()
        .map(|(slot, item_id)| EquipmentSeed {
            slot,
            item_id,
        })
        .collect()
}

pub fn capabilities_from_grants(grant_list: &[&str]) -> Capabilities {
    let mut melee = false;
    let mut block = false;
    let mut cast = false;
    // Baseline: all humanoid PCs can drink (shared baselineGrants).
    let mut drink_potion = BASELINE_GRANTS.contains(&grants::DRINK_POTION);
    for grant in grant_list {
        match *grant {
            grants::MELEE_SLASH => melee = true,
            grants::BLOCK => block = true,
            grants::CAST_FIREBALL | grants::CAST_LIGHTNING => cast = true,
            grants::DRINK_POTION => drink_potion = true,
            _ => {}
        }
    }
    // Any baseline grant listed as drink_potion forces drink.
    if BASELINE_GRANTS.iter().any(|g| *g == grants::DRINK_POTION) {
        drink_potion = true;
    }
    Capabilities {
        melee,
        block,
        cast,
        drink_potion,
    }
}

/// Capability lookup for a stored `character_class` / preset string.
/// Un-normalizable values fall back to default preset.
pub fn capabilities_for_class(class: &str) -> Capabilities {
    let preset = normalize_preset_id(class).unwrap_or_else(|_| DEFAULT_PRESET_ID.to_string());
    capabilities_from_grants(preset_grants(&preset))
}

/// Derive capabilities from equipped item ids (+ baseline grants).
pub fn capabilities_for_equipment_item_ids(item_ids: &[&str]) -> Capabilities {
    let mut grant_list: Vec<&str> = Vec::new();
    for item_id in item_ids {
        for grant in item_grants(item_id) {
            grant_list.push(*grant);
        }
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
        assert!(only_slash.drink_potion);
    }

    #[test]
    fn empty_equipment_still_allows_drink() {
        let caps = capabilities_for_equipment_item_ids(&[]);
        assert!(caps.drink_potion);
        assert!(!caps.melee);
    }

    #[test]
    fn preset_appearance_and_equipment_match_authority() {
        let paladin = preset_appearance("paladin");
        assert_eq!(paladin.body_id, bodies::BODY_M);
        assert_eq!(paladin.loadout_preset, "paladin");
        let paladin_gear = preset_equipment("paladin");
        assert!(paladin_gear.iter().any(|e| e.item_id == items::SWORD_1H));
        assert!(paladin_gear.iter().any(|e| e.item_id == items::SHIELD));
        assert!(paladin_gear.iter().any(|e| e.item_id == items::POTION));

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

    #[test]
    fn authority_id_tables_are_non_empty() {
        assert!(PRESET_IDS.contains(&"paladin"));
        assert!(PRESET_IDS.contains(&"wizard"));
        assert!(ITEM_IDS.contains(&"sword_1h"));
        assert!(BODY_IDS.contains(&"body_m"));
        assert!(GRANT_IDS.contains(&"melee_slash"));
        assert!(BASELINE_GRANTS.contains(&"drink_potion"));
    }
}
