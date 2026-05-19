//! Integration test: spawn the real OmniSharp binary, perform an LSP
//! `initialize` handshake, and assert we get a well-formed response.
//!
//! This test is `#[ignore]` by default because it needs the ~80 MB OmniSharp
//! release on disk. To run:
//!
//! ```text
//! # 1. Download OmniSharp v1.39.13 for your platform from
//! #    https://github.com/OmniSharp/omnisharp-roslyn/releases/tag/v1.39.13
//! # 2. Extract anywhere; point the env var at the executable:
//! set LOCUS_OMNISHARP_PATH=C:\tools\omnisharp\OmniSharp.exe   (Windows)
//! export LOCUS_OMNISHARP_PATH=/opt/omnisharp/OmniSharp        (Linux/macOS)
//!
//! # 3. cd src-tauri && cargo test --test omnisharp_handshake -- --ignored --nocapture
//! ```
//!
//! Skips silently if `LOCUS_OMNISHARP_PATH` is unset, so unconfigured CI
//! runners just no-op the test.

use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

#[tokio::test]
#[ignore]
async fn omnisharp_handshake() {
    let Ok(binary) = std::env::var("LOCUS_OMNISHARP_PATH") else {
        eprintln!("skip: LOCUS_OMNISHARP_PATH not set");
        return;
    };
    if binary.trim().is_empty() {
        eprintln!("skip: LOCUS_OMNISHARP_PATH is empty");
        return;
    }

    let workspace = tempfile::tempdir().expect("create temp workspace");

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("-lsp")
        .arg("-s")
        .arg(workspace.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Pass stderr through so we can see startup diagnostics on failure.
        .stderr(Stdio::inherit());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().expect("spawn OmniSharp");
    let mut stdin = child.stdin.take().expect("stdin handle");
    let stdout = child.stdout.take().expect("stdout handle");

    // ── Phase 1: send `initialize` request ────────────────────────────────
    let init_request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": std::process::id(),
            "rootUri": format!("file:///{}", workspace.path().display().to_string().replace('\\', "/")),
            "capabilities": {},
            "clientInfo": { "name": "locus-test", "version": "0.0.0" }
        }
    });
    write_lsp_message(&mut stdin, &init_request)
        .await
        .expect("write initialize");

    // ── Phase 2: wait up to 60s for the matching response ─────────────────
    let read_task = async {
        let mut reader = BufReader::new(stdout);
        loop {
            let message = read_lsp_message(&mut reader)
                .await
                .expect("read LSP message");
            // OmniSharp emits diagnostics/notifications before the response;
            // walk them until we see one with id = 1.
            if message.get("id") == Some(&json!(1)) {
                return message;
            }
        }
    };

    let response = match timeout(Duration::from_secs(180), read_task).await {
        Ok(message) => message,
        Err(_) => {
            let _ = child.kill().await;
            panic!("timed out (180s) waiting for initialize response");
        }
    };

    let result = response
        .get("result")
        .unwrap_or_else(|| panic!("initialize response missing `result`: {}", response));
    let capabilities = result
        .get("capabilities")
        .unwrap_or_else(|| panic!("initialize response missing `capabilities`: {}", response));
    assert!(
        capabilities.is_object(),
        "capabilities is not an object: {}",
        response
    );
    eprintln!(
        "OmniSharp serverInfo: {}",
        result.get("serverInfo").cloned().unwrap_or(json!(null))
    );

    // ── Cleanup: send `shutdown` then kill if it lingers ──────────────────
    let shutdown = json!({"jsonrpc": "2.0", "id": 2, "method": "shutdown"});
    let _ = write_lsp_message(&mut stdin, &shutdown).await;
    let exit = json!({"jsonrpc": "2.0", "method": "exit"});
    let _ = write_lsp_message(&mut stdin, &exit).await;

    if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

async fn write_lsp_message<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(value).expect("serialize json");
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await
}

async fn read_lsp_message<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
) -> std::io::Result<serde_json::Value> {
    let mut content_length: Option<usize> = None;
    let mut header = String::new();
    loop {
        header.clear();
        let n = reader.read_line(&mut header).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "EOF while reading LSP headers",
            ));
        }
        let line = header.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line
            .strip_prefix("Content-Length:")
            .or_else(|| line.strip_prefix("content-length:"))
        {
            content_length = rest.trim().parse().ok();
        }
    }
    let len = content_length.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "LSP message missing Content-Length",
        )
    })?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid JSON body: {}", e),
        )
    })
}
