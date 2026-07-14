//! Streaming fence state machine — converts a per-token text stream into a
//! sequence of `FenceStreamEvent` values so the chat view can render fenced
//! code blocks in real time.
//!
//! The round-finalize splitter in [`super::parts`] operates on a complete
//! markdown string; this module handles the streaming counterpart, where
//! fence markers, info strings, and the closing rule must all be detected
//! across token boundaries. The state machine buffers the current
//! line and only commits a line once a newline arrives — fence detection
//! needs the line to be complete.
//!
//! The machine is intentionally line-based: prose deltas are emitted at line
//! boundaries, not per character. Per-line granularity is sufficient for the
//! chat view (code blocks render without a typewriter effect), and a smaller
//! event volume keeps the reducer from re-upserting parts on every token.
//!
//! Scope: emits semantic events. The caller is responsible for allocating
//! `part_id` / `render_seq` values and translating these into
//! `StreamEvent::TextDelta` / `StreamEvent::CodeBlock{Start,Delta,Done}`
//! events. Keeping the streamer free of those concerns makes it easy to
//! unit-test without touching the IPC layer.

use super::parts::{fence_marker, parse_fence_info, FenceInfo};

/// Semantic event emitted by the fence streamer. The caller translates
/// these into wire events with stable `part_id` / `render_seq` values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceStreamEvent {
    /// Prose text — append to the current text part. The text already
    /// includes the trailing newline that terminated the line.
    Prose(String),
    /// Entering a fenced code block. The caller should allocate a fresh
    /// codeBlock part and emit a `CodeBlockStart` event.
    CodeBlockStart { info: FenceInfo },
    /// Code block content delta (one line, including the trailing newline).
    /// Append to the current codeBlock part via a `CodeBlockDelta` event.
    CodeBlockDelta(String),
    /// Closing fence seen. Emit a `CodeBlockDone` event for the part.
    CodeBlockDone,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum FenceState {
    #[default]
    Prose,
    InFence {
        info: FenceInfo,
        run_len: usize,
        marker: char,
    },
}

/// Per-run streaming fence detector. One instance lives for the duration of
/// an LLM round's text stream (from the first delta to the closing
/// `toolCallRoundDone` / `done`).
#[derive(Debug, Default)]
pub struct FenceStreamer {
    state: FenceState,
    line_buffer: String,
    pending: Vec<FenceStreamEvent>,
}

impl FenceStreamer {
    pub fn new() -> Self {
        Self::default()
    }

    /// True if the streamer is currently inside a fence. Useful for
    /// diagnostics and for callers that want to suppress raw `TextDelta`
    /// emission while inside a fence (this streamer already handles that
    /// — only emit `CodeBlockDelta` when inside).
    pub fn is_in_fence(&self) -> bool {
        matches!(self.state, FenceState::InFence { .. })
    }

    /// Feed a chunk of text (one or more chars; typically a single token or
    /// a coalesced batch). Returns the semantic events produced by this
    /// chunk. The returned slice is reused across calls — clone what you
    /// need before the next `push` / `flush`.
    pub fn push(&mut self, text: &str) -> &[FenceStreamEvent] {
        self.pending.clear();
        for ch in text.chars() {
            if ch == '\n' {
                self.process_complete_line();
            } else {
                self.line_buffer.push(ch);
            }
        }
        &self.pending
    }

    /// End-of-stream flush. Treats any trailing partial line as a complete
    /// line. If the stream ends mid-fence, emits a final `CodeBlockDone` so
    /// the chat view does not leave a hanging code-block part.
    pub fn flush(&mut self) -> &[FenceStreamEvent] {
        self.pending.clear();
        if !self.line_buffer.is_empty() {
            self.process_complete_line();
            self.line_buffer.clear();
        }
        if matches!(self.state, FenceState::InFence { .. }) {
            self.pending.push(FenceStreamEvent::CodeBlockDone);
            self.state = FenceState::Prose;
        }
        &self.pending
    }

    fn process_complete_line(&mut self) {
        let line = std::mem::take(&mut self.line_buffer);
        // Snapshot the state so we can move out of it without fighting the
        // borrow checker.
        match self.state.clone() {
            FenceState::Prose => {
                let trimmed_start = line.trim_start();
                let (run, marker) = fence_marker(trimmed_start);
                if let (Some(marker), true) = (marker, run >= 3) {
                    let info_str = trimmed_start[run..].trim_end();
                    let info = parse_fence_info(info_str);
                    self.state = FenceState::InFence {
                        info: info.clone(),
                        run_len: run,
                        marker,
                    };
                    self.pending.push(FenceStreamEvent::CodeBlockStart { info });
                } else {
                    self.pending
                        .push(FenceStreamEvent::Prose(format!("{}\n", line)));
                }
            }
            FenceState::InFence {
                run_len, marker, ..
            } => {
                let trimmed_start = line.trim_start();
                let (close_run, close_marker) = fence_marker(trimmed_start);
                if close_run >= run_len && close_marker == Some(marker) {
                    self.pending.push(FenceStreamEvent::CodeBlockDone);
                    self.state = FenceState::Prose;
                } else {
                    self.pending
                        .push(FenceStreamEvent::CodeBlockDelta(format!("{}\n", line)));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(streamer: &mut FenceStreamer, text: &str) -> Vec<FenceStreamEvent> {
        streamer.push(text).to_vec()
    }

    #[test]
    fn pure_prose_passes_through_line_by_line() {
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "hello world\n");
        assert_eq!(events, vec![FenceStreamEvent::Prose("hello world\n".into())]);
        assert!(!s.is_in_fence());
    }

    #[test]
    fn multi_line_prose_emits_one_event_per_line() {
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "alpha\nbravo\ncharlie\n");
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::Prose("alpha\n".into()),
                FenceStreamEvent::Prose("bravo\n".into()),
                FenceStreamEvent::Prose("charlie\n".into()),
            ]
        );
    }

    #[test]
    fn bare_triple_backtick_opens_fence() {
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "```\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::CodeBlockStart {
                info: FenceInfo {
                    language: String::new(),
                    file_path: None,
                    start_line: None,
                }
            }]
        );
        assert!(s.is_in_fence());
    }

    #[test]
    fn fence_with_language() {
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "```csharp\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::CodeBlockStart {
                info: FenceInfo {
                    language: "csharp".into(),
                    file_path: None,
                    start_line: None,
                }
            }]
        );
    }

    #[test]
    fn fence_with_metadata() {
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "```csharp{path=Assets/Player.cs startLine=50}\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::CodeBlockStart {
                info: FenceInfo {
                    language: "csharp".into(),
                    file_path: Some("Assets/Player.cs".into()),
                    start_line: Some(50),
                }
            }]
        );
    }

    #[test]
    fn fence_round_trip_emits_deltas_and_done() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("```csharp\n"));
        events.extend_from_slice(s.push("int x = 1;\n"));
        events.extend_from_slice(s.push("int y = 2;\n"));
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.flush());
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo {
                        language: "csharp".into(),
                        file_path: None,
                        start_line: None,
                    }
                },
                FenceStreamEvent::CodeBlockDelta("int x = 1;\n".into()),
                FenceStreamEvent::CodeBlockDelta("int y = 2;\n".into()),
                FenceStreamEvent::CodeBlockDone,
            ]
        );
        assert!(!s.is_in_fence());
    }

    #[test]
    fn fence_close_must_match_opener_marker() {
        let mut s = FenceStreamer::new();
        let _events = collect(&mut s, "```csharp\n");
        assert!(s.is_in_fence());
        // A tilde-fence should not close a backtick-fence.
        let events = collect(&mut s, "~~~\n");
        assert_eq!(events, vec![FenceStreamEvent::CodeBlockDelta("~~~\n".into())]);
        assert!(s.is_in_fence());
        // Backtick fence closes it.
        let events = collect(&mut s, "```\n");
        assert_eq!(events, vec![FenceStreamEvent::CodeBlockDone]);
        assert!(!s.is_in_fence());
    }

    #[test]
    fn four_backtick_fence_wraps_triple_backtick_content() {
        // CommonMark rule: a closing fence must have the same marker and a run
        // length >= the opener's. So ```` closes ```` but not ```.
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("````\n"));
        events.extend_from_slice(s.push("```csharp\n"));
        events.extend_from_slice(s.push("// nested triple backticks inside\n"));
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.push("still inside the 4-backtick fence\n"));
        events.extend_from_slice(s.push("````\n"));
        events.extend_from_slice(s.flush());
        // The inner triple backticks are content (they would not close the
        // 4-backtick opener). The outer 4-backtick run closes.
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo { language: String::new(), file_path: None, start_line: None }
                },
                FenceStreamEvent::CodeBlockDelta("```csharp\n".into()),
                FenceStreamEvent::CodeBlockDelta("// nested triple backticks inside\n".into()),
                FenceStreamEvent::CodeBlockDelta("```\n".into()),
                FenceStreamEvent::CodeBlockDelta("still inside the 4-backtick fence\n".into()),
                FenceStreamEvent::CodeBlockDone,
            ]
        );
    }

    #[test]
    fn fence_marker_split_across_tokens() {
        // A backtick pair arrives in one token and the third + info + newline
        // in the next. The line is not yet complete (no \n) so no event fires
        // until the closing \n.
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "``");
        assert!(events.is_empty(), "no line boundary yet, no event");
        let events = collect(&mut s, "`csharp\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::CodeBlockStart {
                info: FenceInfo {
                    language: "csharp".into(),
                    file_path: None,
                    start_line: None,
                }
            }]
        );
    }

    #[test]
    fn fence_marker_split_with_info_string_split() {
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "```csh");
        assert!(events.is_empty());
        let events = collect(&mut s, "arp\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::CodeBlockStart {
                info: FenceInfo {
                    language: "csharp".into(),
                    file_path: None,
                    start_line: None,
                }
            }]
        );
    }

    #[test]
    fn inline_backticks_in_prose_do_not_open_fence() {
        // A single backtick or pair of backticks in the middle of a line is
        // inline code, not a fence.
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "use `npm` to install\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::Prose("use `npm` to install\n".into())]
        );
        assert!(!s.is_in_fence());
        // A pair of backticks in the middle of a line is also not a fence.
        let events = collect(&mut s, "type ``foo`` here\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::Prose("type ``foo`` here\n".into())]
        );
        assert!(!s.is_in_fence());
    }

    #[test]
    fn tilde_fence_works() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("~~~python\n"));
        events.extend_from_slice(s.push("print('hi')\n"));
        events.extend_from_slice(s.push("~~~\n"));
        events.extend_from_slice(s.flush());
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo {
                        language: "python".into(),
                        file_path: None,
                        start_line: None,
                    }
                },
                FenceStreamEvent::CodeBlockDelta("print('hi')\n".into()),
                FenceStreamEvent::CodeBlockDone,
            ]
        );
    }

    #[test]
    fn whitespace_before_fence_is_ignored() {
        // Up to 3 spaces of indent is a valid fence per CommonMark.
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "   ```csharp\n");
        assert_eq!(
            events,
            vec![FenceStreamEvent::CodeBlockStart {
                info: FenceInfo {
                    language: "csharp".into(),
                    file_path: None,
                    start_line: None,
                }
            }]
        );
    }

    #[test]
    fn fence_close_with_leading_whitespace() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("```csharp\n"));
        events.extend_from_slice(s.push("body\n"));
        events.extend_from_slice(s.push("   ```\n"));
        events.extend_from_slice(s.flush());
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo {
                        language: "csharp".into(),
                        file_path: None,
                        start_line: None,
                    }
                },
                FenceStreamEvent::CodeBlockDelta("body\n".into()),
                FenceStreamEvent::CodeBlockDone,
            ]
        );
    }

    #[test]
    fn empty_fence_close_emits_done_without_delta() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.flush());
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo { language: String::new(), file_path: None, start_line: None }
                },
                FenceStreamEvent::CodeBlockDone,
            ]
        );
    }

    #[test]
    fn prose_around_fence() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("intro line\n"));
        events.extend_from_slice(s.push("```csharp\n"));
        events.extend_from_slice(s.push("// body\n"));
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.push("trailer line\n"));
        events.extend_from_slice(s.flush());
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::Prose("intro line\n".into()),
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo {
                        language: "csharp".into(),
                        file_path: None,
                        start_line: None,
                    }
                },
                FenceStreamEvent::CodeBlockDelta("// body\n".into()),
                FenceStreamEvent::CodeBlockDone,
                FenceStreamEvent::Prose("trailer line\n".into()),
            ]
        );
    }

    #[test]
    fn consecutive_fences_round_trip() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.push("a\n"));
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.push("b\n"));
        events.extend_from_slice(s.push("```\n"));
        events.extend_from_slice(s.flush());
        assert_eq!(events.len(), 6, "two start/delta/done triples");
        assert!(matches!(events[0], FenceStreamEvent::CodeBlockStart { .. }));
        assert!(matches!(events[3], FenceStreamEvent::CodeBlockStart { .. }));
    }

    #[test]
    fn unclosed_fence_at_flush_emits_done() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("```csharp\n"));
        events.extend_from_slice(s.push("int x;\n"));
        events.extend_from_slice(s.flush());
        // The trailing partial line is empty (no chars), so no delta for it;
        // the unclosed-fence fallback fires CodeBlockDone.
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo {
                        language: "csharp".into(),
                        file_path: None,
                        start_line: None,
                    }
                },
                FenceStreamEvent::CodeBlockDelta("int x;\n".into()),
                FenceStreamEvent::CodeBlockDone,
            ]
        );
    }

    #[test]
    fn unclosed_fence_with_partial_line_at_flush() {
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        events.extend_from_slice(s.push("```csharp\n"));
        events.extend_from_slice(s.push("int x = 1;"));
        events.extend_from_slice(s.flush());
        // The trailing partial line is processed as a content line, then the
        // unclosed-fence fallback fires Done.
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo {
                        language: "csharp".into(),
                        file_path: None,
                        start_line: None,
                    }
                },
                FenceStreamEvent::CodeBlockDelta("int x = 1;\n".into()),
                FenceStreamEvent::CodeBlockDone,
            ]
        );
    }

    #[test]
    fn empty_stream_emits_nothing() {
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "");
        assert!(events.is_empty());
        let events = s.flush().to_vec();
        assert!(events.is_empty());
    }

    #[test]
    fn push_then_flush_split_line() {
        // A line that has no trailing newline is held in the buffer until
        // flush. The flush processes it as a final line.
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "partial");
        assert!(events.is_empty());
        let events = s.flush().to_vec();
        assert_eq!(events, vec![FenceStreamEvent::Prose("partial\n".into())]);
    }

    #[test]
    fn per_token_emission_yields_one_event_per_line_boundary() {
        // Each LLM token happens to align with a line boundary. The streamer
        // emits exactly one event per line.
        let mut s = FenceStreamer::new();
        let mut events: Vec<FenceStreamEvent> = Vec::new();
        for token in ["a\n", "b\n", "```\n", "x\n", "```\n", "c\n"] {
            events.extend_from_slice(s.push(token));
        }
        events.extend_from_slice(s.flush());
        assert_eq!(
            events,
            vec![
                FenceStreamEvent::Prose("a\n".into()),
                FenceStreamEvent::Prose("b\n".into()),
                FenceStreamEvent::CodeBlockStart {
                    info: FenceInfo { language: String::new(), file_path: None, start_line: None }
                },
                FenceStreamEvent::CodeBlockDelta("x\n".into()),
                FenceStreamEvent::CodeBlockDone,
                FenceStreamEvent::Prose("c\n".into()),
            ]
        );
    }

    #[test]
    fn non_utf8_safe_char_boundary_is_respected() {
        // The streamer iterates by char so a multi-byte char that straddles
        // a chunk boundary would panic in a naive byte iteration. We don't
        // have a way to inject a partial char from a Rust &str, but the
        // design uses chars() to ensure it stays valid regardless of how
        // upstream chunks the input.
        let mut s = FenceStreamer::new();
        let events = collect(&mut s, "你好\n```rust\nlet _x = \"中文\";\n```\n");
        assert_eq!(events.len(), 5);
        assert!(matches!(events[1], FenceStreamEvent::CodeBlockStart { .. }));
        assert!(matches!(events[4], FenceStreamEvent::CodeBlockDone));
    }
}
