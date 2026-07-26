use super::defs_generated;
use spacetimedb::ReducerContext;

#[allow(dead_code)] // wave1 skeleton; used by phase machine in wave2
pub fn phase_for_action_id(action_id: &str) -> Option<&'static defs_generated::ActionDef> {
    defs_generated::ACTION_DEFS
        .iter()
        .find(|def| def.id == action_id)
}

pub fn advance_all(ctx: &ReducerContext, server_tick: u64) {
    // TODO(wave1->wave2): drive phase transitions from phase_ends_tick
    let _ = (ctx, server_tick);
}
