//! Integration test for the streaming fence state machine.
//!
//! Mirrors the structure of `markdown_parts.rs`: a standalone binary
//! that only links the `markdown::fence_stream` and
//! `markdown::parts` modules so the test runner does not pull in
//! `ort` / onnxruntime native dependencies. See the comment in
//! `markdown_parts.rs` for the full rationale.

use locus_lib::markdown::fence_stream::{FenceStreamEvent, FenceStreamer};
use locus_lib::markdown::parts::{split_markdown_parts, FenceInfo, MarkdownPart};

/// Helper: drive a fresh streamer with the given chunks and return
/// the flattened list of events. Mirrors what a real LLM streaming
/// client sees — the LLM hands the host a string, the host splits it
/// into per-token chunks, each chunk goes through the streamer.
fn drive(chunks: &[&str]) -> Vec<FenceStreamEvent> {
    let mut s = FenceStreamer::new();
    let mut events = Vec::new();
    for chunk in chunks {
        events.extend_from_slice(s.push(chunk));
    }
    events.extend_from_slice(s.flush());
    events
}

fn info(language: &str, path: Option<&str>, start_line: Option<u32>) -> FenceInfo {
    FenceInfo {
        language: language.to_string(),
        file_path: path.map(str::to_string),
        start_line,
    }
}

#[test]
fn empty_stream_yields_no_events() {
    let mut s = FenceStreamer::new();
    assert!(s.push("").is_empty());
    assert!(s.flush().is_empty());
}

#[test]
fn prose_only_round_trip() {
    let events = drive(&["Hello, world!\n"]);
    assert_eq!(events, vec![FenceStreamEvent::Prose("Hello, world!\n".into())]);
}

#[test]
fn fence_round_trip_aligned_token_boundaries() {
    // Tokens line up with line boundaries — the easy case.
    let events = drive(&[
        "```csharp\n",
        "int x = 1;\n",
        "int y = 2;\n",
        "```\n",
    ]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("csharp", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("int x = 1;\n".into()),
            FenceStreamEvent::CodeBlockDelta("int y = 2;\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn fence_marker_split_across_tokens() {
    // The triple-backtick run and the language are in different tokens;
    // the line buffer must hold the partial marker until a newline.
    let events = drive(&["``", "`csharp\n", "int x;\n", "```\n"]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("csharp", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("int x;\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn fence_with_metadata_across_tokens() {
    // The metadata block has spaces and an `=` — make sure tokenization
    // doesn't truncate the info string at whitespace.
    let events = drive(&[
        "```csharp{path=",
        "Assets/Player.cs startLine=50}\n",
        "// body\n",
        "```\n",
    ]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("csharp", Some("Assets/Player.cs"), Some(50)),
            },
            FenceStreamEvent::CodeBlockDelta("// body\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn four_backtick_fence_wraps_triple_backtick_body() {
    // CommonMark rule: a 4-backtick fence wraps a 3-backtick content
    // block. The inner triple backticks must not close the outer fence.
    let events = drive(&[
        "````\n",
        "```csharp\n",
        "// not a close\n",
        "```\n",
        "still inside\n",
        "````\n",
    ]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("```csharp\n".into()),
            FenceStreamEvent::CodeBlockDelta("// not a close\n".into()),
            FenceStreamEvent::CodeBlockDelta("```\n".into()),
            FenceStreamEvent::CodeBlockDelta("still inside\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn cross_marker_fences_do_not_close_each_other() {
    // A tilde fence must not close a backtick fence and vice versa.
    let events = drive(&["```csharp\n", "~~~\n", "still inside\n", "```\n"]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("csharp", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("~~~\n".into()),
            FenceStreamEvent::CodeBlockDelta("still inside\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn inline_backticks_in_prose_do_not_open_fences() {
    let events = drive(&["use `npm` here\n", "and ``foo`` too\n"]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::Prose("use `npm` here\n".into()),
            FenceStreamEvent::Prose("and ``foo`` too\n".into()),
        ]
    );
}

#[test]
fn unclosed_fence_at_flush_emits_done() {
    // The LLM truncated the source mid-fence. The streamer must still
    // surface a final CodeBlockDone so the chat view doesn't leave a
    // hanging code-block part.
    let events = drive(&["```csharp\n", "int x;\n"]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("csharp", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("int x;\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn unclosed_fence_with_partial_line_at_flush() {
    let events = drive(&["```csharp\n", "int x = 1;"]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("csharp", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("int x = 1;\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn prose_around_fence_emits_in_visual_order() {
    let events = drive(&[
        "intro line\n",
        "```csharp\n",
        "int x;\n",
        "```\n",
        "trailer line\n",
    ]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::Prose("intro line\n".into()),
            FenceStreamEvent::CodeBlockStart {
                info: info("csharp", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("int x;\n".into()),
            FenceStreamEvent::CodeBlockDone,
            FenceStreamEvent::Prose("trailer line\n".into()),
        ]
    );
}

#[test]
fn multiple_fences_in_a_row() {
    let events = drive(&[
        "```\n",
        "a\n",
        "```\n",
        "```\n",
        "b\n",
        "```\n",
    ]);
    assert_eq!(events.len(), 6);
    assert!(matches!(events[0], FenceStreamEvent::CodeBlockStart { .. }));
    assert!(matches!(events[1], FenceStreamEvent::CodeBlockDelta(_)));
    assert!(matches!(events[2], FenceStreamEvent::CodeBlockDone));
    assert!(matches!(events[3], FenceStreamEvent::CodeBlockStart { .. }));
    assert!(matches!(events[4], FenceStreamEvent::CodeBlockDelta(_)));
    assert!(matches!(events[5], FenceStreamEvent::CodeBlockDone));
}

#[test]
fn streaming_split_matches_round_finalize_split() {
    // Stage-2 invariant: the stream of `FenceStreamEvent` values must
    // agree with `split_markdown_parts` on the count and the content
    // of code-block parts. The exact part-boundary positions can
    // differ (one stream delta per line vs one part per fence) but
    // what is INSIDE each code-block part must match.
    let sources = [
        "intro\n```csharp\nint x;\n```\ntrailer\n",
        "```\nplain\n```\n",
        "alpha\nbeta\ngamma\n",
        "```rust\nfn main() {}\n```\n\nafter a blank line\n",
        "noise with `inline` ticks\n",
    ];

    for source in sources {
        // The round-finalize split: gives us one MarkdownPart per
        // fence / prose region.
        let final_parts = split_markdown_parts(source);
        let final_code_block_count = final_parts
            .iter()
            .filter(|p| matches!(p, MarkdownPart::CodeBlock { .. }))
            .count();

        // The streaming split: emits per-line deltas.
        let streamed = drive(&[source]);
        let streamed_code_block_count = streamed
            .iter()
            .filter(|e| matches!(e, FenceStreamEvent::CodeBlockStart { .. }))
            .count();

        assert_eq!(
            streamed_code_block_count, final_code_block_count,
            "code-block count mismatch for: {:?}",
            source
        );

        // Concatenating the streamed code-block deltas must equal the
        // concatenated code-block contents from the round-finalize
        // split. The fence markers themselves are NOT in the streamed
        // events (they're metadata, not content) — only the code body.
        //
        // The streaming path emits one delta per source line (with the
        // trailing `\n` preserved). The round-finalize path strips the
        // trailing `\n` from the last line (see
        // `split_markdown_parts`). Strip it here too so the comparison
        // is content-equality, not line-ending-equality — the
        // transcript's CodeBlockView reads `part.content` directly,
        // and the trailing `\n` would only render as a stray empty
        // line at the end of the block.
        let streamed_code_body: String = streamed
            .iter()
            .filter_map(|e| match e {
                FenceStreamEvent::CodeBlockDelta(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let streamed_code_body = streamed_code_body
            .strip_suffix('\n')
            .unwrap_or(&streamed_code_body)
            .to_string();
        let final_code_body: String = final_parts
            .iter()
            .filter_map(|p| match p {
                MarkdownPart::CodeBlock { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            streamed_code_body, final_code_body,
            "code-block body mismatch for: {:?}",
            source
        );
    }
}

#[test]
fn fence_with_only_a_closing_marker_emits_empty_content() {
    // Edge case: an empty fence (Start immediately followed by Done).
    let events = drive(&["```\n", "```\n"]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("", None, None),
            },
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}

#[test]
fn whitespace_before_fence_is_ignored() {
    // Up to 3 spaces of indent is a valid fence per CommonMark.
    let events = drive(&["   ```rust\n", "let _ = 1;\n", "```\n"]);
    assert_eq!(
        events,
        vec![
            FenceStreamEvent::CodeBlockStart {
                info: info("rust", None, None),
            },
            FenceStreamEvent::CodeBlockDelta("let _ = 1;\n".into()),
            FenceStreamEvent::CodeBlockDone,
        ]
    );
}
