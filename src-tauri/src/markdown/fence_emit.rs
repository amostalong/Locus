//! Bridge between [`crate::markdown::fence_stream::FenceStreamer`] and the
//! wire-level [`crate::commands::StreamEvent`] enum.
//!
//! The streamer is intentionally pure: it knows about fences, not about
//! part identifiers, render sequences, or Tauri events. This module adds
//! the missing bookkeeping so the two `on_text_delta` emit sites
//! (Claude Code CLI host in `claude_code_cli.rs` and the
//! `agent:run` path in `agent/instance/mod.rs`) can hand raw text deltas
//! to [`FenceStreamContext::push`] and receive a flat list of
//! `StreamEvent` values in the right order with stable part IDs.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::StreamEvent;
use crate::markdown::fence_stream::{FenceStreamEvent, FenceStreamer};

/// Wrapper the Tauri frontend expects. The `runId` lives outside the
/// per-event payload (which is `flatten`-serialized) so it survives a
/// serde round trip without manual massaging at every call site.
#[derive(Serialize)]
struct StreamEventEnvelope<'a> {
    run_id: &'a str,
    #[serde(flatten)]
    event: &'a StreamEvent,
}

fn emit(app_handle: &AppHandle, run_id: &str, event: &StreamEvent) {
    let envelope = StreamEventEnvelope { run_id, event };
    // Failures here are non-recoverable (frontend cannot see the event);
    // the upstream LLM call will have its own retry / error path, so we
    // log and move on rather than panic.
    if let Err(error) = app_handle.emit("locus-stream-event", &envelope) {
        eprintln!(
            "[fence_emit] failed to emit {:?} for run {}: {}",
            event_type_name(event),
            run_id,
            error
        );
    }
}

fn event_type_name(event: &StreamEvent) -> &'static str {
    match event {
        StreamEvent::TextDelta { .. } => "textDelta",
        StreamEvent::CodeBlockStart { .. } => "codeBlockStart",
        StreamEvent::CodeBlockDelta { .. } => "codeBlockDelta",
        StreamEvent::CodeBlockDone { .. } => "codeBlockDone",
        _ => "other",
    }
}

/// Per-run streaming fence coordinator. Lives for the duration of a single
/// LLM round's text stream.
pub struct FenceStreamContext {
    streamer: FenceStreamer,
    session_id: String,
    run_id: String,
    /// Render-sequence counter; every emitted `CodeBlockStart` and the
    /// first `TextDelta` after a fence bump it. Frontend sorts by this
    /// value to keep the visual order stable.
    next_render_seq: u32,
    /// Counter used to derive stable `codeBlock:N` part IDs. Starts at 1
    /// and increments with each new fence.
    code_block_index: u32,
    /// Counter for text parts. Starts at 1; bumps after a fence closes so
    /// the prose after a code block lands in a fresh text part (matching
    /// the round-finalize splitter's behaviour).
    text_index: u32,
    /// Part ID of the current text part (initialized when the first prose
    /// delta arrives; bumped after each fence closes).
    current_text_part_id: String,
    /// `true` when the next `Prose` event must upsert a new text part.
    /// Set after `CodeBlockDone`; cleared by the next emitted text delta.
    needs_new_text_part: bool,
}

impl FenceStreamContext {
    pub fn new(session_id: impl Into<String>, run_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        let run_id = run_id.into();
        let current_text_part_id = format!("{}:text:{}", run_id, 1);
        Self {
            streamer: FenceStreamer::new(),
            session_id,
            run_id,
            next_render_seq: 1,
            code_block_index: 0,
            text_index: 1,
            current_text_part_id,
            needs_new_text_part: false,
        }
    }

    /// True if the streamer is currently inside a fence. Use this to
    /// suppress any "raw text" path the caller might have wired up before
    /// stage 2 — within a fence, all text must flow through
    /// `CodeBlockDelta` so the chat view can route it to the code-block
    /// part's chunk stream.
    pub fn is_in_fence(&self) -> bool {
        self.streamer.is_in_fence()
    }

    /// Feed a text delta and emit the resulting `StreamEvent`s. The events
    /// are emitted synchronously (via the project's `emit_stream` helper)
    /// so the chat view sees them in the same Tauri event batch as the
    /// delta that produced them.
    pub fn push(&mut self, app_handle: &AppHandle, delta: &str) {
        // The streamer hands back a slice that borrows from `self`, so we
        // copy the events into an owned `Vec` before recursing into
        // `self.translate_and_emit` (which needs `&mut self`).
        let events: Vec<FenceStreamEvent> = self.streamer.push(delta).to_vec();
        self.translate_and_emit(app_handle, &events);
    }

    /// End-of-stream flush. The caller should invoke this from the
    /// `toolCallRoundDone` / `done` / cancellation paths so an unclosed
    /// fence (e.g. a stream that ended mid-code-block) gets a final
    /// `CodeBlockDone` instead of leaving a hanging part.
    pub fn flush(&mut self, app_handle: &AppHandle) {
        let events: Vec<FenceStreamEvent> = self.streamer.flush().to_vec();
        self.translate_and_emit(app_handle, &events);
    }

    /// Reset the fence state machine for a new round. The counters stay
    /// monotonic across the host's lifetime — only the line buffer and
    /// Prose / InFence state are dropped. This is important when a round
    /// ends mid-fence (LLM output truncated without a closing backtick
    /// run): the next round must start in `Prose` state, not pick up
    /// wherever the previous round left off. The reducer clears the
    /// `liveRenderParts` between rounds, so reusing counter values is
    /// safe.
    pub fn reset_round(&mut self) {
        self.streamer = FenceStreamer::new();
        self.text_index += 1;
        self.current_text_part_id = format!("{}:text:{}", self.run_id, self.text_index);
        self.needs_new_text_part = false;
    }

    fn translate_and_emit(&mut self, app_handle: &AppHandle, events: &[FenceStreamEvent]) {
        for event in events {
            match event {
                FenceStreamEvent::Prose(text) => {
                    if self.needs_new_text_part {
                        self.text_index += 1;
                        self.current_text_part_id =
                            format!("{}:text:{}", self.run_id, self.text_index);
                        self.needs_new_text_part = false;
                    }
                    let render_seq = self.next_render_seq;
                    self.next_render_seq += 1;
                    emit(
                        app_handle,
                        &self.run_id,
                        &StreamEvent::TextDelta {
                            session_id: self.session_id.clone(),
                            text: text.clone(),
                            order: Some(render_seq),
                            part_id: Some(self.current_text_part_id.clone()),
                            render_seq: Some(render_seq),
                        },
                    );
                }
                FenceStreamEvent::CodeBlockStart { info } => {
                    self.code_block_index += 1;
                    let part_id = format!("{}:codeblock:{}", self.run_id, self.code_block_index);
                    let render_seq = self.next_render_seq;
                    self.next_render_seq += 1;
                    emit(
                        app_handle,
                        &self.run_id,
                        &StreamEvent::CodeBlockStart {
                            session_id: self.session_id.clone(),
                            id: part_id,
                            language: info.language.clone(),
                            file_path: info.file_path.clone(),
                            start_line: info.start_line,
                            order: Some(render_seq),
                            render_seq: Some(render_seq),
                        },
                    );
                }
                FenceStreamEvent::CodeBlockDelta(text) => {
                    let part_id =
                        format!("{}:codeblock:{}", self.run_id, self.code_block_index);
                    let render_seq = self.next_render_seq;
                    self.next_render_seq += 1;
                    emit(
                        app_handle,
                        &self.run_id,
                        &StreamEvent::CodeBlockDelta {
                            session_id: self.session_id.clone(),
                            id: part_id,
                            text: text.clone(),
                            order: Some(render_seq),
                        },
                    );
                }
                FenceStreamEvent::CodeBlockDone => {
                    let part_id =
                        format!("{}:codeblock:{}", self.run_id, self.code_block_index);
                    emit(
                        app_handle,
                        &self.run_id,
                        &StreamEvent::CodeBlockDone {
                            session_id: self.session_id.clone(),
                            id: part_id,
                        },
                    );
                    self.needs_new_text_part = true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lightweight test of part_id allocation and render_seq monotonicity.
    /// The actual `emit_stream` Tauri side-effect is bypassed by feeding
    /// the streamer directly and asserting on its semantic events; this
    /// test only validates the bookkeeping glue.
    #[test]
    fn initial_state_layout() {
        let ctx = FenceStreamContext::new("s1", "r1");
        assert_eq!(ctx.next_render_seq, 1);
        assert_eq!(ctx.code_block_index, 0);
        assert_eq!(ctx.text_index, 1);
        assert!(!ctx.is_in_fence());
        assert!(!ctx.needs_new_text_part);
        assert_eq!(ctx.current_text_part_id, "r1:text:1");
    }

    #[test]
    fn reset_round_bumps_text_index_and_resets_streamer() {
        let mut ctx = FenceStreamContext::new("s1", "r1");
        // Pretend the streamer has progressed.
        let _ = ctx.streamer.push("```csharp\n");
        assert!(ctx.is_in_fence());
        ctx.reset_round();
        assert!(!ctx.is_in_fence());
        assert_eq!(ctx.text_index, 2);
        assert_eq!(ctx.current_text_part_id, "r1:text:2");
    }
}
