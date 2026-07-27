//! Tick-health measurement: pure integer arithmetic over wall-clock gaps between
//! `game_tick` invocations. Math lives in free functions so it can run under
//! `cargo test` (reducers cannot). No floats, no allocations, no logging.

use crate::tables::{tick_stats, TickStats};
use spacetimedb::{ReducerContext, Table};

pub const TARGET_INTERVAL_US: u64 = 50_000;
pub const WINDOW_TICKS: u64 = 100; // ~5s at 20Hz
const EWMA_ALPHA_DEN: u64 = 10; // alpha = 1/10

/// `now - prev`, clamped to 0 if negative or if prev is 0 / greater than now.
pub fn interval_us(prev_at_us: i64, now_at_us: i64) -> u64 {
    if prev_at_us == 0 || prev_at_us > now_at_us {
        0
    } else {
        (now_at_us as u64).saturating_sub(prev_at_us as u64)
    }
}

/// Integer EWMA with alpha = 1/10. Seeds from the first non-zero sample so the
/// average does not crawl up from zero over many ticks.
pub fn ewma_step(prev: u64, sample: u64) -> u64 {
    if prev == 0 {
        return sample;
    }
    if sample >= prev {
        prev + (sample - prev) / EWMA_ALPHA_DEN
    } else {
        prev - (prev - sample) / EWMA_ALPHA_DEN
    }
}

/// Exact "interval > 1.5 * target" without floats: `2 * interval > 3 * target`.
pub fn is_late(interval_us: u64, target_us: u64) -> bool {
    interval_us.saturating_mul(2) > target_us.saturating_mul(3)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub started_tick: u64,
    pub max_interval_us: u64,
    pub late_ticks: u32,
}

/// Fold one sample into the sliding window. Restarts (does not decay) when the
/// window boundary is crossed so a single spike cannot pin max forever.
pub fn window_step(
    prev: Window,
    server_tick: u64,
    sample_us: u64,
    target_us: u64,
    window_ticks: u64,
) -> Window {
    let base = if server_tick.saturating_sub(prev.started_tick) >= window_ticks {
        Window {
            started_tick: server_tick,
            max_interval_us: 0,
            late_ticks: 0,
        }
    } else {
        prev
    };
    Window {
        started_tick: base.started_tick,
        max_interval_us: base.max_interval_us.max(sample_us),
        late_ticks: base
            .late_ticks
            .saturating_add(is_late(sample_us, target_us) as u32),
    }
}

/// Upsert the public `tick_stats` singleton from one tick's wall-clock gap.
/// One index lookup and exactly one row write per call. The insert arm is not dead code:
/// a publish that migrates in place adds the table empty without re-running `init`.
pub fn record(ctx: &ReducerContext, server_tick: u64, prev_at_us: i64, now_at_us: i64) {
    let existing = ctx.db.tick_stats().id().find(0);

    // `prev_at_us == 0` is the first tick after a fresh publish: there is no earlier
    // invocation to measure against, so seed rather than report a bogus interval.
    let row = match (prev_at_us, &existing) {
        (0, _) | (_, None) => TickStats {
            id: 0,
            server_tick,
            last_interval_us: 0,
            interval_ewma_us: 0,
            max_interval_us_window: 0,
            late_ticks_window: 0,
            window_started_tick: server_tick,
        },
        (_, Some(prev)) => {
            let interval = interval_us(prev_at_us, now_at_us);
            let window = window_step(
                Window {
                    started_tick: prev.window_started_tick,
                    max_interval_us: prev.max_interval_us_window,
                    late_ticks: prev.late_ticks_window,
                },
                server_tick,
                interval,
                TARGET_INTERVAL_US,
                WINDOW_TICKS,
            );
            TickStats {
                id: 0,
                server_tick,
                last_interval_us: interval,
                interval_ewma_us: ewma_step(prev.interval_ewma_us, interval),
                max_interval_us_window: window.max_interval_us,
                late_ticks_window: window.late_ticks,
                window_started_tick: window.started_tick,
            }
        }
    };

    if existing.is_some() {
        ctx.db.tick_stats().id().update(row);
    } else {
        ctx.db.tick_stats().insert(row);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ewma_seeds_from_zero() {
        assert_eq!(ewma_step(0, 50_000), 50_000);
        assert_eq!(ewma_step(0, 0), 0);
    }

    #[test]
    fn ewma_converges_upward_and_downward_without_underflow() {
        let up = ewma_step(50_000, 100_000);
        assert_eq!(up, 50_000 + (100_000 - 50_000) / 10);
        assert!(up > 50_000);

        let down = ewma_step(50_000, 0);
        assert_eq!(down, 50_000 - 50_000 / 10);
        assert!(down < 50_000);

        // Far below prev still cannot underflow past the integer step.
        assert_eq!(ewma_step(1, 0), 1);
    }

    #[test]
    fn ewma_dead_zone_for_tiny_deltas() {
        // Deltas smaller than EWMA_ALPHA_DEN vanish under integer division.
        assert_eq!(ewma_step(50_000, 50_009), 50_000);
        assert_eq!(ewma_step(50_000, 49_991), 50_000);
    }

    #[test]
    fn is_late_at_exactly_one_point_five_and_just_above() {
        let target = TARGET_INTERVAL_US;
        let exact = target + target / 2; // 1.5x
        assert!(!is_late(exact, target));
        assert!(is_late(exact + 1, target));
    }

    #[test]
    fn interval_us_clamps_negative_or_backwards_delta() {
        assert_eq!(interval_us(0, 1_000_000), 0);
        assert_eq!(interval_us(100, 50), 0);
        assert_eq!(interval_us(100, 100), 0);
        assert_eq!(interval_us(100, 150), 50);
    }

    #[test]
    fn window_step_accumulates_max_and_late_within_window() {
        let start = Window {
            started_tick: 10,
            max_interval_us: 0,
            late_ticks: 0,
        };
        let mid = window_step(start, 15, 40_000, TARGET_INTERVAL_US, WINDOW_TICKS);
        assert_eq!(
            mid,
            Window {
                started_tick: 10,
                max_interval_us: 40_000,
                late_ticks: 0,
            }
        );
        let late = window_step(mid, 16, 80_000, TARGET_INTERVAL_US, WINDOW_TICKS);
        assert_eq!(
            late,
            Window {
                started_tick: 10,
                max_interval_us: 80_000,
                late_ticks: 1,
            }
        );
    }

    #[test]
    fn window_step_restarts_cleanly_at_boundary() {
        let prev = Window {
            started_tick: 0,
            max_interval_us: 999_999,
            late_ticks: 42,
        };
        // server_tick - started >= WINDOW_TICKS → restart, then fold this sample.
        let next = window_step(prev, WINDOW_TICKS, 45_000, TARGET_INTERVAL_US, WINDOW_TICKS);
        assert_eq!(
            next,
            Window {
                started_tick: WINDOW_TICKS,
                max_interval_us: 45_000,
                late_ticks: 0,
            }
        );
    }

    #[test]
    fn target_and_window_match_common_tick_rate() {
        assert_eq!(
            TARGET_INTERVAL_US,
            (1_000_000.0 / crate::common::TICK_RATE) as u64
        );
        assert_eq!(WINDOW_TICKS, (crate::common::TICK_RATE * 5.0) as u64);
    }
}
