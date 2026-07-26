// `mod player` shadows the `player` table-accessor re-export from tables; submodules
// import accessors via `use crate::tables::*` so this is intentional.
#![allow(hidden_glob_reexports)]

mod actions;
mod collision;
mod common;
mod locomotion;
mod net;
mod player;
mod player_logic;
mod tables;
mod tick;

// Re-export table types + SpacetimeDB table-accessor traits (`ctx.db.player()`, etc.).
pub use tables::*;
use common::TICK_RATE;
use spacetimedb::{ReducerContext, ScheduleAt, Table};
use std::time::Duration;

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    assert_eq!(
        actions::defs_generated::ACTIONS_TICK_RATE,
        TICK_RATE as u32,
        "shared/actions.json tickRate must match common::TICK_RATE"
    );

    if ctx.db.config().count() == 0 {
        ctx.db.config().insert(Config {
            version: 1,
            tick_rate: TICK_RATE as u32,
        });
    }

    if ctx.db.tick_state().count() == 0 {
        ctx.db.tick_state().insert(TickState {
            version: 1,
            server_tick: 0,
        });
    }

    if ctx.db.game_tick_schedule().count() == 0 {
        let interval = Duration::from_millis((1000.0 / TICK_RATE) as u64);
        ctx.db.game_tick_schedule().insert(GameTickSchedule {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Interval(interval.into()),
        });
    }

    // Clear stale client sessions on init/restart
    for session in ctx.db.client_session().iter() {
        ctx.db
            .client_session()
            .connection_id()
            .delete(&session.connection_id);
    }
}

#[spacetimedb::reducer(client_connected)]
pub fn identity_connected(ctx: &ReducerContext) {
    let Some(connection_id) = ctx.connection_id() else {
        spacetimedb::log::warn!("Identity connected without connection id: {}", ctx.sender());
        return;
    };

    spacetimedb::log::info!("Identity connected: {} ({:?})", ctx.sender(), connection_id);
    if ctx
        .db
        .client_session()
        .connection_id()
        .find(&connection_id)
        .is_none()
    {
        ctx.db.client_session().insert(ClientSession {
            connection_id,
            identity: ctx.sender(),
            connected_at: ctx.timestamp,
        });
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn identity_disconnected(ctx: &ReducerContext) {
    let identity = ctx.sender();
    let Some(connection_id) = ctx.connection_id() else {
        spacetimedb::log::warn!("Identity disconnected without connection id: {}", identity);
        return;
    };

    spacetimedb::log::info!("Identity disconnected: {} ({:?})", identity, connection_id);
    ctx.db
        .client_session()
        .connection_id()
        .delete(&connection_id);

    let still_connected = ctx
        .db
        .client_session()
        .iter()
        .any(|session| session.identity == identity);
    if !still_connected {
        player::cleanup_player(ctx, identity);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn actions_tick_rate_matches_common_tick_rate() {
        assert_eq!(
            crate::actions::ACTIONS_TICK_RATE,
            crate::common::TICK_RATE as u32
        );
    }
}

