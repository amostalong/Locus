//! Integration test for `assistant_render_parts_for_response`, the
//! round-finalize helper that splits the LLM's markdown text into
//! `Text` and `CodeBlock` render parts.
//!
//! Lives in `tests/` rather than `#[cfg(test)] mod tests` inside
//! `agent/instance/mod.rs` because the main test binary links the entire
//! `locus` library and pulls in the `ort` / onnxruntime native
//! dependencies that aren't available in CI. A standalone integration
//! test compiles a smaller binary.

use locus_lib::agent::instance::assistant_render_parts_for_response;
use locus_lib::agent::instance::RenderPartMark;
use locus_lib::session::models::AssistantRenderPart;

fn make_text_mark(id: &str, seq: u32) -> RenderPartMark {
    RenderPartMark {
        id: id.to_string(),
        seq,
    }
}

#[test]
fn splits_text_with_code_block_metadata() {
    let text = "intro\n```csharp{path=Assets/Player.cs startLine=50}\nFoo\n```\ntail";
    let parts = assistant_render_parts_for_response(
        "run-1",
        Some(make_text_mark("run-1:text:base", 5)),
        text,
        None,
        "",
        None,
        None,
        &[],
    );

    assert_eq!(parts.len(), 3, "expected 3 split parts, got {:?}", parts);

    match &parts[0] {
        AssistantRenderPart::Text { content, order, .. } => {
            assert_eq!(content, "intro");
            assert_eq!(order.seq, 5);
        }
        other => panic!("expected text, got {:?}", other),
    }
    match &parts[1] {
        AssistantRenderPart::CodeBlock {
            content,
            language,
            file_path,
            start_line,
            order,
            ..
        } => {
            assert_eq!(content, "Foo");
            assert_eq!(language, "csharp");
            assert_eq!(file_path.as_deref(), Some("Assets/Player.cs"));
            assert_eq!(*start_line, Some(50));
            assert_eq!(order.seq, 6);
        }
        other => panic!("expected codeBlock, got {:?}", other),
    }
    match &parts[2] {
        AssistantRenderPart::Text { content, order, .. } => {
            assert_eq!(content, "tail");
            assert_eq!(order.seq, 7);
        }
        other => panic!("expected text, got {:?}", other),
    }
}

#[test]
fn passthrough_when_no_fence() {
    let parts = assistant_render_parts_for_response(
        "run-1",
        Some(make_text_mark("run-1:text:base", 5)),
        "just plain text",
        None,
        "",
        None,
        None,
        &[],
    );

    assert_eq!(parts.len(), 1);
    match &parts[0] {
        AssistantRenderPart::Text { content, order, id } => {
            assert_eq!(content, "just plain text");
            assert_eq!(order.seq, 5);
            assert_eq!(id, "run-1:text:5");
        }
        other => panic!("expected text, got {:?}", other),
    }
}

#[test]
fn unclosed_fence_renders_as_text_fallback() {
    let parts = assistant_render_parts_for_response(
        "run-1",
        Some(make_text_mark("run-1:text:base", 5)),
        "intro\n```csharp\nunfinished",
        None,
        "",
        None,
        None,
        &[],
    );

    assert_eq!(parts.len(), 2);
    assert!(matches!(
        &parts[0],
        AssistantRenderPart::Text { content, .. } if content == "intro"
    ));
    assert!(matches!(
        &parts[1],
        AssistantRenderPart::Text { content, .. } if content.contains("```csharp")
    ));
}

#[test]
fn empty_text_emits_no_text_part() {
    let parts = assistant_render_parts_for_response(
        "run-1",
        Some(make_text_mark("run-1:text:base", 5)),
        "",
        None,
        "",
        None,
        None,
        &[],
    );

    assert!(parts.is_empty(), "empty text must not produce a part");
}

#[test]
fn code_block_part_id_is_stable_for_phase_two_streaming() {
    // Phase 2 will route streaming events through the same id format so
    // the live and history parts can be reconciled. Lock the format here.
    let text = "```typescript{path=foo.ts}\nbar\n```";
    let parts = assistant_render_parts_for_response(
        "run-1",
        Some(make_text_mark("run-1:text:base", 5)),
        text,
        None,
        "",
        None,
        None,
        &[],
    );

    assert_eq!(parts.len(), 1);
    match &parts[0] {
        AssistantRenderPart::CodeBlock { id, order, .. } => {
            assert_eq!(id, "run-1:codeblock:5");
            assert_eq!(order.seq, 5);
        }
        other => panic!("expected codeBlock, got {:?}", other),
    }
}
