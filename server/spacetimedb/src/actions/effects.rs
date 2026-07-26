use super::defs_generated::{ActionDef, EffectDef, HoldSpec, ScaledValue};
use crate::collision;
use crate::common::Vector3;
use crate::tables::*;
use spacetimedb::{Identity, ReducerContext, Table};

// ---------------------------------------------------------------------------
// Pure math / geometry / damage-decision helpers — host-free, no ReducerContext,
// directly unit-testable.
// ---------------------------------------------------------------------------

/// ScaledValue is `[min, max]` lerped by `chargeFraction`; a scalar (min == max) is constant.
pub fn lerp_scaled(value: &ScaledValue, fraction: f32) -> f32 {
    value.min + (value.max - value.min) * fraction.clamp(0.0, 1.0)
}

/// Forward-facing unit vector for a given yaw, matching the convention used throughout the
/// server (player_logic::calculate_next_position uses the same formula).
pub fn forward_vector(rotation_y: f32) -> Vector3 {
    Vector3 {
        x: -rotation_y.sin(),
        y: 0.0,
        z: -rotation_y.cos(),
    }
}

/// Squared 2D (XZ) distance from `point` to the closest point on segment `start..end`.
pub fn distance_sq_to_segment_2d(point: &Vector3, start: &Vector3, end: &Vector3) -> f32 {
    let segment_x = end.x - start.x;
    let segment_z = end.z - start.z;
    let length_sq = segment_x * segment_x + segment_z * segment_z;
    if length_sq <= 0.0001 {
        let dx = point.x - start.x;
        let dz = point.z - start.z;
        return dx * dx + dz * dz;
    }
    let t = (((point.x - start.x) * segment_x + (point.z - start.z) * segment_z) / length_sq).clamp(0.0, 1.0);
    let closest_x = start.x + segment_x * t;
    let closest_z = start.z + segment_z * t;
    let dx = point.x - closest_x;
    let dz = point.z - closest_z;
    dx * dx + dz * dz
}

/// 2D (XZ) range + facing-cone test for `melee_arc`.
pub fn is_in_slash_arc(attacker_pos: &Vector3, target_pos: &Vector3, forward: &Vector3, range: f32, arc_degrees: f32) -> bool {
    let to_target = Vector3 {
        x: target_pos.x - attacker_pos.x,
        y: 0.0,
        z: target_pos.z - attacker_pos.z,
    };
    let distance_sq = to_target.x * to_target.x + to_target.z * to_target.z;
    if distance_sq > range * range {
        return false;
    }
    if distance_sq <= 0.0001 {
        return true;
    }
    let distance = distance_sq.sqrt();
    let direction = Vector3 { x: to_target.x / distance, y: 0.0, z: to_target.z / distance };
    let cos_half_arc = (arc_degrees.to_radians() * 0.5).cos();
    direction.x * forward.x + direction.z * forward.z >= cos_half_arc
}

/// `aoe_at_target`'s clamped target point: `actorPosition + forward * maxRange`.
/// `maxRange == 0` is self-centered (returns `actor_pos` unchanged).
pub fn aoe_target_point(actor_pos: &Vector3, forward: &Vector3, max_range: f32) -> Vector3 {
    Vector3 {
        x: actor_pos.x + forward.x * max_range,
        y: actor_pos.y,
        z: actor_pos.z + forward.z * max_range,
    }
}

pub fn in_aoe_radius(target_point: &Vector3, candidate_pos: &Vector3, radius: f32) -> bool {
    let dx = candidate_pos.x - target_point.x;
    let dz = candidate_pos.z - target_point.z;
    dx * dx + dz * dz <= radius * radius
}

/// `displace_self` spreads `total_distance` evenly over `active_ticks` per-tick calls.
pub fn displace_step_distance(total_distance: f32, active_ticks: u32) -> f32 {
    if active_ticks == 0 {
        0.0
    } else {
        total_distance / active_ticks as f32
    }
}

/// One tick of projectile travel: `speed / tick_rate` along `direction`.
pub fn step_projectile_position(position: &Vector3, direction: &Vector3, speed: f32, tick_rate: f32) -> (Vector3, f32) {
    let step = speed / tick_rate;
    (
        Vector3 {
            x: position.x + direction.x * step,
            y: position.y,
            z: position.z + direction.z * step,
        },
        step,
    )
}

/// Charge-scaled defs (attack_heavy today) resolve `chargeFraction` from `charge_ticks`;
/// every other def (tap/instant/sustain) always scales at full fraction (1.0), which is a
/// no-op for non-scaled (`min == max`) effect values.
pub fn resolve_charge_fraction(def: &ActionDef, charge_ticks: u64) -> f32 {
    match &def.hold {
        Some(HoldSpec::Charge { min_ticks, max_ticks }) => super::state::charge_fraction(*min_ticks, *max_ticks, charge_ticks as u32),
        _ => 1.0,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DamageKind {
    Hit,
    Blocked,
    Miss,
}

impl DamageKind {
    pub fn event_kind(self) -> &'static str {
        match self {
            DamageKind::Hit => "hit",
            DamageKind::Blocked => "blocked",
            DamageKind::Miss => "miss",
        }
    }
}

/// Pure damage resolution given the victim's derived invulnerable/mitigating status (see
/// `victim_is_invulnerable` / `victim_mitigation` below, which read the victim's live
/// `(action_id, phase)`). `invulnerable` (Active + Invulnerable effect) wins outright — 0
/// damage, `Miss`. Otherwise `mitigating` (Held + Mitigation effect) applies: the attacker's
/// `blockedDamage` overrides the multiplier math when present (chip damage).
pub fn resolve_damage(
    raw_damage: u32,
    blocked_damage_override: Option<u32>,
    victim_invulnerable: bool,
    victim_mitigation_multiplier: Option<f32>,
) -> (u32, DamageKind) {
    if victim_invulnerable {
        return (0, DamageKind::Miss);
    }
    if let Some(multiplier) = victim_mitigation_multiplier {
        let amount = blocked_damage_override.unwrap_or_else(|| ((raw_damage as f32) * multiplier).round().max(0.0) as u32);
        return (amount, DamageKind::Blocked);
    }
    (raw_damage, DamageKind::Hit)
}

pub fn def_has_invulnerable(def: &ActionDef) -> bool {
    def.effects.iter().any(|effect| matches!(effect, EffectDef::Invulnerable))
}

pub fn def_mitigation_multiplier(def: &ActionDef) -> Option<f32> {
    def.effects.iter().find_map(|effect| match effect {
        EffectDef::Mitigation { multiplier } => Some(*multiplier),
        _ => None,
    })
}

/// `invulnerable`: damage application checks the actor's phase is Active (with an
/// Invulnerable effect on its def).
pub fn victim_is_invulnerable(def: Option<&ActionDef>, phase: u8) -> bool {
    phase == super::state::PHASE_ACTIVE && def.map(def_has_invulnerable).unwrap_or(false)
}

/// `mitigation`: incoming damage x multiplier while Held (with a Mitigation effect on its def).
pub fn victim_mitigation(def: Option<&ActionDef>, phase: u8) -> Option<f32> {
    if phase != super::state::PHASE_HELD {
        return None;
    }
    def.and_then(def_mitigation_multiplier)
}

// ---------------------------------------------------------------------------
// Thin host shells — read/write ctx.db, delegate every decision to the pure fns above.
// One match over EffectDef (`apply_active_enter`) is the sanctioned extension point.
// ---------------------------------------------------------------------------

/// Resolve + apply damage/heal outcome against `target`, insert the action_event row, and
/// handle death (is_dead + respawn_tick + cancel in-flight action state) generically.
pub fn apply_damage(
    ctx: &ReducerContext,
    attacker: Identity,
    target: Identity,
    action_id: &str,
    raw_damage: u32,
    blocked_damage_override: Option<u32>,
    server_tick: u64,
    position: Option<Vector3>,
) {
    let Some(mut health) = ctx.db.player_health().identity().find(target) else {
        return;
    };
    if health.is_dead {
        return;
    }

    let victim_state = ctx.db.player_action_state().identity().find(target);
    let victim_def = victim_state.as_ref().and_then(|s| super::state::find_action_def(&s.action_id));
    let victim_phase = victim_state.as_ref().map(|s| s.phase).unwrap_or(super::state::PHASE_IDLE);
    let invulnerable = victim_is_invulnerable(victim_def, victim_phase);
    let mitigation = victim_mitigation(victim_def, victim_phase);

    let (amount, kind) = resolve_damage(raw_damage, blocked_damage_override, invulnerable, mitigation);

    ctx.db.action_event().insert(ActionEvent {
        id: 0,
        actor: attacker,
        target: Some(target),
        action_id: action_id.to_string(),
        kind: kind.event_kind().to_string(),
        amount: amount as i32,
        position,
        server_tick,
    });

    if matches!(kind, DamageKind::Miss) {
        return;
    }

    health.current_health = health.current_health.saturating_sub(amount);
    health.updated_at = ctx.timestamp;
    if health.current_health == 0 {
        health.is_dead = true;
        health.respawn_tick = server_tick + crate::player::respawn_delay_ticks();
        crate::player::cancel_action_state(ctx, target, server_tick);
    }
    ctx.db.player_health().identity().update(health);
}

/// Emitted whenever a Charging phase resolves into Windup (either an input-driven Release
/// or a tick-driven force-release at max_ticks) — `kind: "release"`, `amount` is the charge
/// fraction as a 0-100 percentage for client VFX.
pub fn emit_release_event(ctx: &ReducerContext, actor: Identity, action_id: &str, charge_fraction: f32, server_tick: u64) {
    let position = ctx.db.player_transform().identity().find(actor).map(|t| t.position.clone());
    ctx.db.action_event().insert(ActionEvent {
        id: 0,
        actor,
        target: None,
        action_id: action_id.to_string(),
        kind: "release".to_string(),
        amount: (charge_fraction * 100.0).round() as i32,
        position,
        server_tick,
    });
}

/// Fires exactly once, on the tick Active phase begins. One-shot effect kinds
/// (melee_arc / projectile spawn / aoe_at_target / heal_self) live here. DisplaceSelf is
/// per-tick (see `apply_active_tick`); Invulnerable / Mitigation are passive checks
/// consulted from `apply_damage` via the victim's own live phase, not applied here.
pub fn apply_active_enter(ctx: &ReducerContext, def: &ActionDef, actor: Identity, action_id: &str, charge_fraction: f32, server_tick: u64) {
    let Some(transform) = ctx.db.player_transform().identity().find(actor) else {
        return;
    };
    let forward = forward_vector(transform.rotation_y);

    for effect in def.effects {
        match effect {
            EffectDef::MeleeArc { range, arc_degrees, damage, blocked_damage } => {
                apply_melee_arc(ctx, actor, action_id, &transform.position, &forward, *range, *arc_degrees, damage, blocked_damage, charge_fraction, server_tick);
            }
            EffectDef::Projectile { max_distance, .. } => {
                ctx.db.projectile().insert(Projectile {
                    id: 0,
                    owner: actor,
                    action_id: action_id.to_string(),
                    position: transform.position.clone(),
                    previous_position: transform.position.clone(),
                    direction: forward.clone(),
                    spawned_at_tick: server_tick,
                    distance_traveled: 0.0,
                    max_distance: *max_distance,
                });
            }
            EffectDef::AoeAtTarget { radius, max_range, damage, blocked_damage } => {
                apply_aoe(ctx, actor, action_id, &transform.position, &forward, *radius, *max_range, damage, blocked_damage, charge_fraction, server_tick);
            }
            EffectDef::HealSelf { amount } => {
                apply_heal_self(ctx, actor, action_id, *amount, &transform.position, server_tick);
            }
            EffectDef::DisplaceSelf { .. } => {}
            EffectDef::Invulnerable => {}
            EffectDef::Mitigation { .. } => {}
        }
    }
}

/// Fires every tick while remaining in Active (including the entry tick). Only
/// `DisplaceSelf` acts here — spread over `active_ticks`, moved THROUGH the same
/// movement/collision channel (`collision::resolve_player_movement`) the movement tick
/// uses, so CSP/interp see it as any other position correction and it cannot roll through
/// walls or arena bounds.
pub fn apply_active_tick(ctx: &ReducerContext, def: &ActionDef, actor: Identity, server_tick: u64) {
    for effect in def.effects {
        if let EffectDef::DisplaceSelf { distance } = effect {
            let step = displace_step_distance(*distance, def.phases.active_ticks);
            if step <= 0.0 {
                continue;
            }
            let Some(mut transform) = ctx.db.player_transform().identity().find(actor) else {
                continue;
            };
            let forward = forward_vector(transform.rotation_y);
            let desired = Vector3 {
                x: transform.position.x + forward.x * step,
                y: transform.position.y,
                z: transform.position.z + forward.z * step,
            };
            transform.position = collision::resolve_player_movement(&transform.position, &desired).position;
            transform.server_tick = server_tick;
            transform.updated_at = ctx.timestamp;
            ctx.db.player_transform().identity().update(transform);
        }
    }
}

fn apply_melee_arc(
    ctx: &ReducerContext,
    attacker: Identity,
    action_id: &str,
    attacker_pos: &Vector3,
    forward: &Vector3,
    range: f32,
    arc_degrees: f32,
    damage: &ScaledValue,
    blocked_damage: &ScaledValue,
    charge_fraction: f32,
    server_tick: u64,
) {
    let raw = lerp_scaled(damage, charge_fraction).round().max(0.0) as u32;
    let blocked = lerp_scaled(blocked_damage, charge_fraction).round().max(0.0) as u32;

    let mut hit_any = false;
    let targets: Vec<PlayerHealth> = ctx.db.player_health().iter().collect();
    for target in targets {
        if target.identity == attacker || target.is_dead {
            continue;
        }
        let Some(target_transform) = ctx.db.player_transform().identity().find(target.identity) else {
            continue;
        };
        if is_in_slash_arc(attacker_pos, &target_transform.position, forward, range, arc_degrees) {
            hit_any = true;
            apply_damage(ctx, attacker, target.identity, action_id, raw, Some(blocked), server_tick, Some(target_transform.position.clone()));
        }
    }

    if !hit_any {
        ctx.db.action_event().insert(ActionEvent {
            id: 0,
            actor: attacker,
            target: None,
            action_id: action_id.to_string(),
            kind: "miss".to_string(),
            amount: 0,
            position: Some(attacker_pos.clone()),
            server_tick,
        });
    }
}

fn apply_aoe(
    ctx: &ReducerContext,
    attacker: Identity,
    action_id: &str,
    attacker_pos: &Vector3,
    forward: &Vector3,
    radius: f32,
    max_range: f32,
    damage: &ScaledValue,
    blocked_damage: &ScaledValue,
    charge_fraction: f32,
    server_tick: u64,
) {
    let target_point = aoe_target_point(attacker_pos, forward, max_range);
    let raw = lerp_scaled(damage, charge_fraction).round().max(0.0) as u32;
    let blocked = lerp_scaled(blocked_damage, charge_fraction).round().max(0.0) as u32;

    let mut hit_any = false;
    let targets: Vec<PlayerHealth> = ctx.db.player_health().iter().collect();
    for target in targets {
        if target.identity == attacker || target.is_dead {
            continue;
        }
        let Some(target_transform) = ctx.db.player_transform().identity().find(target.identity) else {
            continue;
        };
        if in_aoe_radius(&target_point, &target_transform.position, radius) {
            hit_any = true;
            apply_damage(ctx, attacker, target.identity, action_id, raw, Some(blocked), server_tick, Some(target_transform.position.clone()));
        }
    }

    if !hit_any {
        ctx.db.action_event().insert(ActionEvent {
            id: 0,
            actor: attacker,
            target: None,
            action_id: action_id.to_string(),
            kind: "miss".to_string(),
            amount: 0,
            position: Some(target_point),
            server_tick,
        });
    }
}

fn apply_heal_self(ctx: &ReducerContext, actor: Identity, action_id: &str, amount: f32, position: &Vector3, server_tick: u64) {
    let Some(mut health) = ctx.db.player_health().identity().find(actor) else {
        return;
    };
    if health.is_dead {
        return;
    }
    let requested = amount.round().max(0.0) as u32;
    let healed = requested.min(health.max_health.saturating_sub(health.current_health));
    health.current_health += healed;
    health.updated_at = ctx.timestamp;
    ctx.db.player_health().identity().update(health);

    ctx.db.action_event().insert(ActionEvent {
        id: 0,
        actor,
        target: Some(actor),
        action_id: action_id.to_string(),
        kind: "heal".to_string(),
        amount: healed as i32,
        position: Some(position.clone()),
        server_tick,
    });
}

/// First live, non-owner player capsule (fixed radius `collision::PLAYER_COLLISION_RADIUS`)
/// swept by the projectile's `start..end` segment this tick.
pub fn first_target_hit_by_segment(ctx: &ReducerContext, start: &Vector3, end: &Vector3, owner: Identity) -> Option<Identity> {
    let radius_sq = collision::PLAYER_COLLISION_RADIUS * collision::PLAYER_COLLISION_RADIUS;
    let candidates: Vec<PlayerHealth> = ctx.db.player_health().iter().collect();
    for candidate in candidates {
        if candidate.identity == owner || candidate.is_dead {
            continue;
        }
        let Some(transform) = ctx.db.player_transform().identity().find(candidate.identity) else {
            continue;
        };
        if distance_sq_to_segment_2d(&transform.position, start, end) <= radius_sq {
            return Some(candidate.identity);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::defs_generated::ACTION_DEFS;
    use crate::actions::state::{PHASE_ACTIVE, PHASE_HELD, PHASE_RECOVERY, PHASE_WINDUP};

    fn v(x: f32, z: f32) -> Vector3 {
        Vector3 { x, y: 0.0, z }
    }

    #[test]
    fn lerp_scaled_bounds() {
        let sv = ScaledValue { min: 10.0, max: 30.0 };
        assert_eq!(lerp_scaled(&sv, 0.0), 10.0);
        assert_eq!(lerp_scaled(&sv, 1.0), 30.0);
        assert_eq!(lerp_scaled(&sv, 0.5), 20.0);
        assert_eq!(lerp_scaled(&sv, -1.0), 10.0);
        assert_eq!(lerp_scaled(&sv, 2.0), 30.0);
    }

    #[test]
    fn melee_arc_hit_miss_edge_every_def() {
        for def in ACTION_DEFS {
            let Some(EffectDef::MeleeArc { range, arc_degrees, .. }) = def.effects.iter().find(|e| matches!(e, EffectDef::MeleeArc { .. })) else {
                continue;
            };
            let attacker_pos = v(0.0, 0.0);
            let forward = v(0.0, -1.0); // rotation_y = 0 faces -Z

            assert!(is_in_slash_arc(&attacker_pos, &v(0.0, -(*range * 0.5)), &forward, *range, *arc_degrees), "{}: dead ahead should hit", def.id);
            assert!(!is_in_slash_arc(&attacker_pos, &v(0.0, -(*range + 1.0)), &forward, *range, *arc_degrees), "{}: beyond range should miss", def.id);
            assert!(!is_in_slash_arc(&attacker_pos, &v(0.0, *range * 0.5), &forward, *range, *arc_degrees), "{}: directly behind should miss", def.id);
            assert!(is_in_slash_arc(&attacker_pos, &attacker_pos, &forward, *range, *arc_degrees), "{}: zero distance should hit", def.id);
        }
    }

    #[test]
    fn aoe_self_centered_when_max_range_zero() {
        for def in ACTION_DEFS {
            let Some(EffectDef::AoeAtTarget { max_range, .. }) = def.effects.iter().find(|e| matches!(e, EffectDef::AoeAtTarget { .. })) else {
                continue;
            };
            if *max_range == 0.0 {
                let actor = v(3.0, -4.0);
                let forward = v(1.0, 0.0);
                let target_point = aoe_target_point(&actor, &forward, *max_range);
                assert_eq!(target_point, actor, "{}: maxRange 0 must be self-centered", def.id);
            }
        }
    }

    #[test]
    fn aoe_radius_hit_and_miss_every_def() {
        for def in ACTION_DEFS {
            let Some(EffectDef::AoeAtTarget { radius, .. }) = def.effects.iter().find(|e| matches!(e, EffectDef::AoeAtTarget { .. })) else {
                continue;
            };
            let target_point = v(0.0, 0.0);
            assert!(in_aoe_radius(&target_point, &v(0.0, radius * 0.5), *radius), "{}: inside radius should hit", def.id);
            assert!(!in_aoe_radius(&target_point, &v(0.0, radius + 1.0), *radius), "{}: outside radius should miss", def.id);
        }
    }

    #[test]
    fn projectile_segment_and_step_every_def() {
        for def in ACTION_DEFS {
            let Some(EffectDef::Projectile { speed, max_distance, .. }) = def.effects.iter().find(|e| matches!(e, EffectDef::Projectile { .. })) else {
                continue;
            };
            let (next, step) = step_projectile_position(&v(0.0, 0.0), &v(0.0, -1.0), *speed, 20.0);
            assert!(step > 0.0, "{}", def.id);
            assert_eq!(next, v(0.0, -step), "{}", def.id);

            let start = v(0.0, 0.0);
            let end = v(0.0, -5.0);
            let radius_sq = collision::PLAYER_COLLISION_RADIUS * collision::PLAYER_COLLISION_RADIUS;
            assert!(distance_sq_to_segment_2d(&v(0.0, -2.5), &start, &end) <= radius_sq, "{}: on-segment target should be within hit radius", def.id);
            assert!(distance_sq_to_segment_2d(&v(10.0, -2.5), &start, &end) > radius_sq, "{}: far-off target should miss", def.id);

            assert!(*max_distance / step > 0.0, "{}", def.id);
        }
    }

    #[test]
    fn displace_step_spreads_evenly_every_def() {
        for def in ACTION_DEFS {
            let Some(EffectDef::DisplaceSelf { distance }) = def.effects.iter().find(|e| matches!(e, EffectDef::DisplaceSelf { .. })) else {
                continue;
            };
            if def.phases.active_ticks > 0 {
                let step = displace_step_distance(*distance, def.phases.active_ticks);
                let total: f32 = step * def.phases.active_ticks as f32;
                assert!((total - *distance).abs() < 0.001, "{}: steps must sum to total distance", def.id);
            }
        }
    }

    #[test]
    fn displace_respects_bounds_clamp() {
        let start = Vector3 { x: 19.9, y: 0.0, z: 0.0 };
        let forward = v(1.0, 0.0);
        let desired = Vector3 { x: start.x + forward.x * 4.0, y: 0.0, z: start.z };
        let resolved = collision::resolve_player_movement(&start, &desired).position;
        assert!(resolved.x <= 20.0 - collision::PLAYER_COLLISION_RADIUS + 0.001, "displace must clamp to arena bounds, got {}", resolved.x);
    }

    #[test]
    fn invulnerable_blocks_damage_hit_before_and_after_active_window() {
        for def in ACTION_DEFS {
            if def_has_invulnerable(def) {
                assert!(victim_is_invulnerable(Some(def), PHASE_ACTIVE), "{}: must be invulnerable during Active", def.id);
                assert!(!victim_is_invulnerable(Some(def), PHASE_WINDUP), "{}: not invulnerable before Active", def.id);
                assert!(!victim_is_invulnerable(Some(def), PHASE_RECOVERY), "{}: not invulnerable after Active", def.id);

                let (amount, kind) = resolve_damage(999, None, true, None);
                assert_eq!(amount, 0, "{}", def.id);
                assert_eq!(kind, DamageKind::Miss, "{}", def.id);
            }
        }
    }

    #[test]
    fn mitigation_math_including_blocked_damage_override() {
        for victim_def in ACTION_DEFS {
            let Some(multiplier) = def_mitigation_multiplier(victim_def) else {
                continue;
            };
            assert_eq!(victim_mitigation(Some(victim_def), PHASE_HELD), Some(multiplier), "{}", victim_def.id);
            assert!(victim_mitigation(Some(victim_def), PHASE_WINDUP).is_none(), "{}: mitigation only applies while Held", victim_def.id);

            for attacker_def in ACTION_DEFS {
                for effect in attacker_def.effects {
                    let (damage, blocked_damage) = match effect {
                        EffectDef::MeleeArc { damage, blocked_damage, .. } => (damage, blocked_damage),
                        EffectDef::Projectile { damage, blocked_damage, .. } => (damage, blocked_damage),
                        EffectDef::AoeAtTarget { damage, blocked_damage, .. } => (damage, blocked_damage),
                        _ => continue,
                    };
                    let raw = lerp_scaled(damage, 1.0).round().max(0.0) as u32;
                    let blocked_override = lerp_scaled(blocked_damage, 1.0).round().max(0.0) as u32;

                    let (amount, kind) = resolve_damage(raw, Some(blocked_override), false, Some(multiplier));
                    assert_eq!(amount, blocked_override, "{} vs {}: blockedDamage must override multiplier", attacker_def.id, victim_def.id);
                    assert_eq!(kind, DamageKind::Blocked);

                    let (amount_no_override, _) = resolve_damage(raw, None, false, Some(multiplier));
                    assert_eq!(amount_no_override, (raw as f32 * multiplier).round().max(0.0) as u32, "{} vs {}: multiplier fallback", attacker_def.id, victim_def.id);
                }
            }
        }
    }

    #[test]
    fn resolve_charge_fraction_generic() {
        for def in ACTION_DEFS {
            let fraction = resolve_charge_fraction(def, 0);
            match &def.hold {
                Some(HoldSpec::Charge { .. }) => assert!(fraction >= 0.0 && fraction <= 1.0, "{}", def.id),
                _ => assert_eq!(fraction, 1.0, "{}: non-charge defs always scale at full fraction", def.id),
            }
        }
    }
}
