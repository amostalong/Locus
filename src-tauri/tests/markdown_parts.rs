//! Integration test for the markdown fence splitter.
//!
//! Lives in `tests/` (rather than `#[cfg(test)] mod tests` inside the
//! module) because the main test binary links the entire `locus` library
//! and pulls in the `ort` / onnxruntime native dependencies, which are
//! not available in CI. A standalone integration test compiles a smaller
//! binary that only depends on `locus::markdown::parts`.

use locus_lib::markdown::parts::{
    parse_fence_info, split_markdown_parts, FenceInfo, MarkdownPart,
};

#[test]
fn empty_source_yields_no_parts() {
    assert!(split_markdown_parts("").is_empty());
}

#[test]
fn plain_text_without_fence() {
    let parts = split_markdown_parts("hello world");
    assert_eq!(
        parts,
        vec![MarkdownPart::Text {
            content: "hello world".into()
        }]
    );
}

#[test]
fn single_fence_with_language() {
    let source = "intro\n```csharp\nFoo\nBar\n```\nafter";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 3);
    assert_eq!(
        parts[0],
        MarkdownPart::Text {
            content: "intro".into()
        }
    );
    assert_eq!(
        parts[1],
        MarkdownPart::CodeBlock {
            info: FenceInfo {
                language: "csharp".into(),
                file_path: None,
                start_line: None,
            },
            content: "Foo\nBar".into(),
        }
    );
    assert_eq!(
        parts[2],
        MarkdownPart::Text {
            content: "after".into()
        }
    );
}

#[test]
fn fence_with_path_and_startline() {
    let source = "```csharp{path=Assets/Player.cs startLine=50}\nFoo\n```";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 1);
    assert_eq!(
        parts[0],
        MarkdownPart::CodeBlock {
            info: FenceInfo {
                language: "csharp".into(),
                file_path: Some("Assets/Player.cs".into()),
                start_line: Some(50),
            },
            content: "Foo".into(),
        }
    );
}

#[test]
fn fence_with_only_path() {
    let source = "```typescript{path=foo.ts}\nbar\n```";
    let parts = split_markdown_parts(source);
    assert_eq!(
        parts[0],
        MarkdownPart::CodeBlock {
            info: FenceInfo {
                language: "typescript".into(),
                file_path: Some("foo.ts".into()),
                start_line: None,
            },
            content: "bar".into(),
        }
    );
}

#[test]
fn fence_with_no_language() {
    let source = "```\nplain\n```";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 1);
    assert_eq!(
        parts[0],
        MarkdownPart::CodeBlock {
            info: FenceInfo {
                language: "".into(),
                file_path: None,
                start_line: None,
            },
            content: "plain".into(),
        }
    );
}

#[test]
fn nested_fence_uses_longer_outer_marker() {
    let source = "text\n````\n```csharp\nFoo\n```\n````\nmore";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 3);
    assert_eq!(
        parts[0],
        MarkdownPart::Text {
            content: "text".into()
        }
    );
    assert_eq!(
        parts[1],
        MarkdownPart::CodeBlock {
            info: FenceInfo {
                language: "".into(),
                file_path: None,
                start_line: None,
            },
            content: "```csharp\nFoo\n```".into(),
        }
    );
    assert_eq!(
        parts[2],
        MarkdownPart::Text {
            content: "more".into()
        }
    );
}

#[test]
fn tilde_fence_is_recognized() {
    let source = "~~~python\nprint(1)\n~~~";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 1);
    assert_eq!(
        parts[0],
        MarkdownPart::CodeBlock {
            info: FenceInfo {
                language: "python".into(),
                file_path: None,
                start_line: None,
            },
            content: "print(1)".into(),
        }
    );
}

#[test]
fn backtick_fence_not_closed_by_tilde() {
    let source = "```csharp\nFoo\n~~~";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 1);
    let MarkdownPart::Text { content } = &parts[0] else {
        panic!("expected text fallback, got {:?}", parts[0]);
    };
    assert!(content.contains("```csharp"));
    assert!(content.contains("Foo"));
    assert!(content.contains("~~~"));
}

#[test]
fn unclosed_fence_falls_back_to_text() {
    // The `intro` part is a finished text segment; the unclosed fence is
    // emitted as a separate text part with the original opening fence
    // marker preserved so a downstream re-render or LLM retry still sees
    // the same shape.
    let source = "intro\n```csharp\nFoo\nBar";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 2);
    assert_eq!(
        parts[0],
        MarkdownPart::Text {
            content: "intro".into()
        }
    );
    let MarkdownPart::Text { content } = &parts[1] else {
        panic!("expected text fallback, got {:?}", parts[1]);
    };
    assert!(content.contains("```csharp"));
    assert!(content.contains("Foo"));
    assert!(content.contains("Bar"));
}

#[test]
fn multiple_fences_in_sequence() {
    let source = "```a\n1\n```\nmid\n```b\n2\n```\nend";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 4);
    match &parts[0] {
        MarkdownPart::CodeBlock { content, info } => {
            assert_eq!(content, "1");
            assert_eq!(info.language, "a");
        }
        other => panic!("expected code block, got {:?}", other),
    }
    assert_eq!(
        parts[1],
        MarkdownPart::Text {
            content: "mid".into()
        }
    );
    match &parts[2] {
        MarkdownPart::CodeBlock { content, info } => {
            assert_eq!(content, "2");
            assert_eq!(info.language, "b");
        }
        other => panic!("expected code block, got {:?}", other),
    }
    assert_eq!(
        parts[3],
        MarkdownPart::Text {
            content: "end".into()
        }
    );
}

#[test]
fn parse_fence_info_empty() {
    let info = parse_fence_info("");
    assert_eq!(info.language, "");
    assert!(info.file_path.is_none());
    assert!(info.start_line.is_none());
}

#[test]
fn parse_fence_info_language_only() {
    let info = parse_fence_info("csharp");
    assert_eq!(info.language, "csharp");
    assert!(info.file_path.is_none());
    assert!(info.start_line.is_none());
}

#[test]
fn parse_fence_info_path_only() {
    let info = parse_fence_info("csharp{path=foo.cs}");
    assert_eq!(info.language, "csharp");
    assert_eq!(info.file_path.as_deref(), Some("foo.cs"));
    assert!(info.start_line.is_none());
}

#[test]
fn parse_fence_info_path_and_startline() {
    let info = parse_fence_info("csharp{path=x startLine=42}");
    assert_eq!(info.language, "csharp");
    assert_eq!(info.file_path.as_deref(), Some("x"));
    assert_eq!(info.start_line, Some(42));
}

#[test]
fn parse_fence_info_unknown_keys_ignored() {
    let info = parse_fence_info("csharp{unknown=ignored other=2 path=keep.cs}");
    assert_eq!(info.language, "csharp");
    assert_eq!(info.file_path.as_deref(), Some("keep.cs"));
    assert!(info.start_line.is_none());
}

#[test]
fn parse_fence_info_invalid_startline_becomes_none() {
    let info = parse_fence_info("csharp{startLine=notanumber}");
    assert!(info.start_line.is_none());
}

#[test]
fn parse_fence_info_unclosed_brace_does_not_panic() {
    let info = parse_fence_info("csharp{path=foo.cs");
    assert_eq!(info.language, "csharp");
    assert_eq!(info.file_path.as_deref(), Some("foo.cs"));
}

#[test]
fn fence_info_has_metadata_predicate() {
    assert!(!FenceInfo {
        language: "x".into(),
        file_path: None,
        start_line: None,
    }
    .has_metadata());
    assert!(FenceInfo {
        language: "x".into(),
        file_path: Some("y".into()),
        start_line: None,
    }
    .has_metadata());
    assert!(FenceInfo {
        language: "x".into(),
        file_path: None,
        start_line: Some(1),
    }
    .has_metadata());
}

#[test]
fn leading_blank_lines_kept_in_text() {
    let source = "\n\nhello\n```\ncode\n```";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 2);
    assert_eq!(
        parts[0],
        MarkdownPart::Text {
            content: "\n\nhello".into()
        }
    );
}

#[test]
fn fence_at_start_of_source() {
    let source = "```\nx\n```\ntail";
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 2);
    match &parts[0] {
        MarkdownPart::CodeBlock { content, .. } => assert_eq!(content, "x"),
        other => panic!("expected code block, got {:?}", other),
    }
    assert_eq!(
        parts[1],
        MarkdownPart::Text {
            content: "tail".into()
        }
    );
}

#[test]
fn real_world_mixed_markdown() {
    let source = r#"Here's the fix:

```csharp{path=Assets/Scripts/Player.cs startLine=50}
void Update() {
    transform.Translate(Vector3.up * speed * Time.deltaTime);
}
```

And the helper:

```typescript{path=src/utils.ts}
export const noop = () => {};
```

Plain text after.
"#;
    let parts = split_markdown_parts(source);
    assert_eq!(parts.len(), 5);
    assert!(matches!(&parts[0], MarkdownPart::Text { content } if content.starts_with("Here's the fix")));
    match &parts[1] {
        MarkdownPart::CodeBlock {
            content,
            info,
        } => {
            assert_eq!(content, "void Update() {\n    transform.Translate(Vector3.up * speed * Time.deltaTime);\n}");
            assert_eq!(info.language, "csharp");
            assert_eq!(info.file_path.as_deref(), Some("Assets/Scripts/Player.cs"));
            assert_eq!(info.start_line, Some(50));
        }
        other => panic!("expected code block, got {:?}", other),
    }
    assert!(matches!(&parts[2], MarkdownPart::Text { content } if content.contains("helper")));
    match &parts[3] {
        MarkdownPart::CodeBlock {
            content,
            info,
        } => {
            assert_eq!(content, "export const noop = () => {};");
            assert_eq!(info.language, "typescript");
            assert_eq!(info.file_path.as_deref(), Some("src/utils.ts"));
            assert!(info.start_line.is_none());
        }
        other => panic!("expected code block, got {:?}", other),
    }
    assert!(matches!(&parts[4], MarkdownPart::Text { content } if content.contains("Plain text after")));
}
