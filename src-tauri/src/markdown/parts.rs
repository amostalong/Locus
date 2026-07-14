//! Markdown fence splitter — extracts fenced code blocks into structured
//! `MarkdownPart` values so the round-finalize path can carry per-block
//! metadata (language, file path, source line number) into the assistant
//! render parts.
//!
//! Supports the `{path=... startLine=N}` metadata convention inside the
//! fence info string, e.g. ```` ```csharp{path=Assets/Player.cs startLine=50}
//! ```` parses to `file_path = Some("Assets/Player.cs")`,
//! `start_line = Some(50)`. The bracketed block is optional and may contain
//! any number of `key=value` pairs separated by whitespace; `path` and
//! `startLine` are recognized. Unknown keys are ignored.
//!
//! Scope: this is the **round-finalize** splitter. The streaming
//! counterpart lives elsewhere — it is a per-token state machine that
//! must cope with fences split across token boundaries and is intentionally
//! not handled here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FenceInfo {
    /// Language identifier (e.g. `"csharp"`, `"typescript"`). Empty string
    /// when the fence has no info string or no language segment.
    pub language: String,
    /// `path=...` from the info string's metadata block, if present.
    pub file_path: Option<String>,
    /// `startLine=...` from the info string's metadata block, if present.
    /// Stored as 1-based to match editor / file-system conventions.
    pub start_line: Option<u32>,
}

impl FenceInfo {
    pub fn has_metadata(&self) -> bool {
        self.file_path.is_some() || self.start_line.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MarkdownPart {
    /// Plain markdown fragment that should be rendered through the regular
    /// pipeline (text / lists / headings / inline code, etc.).
    Text {
        content: String,
    },
    /// Fenced code block extracted from the source, carrying any metadata
    /// parsed out of the opening info string.
    CodeBlock {
        info: FenceInfo,
        content: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParseState {
    Text,
    Fence { run_len: usize, marker: char },
}

/// Parse the fence info string of the form `lang{path=... startLine=50}`.
///
/// The bracketed metadata block is optional. When the closing `}` is
/// missing, the rest of the string is treated as the body (graceful
/// degradation; LLM output is not always well-formed).
pub fn parse_fence_info(info: &str) -> FenceInfo {
    let trimmed = info.trim();
    if trimmed.is_empty() {
        return FenceInfo {
            language: String::new(),
            file_path: None,
            start_line: None,
        };
    }
    let (lang, rest) = match trimmed.find('{') {
        Some(open) => (&trimmed[..open], Some(&trimmed[open + 1..])),
        None => (trimmed, None),
    };
    let mut file_path = None;
    let mut start_line = None;
    if let Some(rest) = rest {
        let close = rest.find('}');
        let body = match close {
            Some(c) => &rest[..c],
            None => rest,
        };
        for token in body.split_whitespace() {
            if let Some(value) = token.strip_prefix("path=") {
                file_path = Some(value.to_string());
            } else if let Some(value) = token.strip_prefix("startLine=") {
                start_line = value.parse().ok();
            }
        }
    }
    FenceInfo {
        language: lang.trim().to_string(),
        file_path,
        start_line,
    }
}

/// Split a markdown source into a sequence of `MarkdownPart`.
///
/// Fenced code blocks (```` ``` ```` or `~~~`) are extracted as
/// `CodeBlock` parts. The closing rule is "same marker (`\`` or `~`),
/// run length ≥ the opening run length" — this is the CommonMark rule and
/// lets a 4-backtick fence wrap a 3-backtick block. An unclosed fence at
/// end-of-input falls back to `Text` with the original opening fence
/// re-emitted, so a downstream re-render (or LLM retry) still sees the
/// same shape.
///
/// Indented code blocks (4-space / 1-tab) are **not** recognized as
/// fences; they remain inside the surrounding `Text` part. LLM output in
/// chat responses is overwhelmingly fence-based; indented code in markdown
/// is rare in this context.
pub fn split_markdown_parts(source: &str) -> Vec<MarkdownPart> {
    let mut parts: Vec<MarkdownPart> = Vec::new();
    let mut text = String::new();
    let mut state = ParseState::Text;
    let mut fence_info = FenceInfo {
        language: String::new(),
        file_path: None,
        start_line: None,
    };
    let mut fence_content = String::new();
    let mut fence_marker_char: char = '`';

    for line in source.split('\n') {
        let trimmed_start = line.trim_start();
        match state {
            ParseState::Text => {
                let (run, marker) = fence_marker(trimmed_start);
                if let (Some(marker), true) = (marker, run >= 3) {
                    // Opening fence — flush any accumulated text first.
                    let info = trimmed_start[run..].trim_end();
                    if text.ends_with('\n') {
                        text.pop();
                    }
                    if !text.is_empty() {
                        parts.push(MarkdownPart::Text {
                            content: std::mem::take(&mut text),
                        });
                    }
                    state = ParseState::Fence {
                        run_len: run,
                        marker,
                    };
                    fence_marker_char = marker;
                    fence_info = parse_fence_info(info);
                    fence_content.clear();
                } else {
                    text.push_str(line);
                    text.push('\n');
                }
            }
            ParseState::Fence { run_len, marker } => {
                let (close_run, close_marker) = fence_marker(trimmed_start);
                if close_run >= run_len && close_marker == Some(marker) {
                    // Closing fence — strip trailing newline so the
                    // accumulator matches the source layout exactly.
                    if fence_content.ends_with('\n') {
                        fence_content.pop();
                    }
                    parts.push(MarkdownPart::CodeBlock {
                        info: fence_info.clone(),
                        content: std::mem::take(&mut fence_content),
                    });
                    state = ParseState::Text;
                    fence_info = FenceInfo {
                        language: String::new(),
                        file_path: None,
                        start_line: None,
                    };
                    let _ = fence_marker_char;
                } else {
                    fence_content.push_str(line);
                    fence_content.push('\n');
                }
            }
        }
    }

    // Fallback: unclosed fence → emit content as text with the opening
    // fence reconstructed so re-render / retry sees the same shape.
    if matches!(state, ParseState::Fence { .. }) {
        let opening = reconstruct_fence(&fence_info);
        if text.ends_with('\n') {
            text.pop();
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&opening);
        text.push('\n');
        if fence_content.ends_with('\n') {
            fence_content.pop();
        }
        text.push_str(&fence_content);
    }

    if text.ends_with('\n') {
        text.pop();
    }
    if !text.is_empty() {
        parts.push(MarkdownPart::Text { content: text });
    }
    parts
}

/// Returns the run length of the fence marker (`\`` or `~`) and which
/// marker was used. Returns `(0, None)` if the line does not start with a
/// 3+ run of the same marker.
pub(super) fn fence_marker(line: &str) -> (usize, Option<char>) {
    let mut chars = line.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return (0, None),
    };
    if first != '`' && first != '~' {
        return (0, None);
    }
    let mut run = 1;
    for c in chars {
        if c == first {
            run += 1;
        } else {
            break;
        }
    }
    if run < 3 {
        return (0, None);
    }
    (run, Some(first))
}

fn reconstruct_fence(info: &FenceInfo) -> String {
    let mut meta_tokens: Vec<String> = Vec::new();
    if let Some(p) = &info.file_path {
        meta_tokens.push(format!("path={}", p));
    }
    if let Some(l) = info.start_line {
        meta_tokens.push(format!("startLine={}", l));
    }
    match (info.language.is_empty(), meta_tokens.is_empty()) {
        (true, true) => String::from("```"),
        (false, true) => format!("```{}", info.language),
        (true, false) => format!("```{{{}}}", meta_tokens.join(" ")),
        (false, false) => format!(
            "```{}{{{}}}",
            info.language,
            meta_tokens.join(" ")
        ),
    }
}
