use super::defs_generated::{EffectDef};
use crate::common::Vector3;
use spacetimedb::{Identity, ReducerContext};

#[allow(dead_code)] // wave1 stub; called from phase machine in wave2
pub fn apply(
    ctx: &ReducerContext,
    def: &EffectDef,
    actor: Identity,
    aim: Option<Vector3>,
    charge_fraction: f32,
) {
    match def {
        EffectDef::MeleeArc { .. } => {
            let _ = (ctx, actor, aim, charge_fraction);
        }
        EffectDef::Projectile { .. } => {
            let _ = (ctx, actor, aim, charge_fraction);
        }
        EffectDef::AoeAtTarget { .. } => {
            let _ = (ctx, actor, aim, charge_fraction);
        }
        EffectDef::HealSelf { .. } => {
            let _ = (ctx, actor, aim, charge_fraction);
        }
        EffectDef::DisplaceSelf { .. } => {
            let _ = (ctx, actor, aim, charge_fraction);
        }
        EffectDef::Invulnerable => {
            let _ = (ctx, actor, aim, charge_fraction);
        }
        EffectDef::Mitigation { .. } => {
            let _ = (ctx, actor, aim, charge_fraction);
        }
    }
}
