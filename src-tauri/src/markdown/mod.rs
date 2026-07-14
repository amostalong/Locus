//! Markdown processing utilities used by the agent round-finalize path.
//!
//! - [`parts`] splits a markdown source into `MarkdownPart::Text` /
//!   `MarkdownPart::CodeBlock` so the round's render parts can carry
//!   per-block metadata (file path, source line number) into the
//!   frontend.
//! - [`fence_stream`] is the streaming counterpart: a per-token state
//!   machine that emits `FenceStreamEvent` values for in-flight
//!   `TextDelta` / `CodeBlock*` events so the chat view can render
//!   fenced code blocks in real time.
//! - [`fence_emit`] glues the streamer to the wire-level `StreamEvent`
//!   enum, allocating stable part IDs and `render_seq` values so the
//!   chat view's chunk streams pick the right slots.

pub mod fence_emit;
pub mod fence_stream;
pub mod parts;
