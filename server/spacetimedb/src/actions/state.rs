use super::defs_generated::{self, ActionDef, ActionResourceCost, HoldSpec, InterruptPolicy};
use crate::tables::*;
use spacetimedb::{ReducerContext, Table};

pub const PHASE_IDLE: u8 = 0;
pub const PHASE_CHARGING: u8 = 1;
pub const PHASE_WINDUP: u8 = 2;
pub const PHASE_ACTIVE: u8 = 3;
pub const PHASE_HELD: u8 = 4;
pub const PHASE_RECOVERY: u8 = 5;

/// Look up an `ActionDef` by id. `None` for unknown/corrupt ids (data-integrity guard).
pub fn find_action_def(action_id: &str) -> Option<&'static ActionDef> {
    defs_generated::ACTION_DEFS.iter().find(|def| def.id == action_id)
}

/// Movement-speed multiplier for a player currently in `phase` of `action_id`.
/// This is the ONLY coordination point between the action pipeline and the movement tick —
/// callers must key off this signature and never branch on action_id directly.
/// TODO(movement, out of this slice's scope): the movement tick (player_logic.rs /
/// a future movement.rs, owned by a parallel wave) does not yet multiply desired move
/// speed by this fraction. Wire it in at the movement tick's speed calculation once that
/// module is ready to consume it.
pub fn movement_fraction(action_id: &str, phase: u8) -> f32 {
    if action_id.is_empty() {
        return 1.0;
    }
    let Some(def) = find_action_def(action_id) else {
        return 1.0;
    };
    match phase {
        PHASE_CHARGING => def.movement.charging,
        PHASE_WINDUP => def.movement.windup,
        PHASE_ACTIVE => def.movement.active,
        PHASE_HELD => def.movement.held,
        PHASE_RECOVERY => def.movement.recovery,
        _ => 1.0,
    }
}

/// Pure cooldown gate: `ready_tick` is `None` when the action has never been used.
pub fn cooldown_ready(ready_tick: Option<u64>, now_tick: u64) -> bool {
    ready_tick.map(|ready| now_tick >= ready).unwrap_or(true)
}

/// Pure resource gate. `None` resource requirement always passes.
pub fn resource_check(resource: &Option<ActionResourceCost>, available: Option<u32>) -> Result<(), String> {
    match resource {
        None => Ok(()),
        Some(cost) => {
            let have = available.unwrap_or(0);
            if have < cost.cost {
                Err(format!("Insufficient resource: {}", cost.kind))
            } else {
                Ok(())
            }
        }
    }
}

/// Pure interrupt gate: can a NEW action Press overwrite the CURRENT one right now?
/// `never`: only from Idle. `recovery`: from Idle or once the current action reached
/// Recovery. `always`: any phase. Unknown current def (data corruption) degrades permissive.
pub fn can_interrupt(current_def: Option<&ActionDef>, current_phase: u8, current_action_id: &str) -> bool {
    if current_action_id.is_empty() || current_phase == PHASE_IDLE {
        return true;
    }
    match current_def.map(|def| &def.interrupt) {
        None => true,
        Some(InterruptPolicy::Always) => true,
        Some(InterruptPolicy::Never) => false,
        Some(InterruptPolicy::Recovery) => current_phase == PHASE_RECOVERY,
    }
}

/// `clamp((heldTicks - minTicks) / (maxTicks - minTicks), 0, 1)`, saturating below `minTicks`
/// and at/above `maxTicks`. Degenerate `maxTicks <= minTicks` returns 1.0.
pub fn charge_fraction(min_ticks: u32, max_ticks: u32, held_ticks: u32) -> f32 {
    if max_ticks <= min_ticks {
        return 1.0;
    }
    ((held_ticks.saturating_sub(min_ticks)) as f32 / (max_ticks - min_ticks) as f32).clamp(0.0, 1.0)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhaseTransitionInput {
    pub phase: u8,
    pub phase_started_tick: u64,
    pub phase_ends_tick: u64,
    pub charge_ticks: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhaseAdvance {
    pub next_phase: u8,
    pub next_phase_started_tick: u64,
    pub next_phase_ends_tick: u64,
    pub charge_ticks: u64,
    /// `Some(fraction)` only when this transition is a tick-driven FORCE-release out of
    /// Charging (the player never sent a Release edge before `max_ticks`). A normal,
    /// input-driven release is handled entirely in actions/input.rs and never flows through
    /// this function.
    pub force_release_charge_fraction: Option<f32>,
    /// True exactly when this transition reaches Idle (Recovery -> Idle): the action is
    /// fully complete and `action_id` should clear.
    pub completes: bool,
    /// True exactly on the tick Active phase begins (Windup -> Active): one-shot
    /// active-window effects (melee_arc / projectile / aoe_at_target / heal_self) fire here.
    pub enters_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PhaseTransitionResult {
    /// `phase_ends_tick` has not arrived yet (or the row is Held/Idle, which never
    /// auto-advances from tick alone — Held waits for an explicit Release edge).
    NoChange,
    Advance(PhaseAdvance),
}

/// Pure phase-machine step: given a def and the current row values, decide whether
/// `now_tick` has crossed `phase_ends_tick` and, if so, what the next phase looks like.
/// Host-free — no `ReducerContext` — directly unit-testable.
///
/// Idle -> [Charging] -> Windup -> Active -> [Held] -> Recovery -> Idle
/// - Charging only auto-advances via this function as a FORCE-release at `max_ticks`;
///   a normal release is resolved in input.rs (Charging ticks already served either
///   convert to the tap action's windup, or resolve the hold action with its charge
///   fraction) and never calls this function for that transition.
/// - Windup -> Active when `active_ticks > 0`; Windup -> Held (indefinite) for
///   `hold.mode = sustain` when `active_ticks == 0`; otherwise Windup -> Recovery directly
///   (generic fallback for a hypothetical zero-active, non-sustain def).
/// - Active always advances to Recovery at its deadline.
/// - Held never auto-advances (waits for Release, handled in input.rs).
/// - Recovery always advances to Idle, clearing the action (`completes: true`).
pub fn advance_phase(def: &ActionDef, input: &PhaseTransitionInput, now_tick: u64) -> PhaseTransitionResult {
    if input.phase == PHASE_IDLE {
        return PhaseTransitionResult::NoChange;
    }
    if input.phase_ends_tick == 0 {
        // Held (sustain): indefinite, waits for an explicit Release edge.
        return PhaseTransitionResult::NoChange;
    }
    if now_tick < input.phase_ends_tick {
        return PhaseTransitionResult::NoChange;
    }

    match input.phase {
        PHASE_CHARGING => {
            let (min_ticks, max_ticks) = match &def.hold {
                Some(HoldSpec::Charge { min_ticks, max_ticks }) => (*min_ticks, *max_ticks),
                _ => (0, 0),
            };
            let held_ticks = now_tick.saturating_sub(input.phase_started_tick) as u32;
            let fraction = charge_fraction(min_ticks, max_ticks, held_ticks);
            let windup_ticks = def.phases.windup_ticks as u64;
            PhaseTransitionResult::Advance(PhaseAdvance {
                next_phase: PHASE_WINDUP,
                next_phase_started_tick: now_tick,
                next_phase_ends_tick: now_tick + windup_ticks,
                charge_ticks: held_ticks.min(max_ticks) as u64,
                force_release_charge_fraction: Some(fraction),
                completes: false,
                enters_active: windup_ticks == 0,
            })
        }
        PHASE_WINDUP => {
            if def.phases.active_ticks > 0 {
                PhaseTransitionResult::Advance(PhaseAdvance {
                    next_phase: PHASE_ACTIVE,
                    next_phase_started_tick: now_tick,
                    next_phase_ends_tick: now_tick + def.phases.active_ticks as u64,
                    charge_ticks: input.charge_ticks,
                    force_release_charge_fraction: None,
                    completes: false,
                    enters_active: true,
                })
            } else if matches!(def.hold, Some(HoldSpec::Sustain { .. })) {
                PhaseTransitionResult::Advance(PhaseAdvance {
                    next_phase: PHASE_HELD,
                    next_phase_started_tick: now_tick,
                    next_phase_ends_tick: 0,
                    charge_ticks: input.charge_ticks,
                    force_release_charge_fraction: None,
                    completes: false,
                    enters_active: false,
                })
            } else {
                PhaseTransitionResult::Advance(PhaseAdvance {
                    next_phase: PHASE_RECOVERY,
                    next_phase_started_tick: now_tick,
                    next_phase_ends_tick: now_tick + def.phases.recovery_ticks as u64,
                    charge_ticks: input.charge_ticks,
                    force_release_charge_fraction: None,
                    completes: false,
                    enters_active: false,
                })
            }
        }
        PHASE_ACTIVE => PhaseTransitionResult::Advance(PhaseAdvance {
            next_phase: PHASE_RECOVERY,
            next_phase_started_tick: now_tick,
            next_phase_ends_tick: now_tick + def.phases.recovery_ticks as u64,
            charge_ticks: input.charge_ticks,
            force_release_charge_fraction: None,
            completes: false,
            enters_active: false,
        }),
        PHASE_RECOVERY => PhaseTransitionResult::Advance(PhaseAdvance {
            next_phase: PHASE_IDLE,
            next_phase_started_tick: now_tick,
            next_phase_ends_tick: 0,
            charge_ticks: 0,
            force_release_charge_fraction: None,
            completes: true,
            enters_active: false,
        }),
        _ => PhaseTransitionResult::NoChange,
    }
}

/// Advance every player's action-state row whose phase deadline has arrived this tick.
/// Thin host shell: all decisions come from `advance_phase`; effect application is
/// delegated to `super::effects` (also thin shells over pure helpers there).
pub fn advance_all(ctx: &ReducerContext, server_tick: u64) {
    let rows: Vec<PlayerActionState> = ctx.db.player_action_state().iter().collect();
    for mut row in rows {
        if row.action_id.is_empty() || row.phase == PHASE_IDLE {
            continue;
        }
        let Some(def) = find_action_def(&row.action_id) else {
            continue;
        };

        let input = PhaseTransitionInput {
            phase: row.phase,
            phase_started_tick: row.phase_started_tick,
            phase_ends_tick: row.phase_ends_tick,
            charge_ticks: row.charge_ticks,
        };

        match advance_phase(def, &input, server_tick) {
            PhaseTransitionResult::NoChange => {
                if row.phase == PHASE_ACTIVE {
                    super::effects::apply_active_tick(ctx, def, row.identity, server_tick);
                }
            }
            PhaseTransitionResult::Advance(advance) => {
                let identity = row.identity;
                let action_id = row.action_id.clone();

                row.phase = advance.next_phase;
                row.phase_started_tick = advance.next_phase_started_tick;
                row.phase_ends_tick = advance.next_phase_ends_tick;
                row.charge_ticks = advance.charge_ticks;
                row.server_tick = server_tick;
                if advance.completes {
                    row.action_id = String::new();
                }
                ctx.db.player_action_state().identity().update(row);

                if let Some(fraction) = advance.force_release_charge_fraction {
                    super::effects::emit_release_event(ctx, identity, &action_id, fraction, server_tick);
                }
                if advance.enters_active {
                    let fraction = super::effects::resolve_charge_fraction(def, advance.charge_ticks);
                    super::effects::apply_active_enter(ctx, def, identity, &action_id, fraction, server_tick);
                    super::effects::apply_active_tick(ctx, def, identity, server_tick);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::defs_generated::ACTION_DEFS;

    #[test]
    fn cooldown_ready_generic() {
        assert!(cooldown_ready(None, 0));
        assert!(!cooldown_ready(Some(10), 5));
        assert!(cooldown_ready(Some(10), 10));
        assert!(cooldown_ready(Some(10), 11));
    }

    #[test]
    fn resource_check_generic_over_every_def() {
        for def in ACTION_DEFS {
            match &def.resource {
                None => {
                    assert!(resource_check(&def.resource, Some(0)).is_ok(), "{}", def.id);
                    assert!(resource_check(&def.resource, None).is_ok(), "{}", def.id);
                }
                Some(cost) => {
                    if cost.cost > 0 {
                        assert!(resource_check(&def.resource, Some(cost.cost - 1)).is_err(), "{}", def.id);
                    }
                    assert!(resource_check(&def.resource, Some(cost.cost)).is_ok(), "{}", def.id);
                    assert!(resource_check(&def.resource, None).is_err(), "{}", def.id);
                }
            }
        }
    }

    #[test]
    fn charge_fraction_clamps_generic_over_every_charge_def() {
        for def in ACTION_DEFS {
            if let Some(HoldSpec::Charge { min_ticks, max_ticks }) = &def.hold {
                assert_eq!(charge_fraction(*min_ticks, *max_ticks, 0), 0.0, "{}", def.id);
                assert_eq!(charge_fraction(*min_ticks, *max_ticks, *min_ticks), 0.0, "{}", def.id);
                assert_eq!(charge_fraction(*min_ticks, *max_ticks, *max_ticks), 1.0, "{}", def.id);
                assert_eq!(charge_fraction(*min_ticks, *max_ticks, *max_ticks + 100), 1.0, "{}", def.id);
                let mid = (*min_ticks + *max_ticks) / 2;
                let f = charge_fraction(*min_ticks, *max_ticks, mid);
                assert!(f > 0.0 && f < 1.0, "{} mid fraction {}", def.id, f);
            }
        }
    }

    #[test]
    fn can_interrupt_policy_matrix() {
        assert!(can_interrupt(None, PHASE_IDLE, ""));

        let never_def = ACTION_DEFS.iter().find(|d| matches!(d.interrupt, InterruptPolicy::Never)).expect("a Never def exists");
        for phase in [PHASE_CHARGING, PHASE_WINDUP, PHASE_ACTIVE, PHASE_HELD, PHASE_RECOVERY] {
            assert!(!can_interrupt(Some(never_def), phase, never_def.id), "{}: never must reject phase {}", never_def.id, phase);
        }

        let always_def = ACTION_DEFS.iter().find(|d| matches!(d.interrupt, InterruptPolicy::Always)).expect("an Always def exists");
        for phase in [PHASE_CHARGING, PHASE_WINDUP, PHASE_ACTIVE, PHASE_HELD, PHASE_RECOVERY] {
            assert!(can_interrupt(Some(always_def), phase, always_def.id), "{}: always must accept phase {}", always_def.id, phase);
        }

        let recovery_def = ACTION_DEFS.iter().find(|d| matches!(d.interrupt, InterruptPolicy::Recovery)).expect("a Recovery def exists");
        assert!(!can_interrupt(Some(recovery_def), PHASE_WINDUP, recovery_def.id));
        assert!(can_interrupt(Some(recovery_def), PHASE_RECOVERY, recovery_def.id));
    }

    fn check_recovery_to_idle(def: &ActionDef, entering_recovery: &PhaseAdvance) {
        let recovery_end = entering_recovery.next_phase_ends_tick;
        assert_eq!(recovery_end, entering_recovery.next_phase_started_tick + def.phases.recovery_ticks as u64, "{}", def.id);
        let recovery_state = PhaseTransitionInput {
            phase: PHASE_RECOVERY,
            phase_started_tick: entering_recovery.next_phase_started_tick,
            phase_ends_tick: recovery_end,
            charge_ticks: 0,
        };
        if def.phases.recovery_ticks > 0 {
            assert_eq!(advance_phase(def, &recovery_state, recovery_end - 1), PhaseTransitionResult::NoChange, "{}: premature recovery", def.id);
        }
        let PhaseTransitionResult::Advance(after_recovery) = advance_phase(def, &recovery_state, recovery_end) else {
            panic!("{}: recovery must advance to idle at its deadline", def.id);
        };
        assert_eq!(after_recovery.next_phase, PHASE_IDLE, "{}", def.id);
        assert!(after_recovery.completes, "{}", def.id);
    }

    #[test]
    fn advance_phase_full_lifecycle_every_def() {
        for def in ACTION_DEFS {
            let start = 1000u64;
            let windup_end = start + def.phases.windup_ticks as u64;
            let windup_state = PhaseTransitionInput {
                phase: PHASE_WINDUP,
                phase_started_tick: start,
                phase_ends_tick: windup_end,
                charge_ticks: 0,
            };
            if def.phases.windup_ticks > 0 {
                assert_eq!(advance_phase(def, &windup_state, windup_end - 1), PhaseTransitionResult::NoChange, "{}: premature windup", def.id);
            }
            let PhaseTransitionResult::Advance(after_windup) = advance_phase(def, &windup_state, windup_end) else {
                panic!("{}: windup must advance at its deadline", def.id);
            };

            if def.phases.active_ticks > 0 {
                assert!(after_windup.enters_active, "{}", def.id);
                assert_eq!(after_windup.next_phase, PHASE_ACTIVE, "{}", def.id);
                let active_end = after_windup.next_phase_ends_tick;
                assert_eq!(active_end, after_windup.next_phase_started_tick + def.phases.active_ticks as u64, "{}", def.id);
                let active_state = PhaseTransitionInput {
                    phase: PHASE_ACTIVE,
                    phase_started_tick: after_windup.next_phase_started_tick,
                    phase_ends_tick: active_end,
                    charge_ticks: after_windup.charge_ticks,
                };
                if def.phases.active_ticks > 1 {
                    assert_eq!(advance_phase(def, &active_state, active_end - 1), PhaseTransitionResult::NoChange, "{}: premature active", def.id);
                }
                let PhaseTransitionResult::Advance(after_active) = advance_phase(def, &active_state, active_end) else {
                    panic!("{}: active must advance at its deadline", def.id);
                };
                assert_eq!(after_active.next_phase, PHASE_RECOVERY, "{}", def.id);
                check_recovery_to_idle(def, &after_active);
            } else if matches!(def.hold, Some(HoldSpec::Sustain { .. })) {
                assert_eq!(after_windup.next_phase, PHASE_HELD, "{}", def.id);
                assert_eq!(after_windup.next_phase_ends_tick, 0, "{}", def.id);
                let held_state = PhaseTransitionInput {
                    phase: PHASE_HELD,
                    phase_started_tick: after_windup.next_phase_started_tick,
                    phase_ends_tick: 0,
                    charge_ticks: 0,
                };
                assert_eq!(
                    advance_phase(def, &held_state, held_state.phase_started_tick + 999),
                    PhaseTransitionResult::NoChange,
                    "{}: held waits for Release",
                    def.id
                );
            } else {
                assert_eq!(after_windup.next_phase, PHASE_RECOVERY, "{}: zero-active non-sustain skips straight to recovery", def.id);
                check_recovery_to_idle(def, &after_windup);
            }
        }
    }

    #[test]
    fn force_release_at_max_ticks_every_charge_def() {
        for def in ACTION_DEFS {
            if let Some(HoldSpec::Charge { max_ticks, .. }) = &def.hold {
                let input = PhaseTransitionInput {
                    phase: PHASE_CHARGING,
                    phase_started_tick: 0,
                    phase_ends_tick: *max_ticks as u64,
                    charge_ticks: 0,
                };
                assert_eq!(advance_phase(def, &input, *max_ticks as u64 - 1), PhaseTransitionResult::NoChange, "{}", def.id);
                let PhaseTransitionResult::Advance(advance) = advance_phase(def, &input, *max_ticks as u64) else {
                    panic!("{}: should force-release at max_ticks", def.id);
                };
                assert_eq!(advance.next_phase, PHASE_WINDUP, "{}", def.id);
                assert_eq!(advance.force_release_charge_fraction, Some(1.0), "{}", def.id);
            }
        }
    }

    #[test]
    fn movement_fraction_matches_def_generic() {
        for def in ACTION_DEFS {
            assert_eq!(movement_fraction(def.id, PHASE_CHARGING), def.movement.charging);
            assert_eq!(movement_fraction(def.id, PHASE_WINDUP), def.movement.windup);
            assert_eq!(movement_fraction(def.id, PHASE_ACTIVE), def.movement.active);
            assert_eq!(movement_fraction(def.id, PHASE_HELD), def.movement.held);
            assert_eq!(movement_fraction(def.id, PHASE_RECOVERY), def.movement.recovery);
        }
        assert_eq!(movement_fraction("", PHASE_WINDUP), 1.0);
        assert_eq!(movement_fraction("nonexistent", PHASE_WINDUP), 1.0);
    }

    #[test]
    fn golden_rule_unknown_hold_resource_combo_still_gates_generically() {
        // A synthetic def combining hold+resource (a combo not present in shared/actions.json)
        // must still gate through the SAME generic resource_check path — proving no
        // action-id special-casing anywhere in the gate.
        let synthetic_resource = Some(ActionResourceCost { kind: "mana", cost: 5 });
        assert!(resource_check(&synthetic_resource, Some(4)).is_err());
        assert!(resource_check(&synthetic_resource, Some(5)).is_ok());
    }
}
