// GENERATED FILE — edit shared/actions.json and run npm run gen:actions
// Source: shared/actions.json

#![allow(dead_code)]

pub struct ScaledValue {
    pub min: f32,
    pub max: f32,
}

pub struct PhaseDurations {
    pub windup_ticks: u32,
    pub active_ticks: u32,
    pub recovery_ticks: u32,
}

pub enum HoldSpec {
    Charge { min_ticks: u32, max_ticks: u32 },
    Sustain { max_ticks: u32 },
}

pub struct MovementFractions {
    pub charging: f32,
    pub windup: f32,
    pub active: f32,
    pub held: f32,
    pub recovery: f32,
}

pub enum EffectDef {
    MeleeArc {
        range: f32,
        arc_degrees: f32,
        damage: ScaledValue,
        blocked_damage: ScaledValue,
    },
    Projectile {
        speed: f32,
        max_distance: f32,
        radius: f32,
        damage: ScaledValue,
        blocked_damage: ScaledValue,
    },
    AoeAtTarget {
        radius: f32,
        max_range: f32,
        damage: ScaledValue,
        blocked_damage: ScaledValue,
    },
    HealSelf { amount: f32 },
    DisplaceSelf { distance: f32 },
    Invulnerable,
    Mitigation { multiplier: f32 },
}

pub enum MotionLayer {
    Upper,
    Full,
}

pub enum InterruptPolicy {
    Never,
    Recovery,
    Always,
}

pub struct ActionResourceCost {
    pub kind: &'static str,
    pub cost: u32,
}

pub struct ActionDef {
    pub id: &'static str,
    pub phases: PhaseDurations,
    pub cooldown_ticks: u32,
    pub hold: Option<HoldSpec>,
    pub movement: MovementFractions,
    pub can_rotate: bool,
    pub resource: Option<ActionResourceCost>,
    pub effects: &'static [EffectDef],
    pub motion: &'static str,
    pub motion_layer: MotionLayer,
    pub interrupt: InterruptPolicy,
}

pub struct SlotBinding {
    pub slot: &'static str,
    pub tap_action: Option<&'static str>,
    pub hold_action: Option<&'static str>,
    pub hold_threshold_ticks: u32,
}

pub struct ResourceDef {
    pub kind: &'static str,
    pub max: u32,
    pub on_respawn: u32,
}

pub const ACTIONS_TICK_RATE: u32 = 20;

pub const ACTION_DEFS: &[ActionDef] = &[
    ActionDef {
        id: "attack_light",
        phases: PhaseDurations { windup_ticks: 5, active_ticks: 2, recovery_ticks: 6 },
        cooldown_ticks: 0,
        hold: None,
        movement: MovementFractions { windup: 0.4, active: 0.0, recovery: 0.6, charging: 0.0, held: 0.0 },
        can_rotate: true,
        resource: None,
        effects: &[
            EffectDef::MeleeArc { range: 2.8, arc_degrees: 90.0, damage: ScaledValue { min: 10.0, max: 10.0 }, blocked_damage: ScaledValue { min: 2.0, max: 2.0 } },
        ],
        motion: "motion.act_swing_1h",
        motion_layer: MotionLayer::Upper,
        interrupt: InterruptPolicy::Recovery,
    },
    ActionDef {
        id: "attack_heavy",
        phases: PhaseDurations { windup_ticks: 4, active_ticks: 3, recovery_ticks: 10 },
        cooldown_ticks: 20,
        hold: Some(HoldSpec::Charge { min_ticks: 6, max_ticks: 30 }),
        movement: MovementFractions { charging: 0.3, windup: 0.0, active: 0.0, recovery: 0.4, held: 0.0 },
        can_rotate: true,
        resource: None,
        effects: &[
            EffectDef::MeleeArc { range: 3.2, arc_degrees: 120.0, damage: ScaledValue { min: 15.0, max: 35.0 }, blocked_damage: ScaledValue { min: 3.0, max: 8.0 } },
        ],
        motion: "motion.act_smash_2h",
        motion_layer: MotionLayer::Full,
        interrupt: InterruptPolicy::Never,
    },
    ActionDef {
        id: "block",
        phases: PhaseDurations { windup_ticks: 2, active_ticks: 0, recovery_ticks: 4 },
        cooldown_ticks: 0,
        hold: Some(HoldSpec::Sustain { max_ticks: 0 }),
        movement: MovementFractions { windup: 0.5, held: 0.5, recovery: 0.5, charging: 0.0, active: 0.0 },
        can_rotate: true,
        resource: None,
        effects: &[
            EffectDef::Mitigation { multiplier: 0.2 },
        ],
        motion: "motion.act_guard_hold",
        motion_layer: MotionLayer::Upper,
        interrupt: InterruptPolicy::Always,
    },
    ActionDef {
        id: "roll",
        phases: PhaseDurations { windup_ticks: 1, active_ticks: 8, recovery_ticks: 3 },
        cooldown_ticks: 24,
        hold: None,
        movement: MovementFractions { windup: 0.0, active: 0.0, recovery: 0.0, charging: 0.0, held: 0.0 },
        can_rotate: false,
        resource: None,
        effects: &[
            EffectDef::DisplaceSelf { distance: 4.0 },
            EffectDef::Invulnerable,
        ],
        motion: "motion.act_roll",
        motion_layer: MotionLayer::Full,
        interrupt: InterruptPolicy::Never,
    },
    ActionDef {
        id: "potion",
        phases: PhaseDurations { windup_ticks: 16, active_ticks: 2, recovery_ticks: 6 },
        cooldown_ticks: 100,
        hold: None,
        movement: MovementFractions { windup: 0.5, active: 0.5, recovery: 0.5, charging: 0.0, held: 0.0 },
        can_rotate: true,
        resource: Some(ActionResourceCost { kind: "potion_charge", cost: 1 }),
        effects: &[
            EffectDef::HealSelf { amount: 30.0 },
        ],
        motion: "motion.act_drink",
        motion_layer: MotionLayer::Upper,
        interrupt: InterruptPolicy::Recovery,
    },
    ActionDef {
        id: "ability_bolt",
        phases: PhaseDurations { windup_ticks: 8, active_ticks: 1, recovery_ticks: 8 },
        cooldown_ticks: 40,
        hold: None,
        movement: MovementFractions { windup: 0.4, active: 0.0, recovery: 0.6, charging: 0.0, held: 0.0 },
        can_rotate: true,
        resource: None,
        effects: &[
            EffectDef::Projectile { speed: 18.0, max_distance: 30.0, radius: 1.2, damage: ScaledValue { min: 20.0, max: 20.0 }, blocked_damage: ScaledValue { min: 4.0, max: 4.0 } },
        ],
        motion: "motion.act_hurl_1h",
        motion_layer: MotionLayer::Upper,
        interrupt: InterruptPolicy::Recovery,
    },
    ActionDef {
        id: "ability_lance",
        phases: PhaseDurations { windup_ticks: 12, active_ticks: 1, recovery_ticks: 10 },
        cooldown_ticks: 80,
        hold: None,
        movement: MovementFractions { windup: 0.0, active: 0.0, recovery: 0.4, charging: 0.0, held: 0.0 },
        can_rotate: true,
        resource: None,
        effects: &[
            EffectDef::Projectile { speed: 30.0, max_distance: 45.0, radius: 0.8, damage: ScaledValue { min: 30.0, max: 30.0 }, blocked_damage: ScaledValue { min: 6.0, max: 6.0 } },
        ],
        motion: "motion.act_hurl_1h",
        motion_layer: MotionLayer::Upper,
        interrupt: InterruptPolicy::Never,
    },
    ActionDef {
        id: "ability_nova",
        phases: PhaseDurations { windup_ticks: 10, active_ticks: 2, recovery_ticks: 12 },
        cooldown_ticks: 120,
        hold: None,
        movement: MovementFractions { windup: 0.0, active: 0.0, recovery: 0.0, charging: 0.0, held: 0.0 },
        can_rotate: false,
        resource: None,
        effects: &[
            EffectDef::AoeAtTarget { radius: 5.0, max_range: 0.0, damage: ScaledValue { min: 25.0, max: 25.0 }, blocked_damage: ScaledValue { min: 8.0, max: 8.0 } },
        ],
        motion: "motion.act_slam_2h",
        motion_layer: MotionLayer::Full,
        interrupt: InterruptPolicy::Never,
    },
    ActionDef {
        id: "ability_quake",
        phases: PhaseDurations { windup_ticks: 14, active_ticks: 2, recovery_ticks: 10 },
        cooldown_ticks: 100,
        hold: None,
        movement: MovementFractions { windup: 0.0, active: 0.0, recovery: 0.4, charging: 0.0, held: 0.0 },
        can_rotate: true,
        resource: None,
        effects: &[
            EffectDef::AoeAtTarget { radius: 3.5, max_range: 18.0, damage: ScaledValue { min: 22.0, max: 22.0 }, blocked_damage: ScaledValue { min: 6.0, max: 6.0 } },
        ],
        motion: "motion.act_slam_2h",
        motion_layer: MotionLayer::Full,
        interrupt: InterruptPolicy::Recovery,
    },
    ActionDef {
        id: "ability_mend",
        phases: PhaseDurations { windup_ticks: 20, active_ticks: 2, recovery_ticks: 8 },
        cooldown_ticks: 200,
        hold: None,
        movement: MovementFractions { windup: 0.3, active: 0.0, recovery: 0.5, charging: 0.0, held: 0.0 },
        can_rotate: true,
        resource: None,
        effects: &[
            EffectDef::HealSelf { amount: 20.0 },
        ],
        motion: "motion.act_drink",
        motion_layer: MotionLayer::Upper,
        interrupt: InterruptPolicy::Recovery,
    },
];

pub const SLOT_BINDINGS: &[SlotBinding] = &[
    SlotBinding {
        slot: "primary",
        tap_action: Some("attack_light"),
        hold_action: Some("attack_heavy"),
        hold_threshold_ticks: 5,
    },
    SlotBinding {
        slot: "block",
        tap_action: None,
        hold_action: Some("block"),
        hold_threshold_ticks: 0,
    },
    SlotBinding {
        slot: "roll",
        tap_action: Some("roll"),
        hold_action: None,
        hold_threshold_ticks: 0,
    },
    SlotBinding {
        slot: "potion",
        tap_action: Some("potion"),
        hold_action: None,
        hold_threshold_ticks: 0,
    },
    SlotBinding {
        slot: "ability1",
        tap_action: Some("ability_bolt"),
        hold_action: None,
        hold_threshold_ticks: 0,
    },
    SlotBinding {
        slot: "ability2",
        tap_action: Some("ability_lance"),
        hold_action: None,
        hold_threshold_ticks: 0,
    },
    SlotBinding {
        slot: "ability3",
        tap_action: Some("ability_nova"),
        hold_action: None,
        hold_threshold_ticks: 0,
    },
    SlotBinding {
        slot: "ability4",
        tap_action: Some("ability_quake"),
        hold_action: None,
        hold_threshold_ticks: 0,
    },
    SlotBinding {
        slot: "ability5",
        tap_action: Some("ability_mend"),
        hold_action: None,
        hold_threshold_ticks: 0,
    },
];

pub const RESOURCE_DEFS: &[ResourceDef] = &[
    ResourceDef {
        kind: "potion_charge",
        max: 3,
        on_respawn: 3,
    },
];

