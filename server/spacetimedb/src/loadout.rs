//! Loadout presets, appearance seeds, and ability grants (authority side).
//!
//! Authority ids come from `shared/avatar-loadout.json` via
//! `loadout_authority.generated.rs` (issue #46).
//! Regenerate: `node scripts/gen-avatar-loadout.mjs`
//!
//! Slot model:
//! - `equipSlots` — exclusive paper-doll (at most one item per slot)
//! - `utilitySlots` — consumable/utility attaches (exclusive within their id,
//!   not competing with paper-doll)
//! Preset seeds put paper-doll items in `slots` and utility items in `utilityEquipment`.
//!
//! Presentation meshKeys / clips remain client-only (`client/src/avatar/catalog.ts`).

#[path = "loadout_authority.generated.rs"]
mod authority;

pub use authority::{
    BASELINE_GRANTS, DEFAULT_PRESET_ID, PRESET_IDS, is_known_slot, item_grants, item_slot,
    normalize_preset_id, preset_body_id, preset_equipment_pairs, preset_grants, preset_scale,
};

// Re-exported for tests / call sites that need full authority tables.
#[cfg(test)]
pub use authority::{
    BODY_IDS, EQUIP_SLOTS, GRANT_IDS, ITEM_IDS, UTILITY_SLOTS, is_equip_slot, is_utility_slot,
};

/// Ability grant id constants (stable string aliases for call sites / tests).
/// String values must match `shared/avatar-loadout.json` (codegen does not emit these aliases).
pub mod grants {
    pub const MELEE_SLASH: &str = "melee_slash";
    pub const BLOCK: &str = "block";
    pub const CAST_FIREBALL: &str = "cast_fireball";
    pub const CAST_LIGHTNING: &str = "cast_lightning";
    pub const DRINK_POTION: &str = "drink_potion";
}

/// Equipment slot name constants (paper-doll + utility).
pub mod slots {
    pub const MAIN_HAND: &str = "main_hand";
    pub const OFF_HAND: &str = "off_hand";
    pub const UTILITY_POTION: &str = "utility_potion";
}

/// Item id constants (stable string aliases for call sites / tests).
/// String values must match `shared/avatar-loadout.json`.
pub mod items {
    pub const SWORD_1H: &str = "sword_1h";
    pub const SHIELD: &str = "shield";
    pub const WAND: &str = "wand";
    pub const DAGGER: &str = "dagger";
    pub const POTION: &str = "potion";
}

/// Body mesh ids (string values must match `shared/avatar-loadout.json`).
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

/// Intern `preset_id` to a `'static` string from the generated table, or default.
fn intern_preset_id(preset_id: &str) -> &'static str {
    PRESET_IDS
        .iter()
        .copied()
        .find(|&id| id == preset_id)
        .unwrap_or(DEFAULT_PRESET_ID)
}

pub fn preset_appearance(preset_id: &str) -> AppearanceSeed {
    let id = intern_preset_id(preset_id);
    AppearanceSeed {
        body_id: preset_body_id(id),
        scale: preset_scale(id),
        loadout_preset: id,
    }
}

/// Starting equipment for a preset (paper-doll + utility attaches).
pub fn preset_equipment(preset_id: &str) -> impl Iterator<Item = EquipmentSeed> {
    // pairs are `Copy` (`&'static str` tuples); destructure by value, not `&&str`.
    preset_equipment_pairs(preset_id)
        .iter()
        .copied()
        .map(|(slot, item_id)| EquipmentSeed { slot, item_id })
}

pub fn capabilities_from_grants(grant_list: &[&str]) -> Capabilities {
    let mut melee = false;
    let mut block = false;
    let mut cast = false;
    // Baseline humanoid grants from shared/avatar-loadout.json (generated BASELINE_GRANTS).
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
    let grant_list: Vec<&str> = item_ids
        .iter()
        .flat_map(|item_id| item_grants(item_id).iter().copied())
        .collect();
    capabilities_from_grants(&grant_list)
}

/// Validate `item_id` can be equipped; returns its exclusive authority slot.
pub fn equip_slot_for_item(item_id: &str) -> Result<&'static str, String> {
    let Some(slot) = item_slot(item_id) else {
        return Err(format!("Unknown item: {item_id}"));
    };
    if !is_known_slot(slot) {
        return Err(format!("Item {item_id} has unknown slot {slot}"));
    }
    Ok(slot)
}

/// Validate a slot name for unequip (paper-doll or utility).
pub fn validate_unequip_slot(slot: &str) -> Result<(), String> {
    if !is_known_slot(slot) {
        return Err(format!("Unknown equipment slot: {slot}"));
    }
    Ok(())
}

/// Pure equip mutation for tests / reasoning: replace exclusive slot with `item_id`.
/// `equipment` is `(slot, item_id)` pairs (order not significant).
#[cfg(test)]
pub fn apply_equip(equipment: &mut Vec<(String, String)>, item_id: &str) -> Result<(), String> {
    let slot = equip_slot_for_item(item_id)?;
    equipment.retain(|(s, _)| s != slot);
    equipment.push((slot.to_string(), item_id.to_string()));
    Ok(())
}

/// Pure unequip mutation: clear `slot` if present.
#[cfg(test)]
pub fn apply_unequip(equipment: &mut Vec<(String, String)>, slot: &str) -> Result<(), String> {
    validate_unequip_slot(slot)?;
    let before = equipment.len();
    equipment.retain(|(s, _)| s != slot);
    if equipment.len() == before {
        return Err(format!("Nothing equipped in slot: {slot}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item_ids_only(equipment: &[(String, String)]) -> Vec<&str> {
        equipment.iter().map(|(_, id)| id.as_str()).collect()
    }

    #[test]
    fn normalizes_legacy_class_strings() {
        assert_eq!(normalize_preset_id("paladin").unwrap(), "paladin");
        assert_eq!(normalize_preset_id("pally").unwrap(), "paladin");
        assert_eq!(normalize_preset_id("  PALADIN ").unwrap(), "paladin");
        assert_eq!(normalize_preset_id("wizard").unwrap(), "wizard");
        assert_eq!(normalize_preset_id("wizard2").unwrap(), "wizard");
        assert_eq!(normalize_preset_id("Wizard2").unwrap(), "wizard");
        assert_eq!(normalize_preset_id("acolyte").unwrap(), "acolyte");
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
        let paladin_gear: Vec<_> = preset_equipment("paladin").collect();
        assert!(paladin_gear.iter().any(|e| e.item_id == items::SWORD_1H));
        assert!(paladin_gear.iter().any(|e| e.item_id == items::SHIELD));
        assert!(paladin_gear.iter().any(|e| e.item_id == items::POTION));
        // Shield is paper-doll off_hand; potion is utility — not competing.
        assert!(paladin_gear
            .iter()
            .any(|e| e.slot == slots::OFF_HAND && e.item_id == items::SHIELD));
        assert!(paladin_gear
            .iter()
            .any(|e| e.slot == slots::UTILITY_POTION && e.item_id == items::POTION));

        let wizard = preset_appearance("wizard");
        assert_eq!(wizard.body_id, bodies::BODY_F);
        let wizard_gear: Vec<_> = preset_equipment("wizard").collect();
        assert!(wizard_gear.iter().any(|e| e.item_id == items::WAND));
        assert!(wizard_gear
            .iter()
            .any(|e| e.slot == slots::UTILITY_POTION && e.item_id == items::POTION));
        // Potion must not seed as off_hand paper-doll.
        assert!(!wizard_gear
            .iter()
            .any(|e| e.slot == slots::OFF_HAND && e.item_id == items::POTION));

        let acolyte = preset_appearance("acolyte");
        assert_eq!(acolyte.body_id, bodies::BODY_F);
        assert_eq!(acolyte.loadout_preset, "acolyte");
        let acolyte_gear: Vec<_> = preset_equipment("acolyte").collect();
        assert!(acolyte_gear.iter().any(|e| e.item_id == items::WAND));
        assert!(acolyte_gear
            .iter()
            .any(|e| e.slot == slots::UTILITY_POTION && e.item_id == items::POTION));
    }

    #[test]
    fn paper_doll_and_utility_slots_are_disjoint() {
        for slot in EQUIP_SLOTS {
            assert!(is_equip_slot(slot));
            assert!(!is_utility_slot(slot));
        }
        for slot in UTILITY_SLOTS {
            assert!(is_utility_slot(slot));
            assert!(!is_equip_slot(slot));
        }
        assert_eq!(item_slot(items::POTION), Some(slots::UTILITY_POTION));
        assert_eq!(item_slot(items::SHIELD), Some(slots::OFF_HAND));
        assert_eq!(item_slot(items::SWORD_1H), Some(slots::MAIN_HAND));
    }

    #[test]
    fn equipment_items_derive_same_caps_as_preset() {
        let from_items =
            capabilities_for_equipment_item_ids(&[items::SWORD_1H, items::SHIELD, items::POTION]);
        let from_preset = capabilities_for_class("paladin");
        assert_eq!(from_items.melee, from_preset.melee);
        assert_eq!(from_items.block, from_preset.block);
        assert_eq!(from_items.cast, from_preset.cast);
        assert_eq!(from_items.drink_potion, from_preset.drink_potion);
    }

    #[test]
    fn equip_wand_grants_cast_unequip_removes_cast() {
        let mut gear: Vec<(String, String)> = preset_equipment("paladin")
            .map(|e| (e.slot.to_string(), e.item_id.to_string()))
            .collect();

        // Swap main hand sword → wand
        apply_equip(&mut gear, items::WAND).unwrap();
        let caps_wand = capabilities_for_equipment_item_ids(&item_ids_only(&gear));
        assert!(caps_wand.cast);
        assert!(!caps_wand.melee);
        assert!(caps_wand.block); // shield still on
        assert!(caps_wand.drink_potion);

        apply_unequip(&mut gear, slots::MAIN_HAND).unwrap();
        let caps_empty_hand = capabilities_for_equipment_item_ids(&item_ids_only(&gear));
        assert!(!caps_empty_hand.cast);
        assert!(!caps_empty_hand.melee);
        assert!(caps_empty_hand.block);
        assert!(caps_empty_hand.drink_potion); // baseline
    }

    #[test]
    fn equip_rejects_unknown_item() {
        let mut gear = Vec::new();
        assert!(apply_equip(&mut gear, "not_a_real_item")
            .unwrap_err()
            .contains("Unknown item"));
    }

    #[test]
    fn unequip_rejects_unknown_slot() {
        let mut gear = Vec::new();
        assert!(apply_unequip(&mut gear, "left_ear")
            .unwrap_err()
            .contains("Unknown equipment slot"));
    }

    #[test]
    fn equip_replaces_same_slot() {
        let mut gear = vec![(slots::MAIN_HAND.to_string(), items::SWORD_1H.to_string())];
        apply_equip(&mut gear, items::WAND).unwrap();
        assert_eq!(gear.len(), 1);
        assert_eq!(gear[0].1, items::WAND);
    }

    #[test]
    fn normalize_accepts_acolyte_preset() {
        assert_eq!(normalize_preset_id("acolyte").unwrap(), "acolyte");
        assert_eq!(normalize_preset_id("Acolyte").unwrap(), "acolyte");
        assert!(PRESET_IDS.contains(&"acolyte"));
        assert!(ITEM_IDS.contains(&items::WAND));
        assert!(ITEM_IDS.contains(&items::DAGGER));
        assert!(!ITEM_IDS.iter().any(|&id| id == "staff"));
        assert_eq!(item_slot(items::DAGGER), Some(slots::MAIN_HAND));
        assert_eq!(item_slot(items::WAND), Some(slots::MAIN_HAND));
    }

    #[test]
    fn authority_id_tables_are_non_empty() {
        assert!(PRESET_IDS.contains(&"paladin"));
        assert!(PRESET_IDS.contains(&"wizard"));
        assert!(PRESET_IDS.contains(&"acolyte"));
        assert!(ITEM_IDS.contains(&"sword_1h"));
        assert!(ITEM_IDS.contains(&"wand"));
        assert!(BODY_IDS.contains(&"body_m"));
        assert!(GRANT_IDS.contains(&"melee_slash"));
        assert!(BASELINE_GRANTS.contains(&"drink_potion"));
        assert!(EQUIP_SLOTS.contains(&"main_hand"));
        assert!(UTILITY_SLOTS.contains(&"utility_potion"));
    }
}
