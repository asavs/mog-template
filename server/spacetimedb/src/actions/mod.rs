#[path = "defs.generated.rs"]
pub mod defs_generated;
pub use defs_generated::*;

pub mod effects;
pub mod input;
pub mod state;

#[derive(spacetimedb::SpacetimeType, Clone, Copy, Debug, PartialEq)]
pub enum InputEdge {
    Press,
    Release,
}
