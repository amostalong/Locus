import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc";
import {
  CloseAction,
  ErrorAction,
  type LanguageClientOptions,
} from "vscode-languageclient";
import { MonacoLanguageClient } from "monaco-languageclient";
import * as monaco from "monaco-editor";

import { startLsp, type LspKind, type LspSession } from "./lsp";
import type { RuntimeUnsubscribe } from "./locusRuntime";

/**
 * Shared state between TauriLspMessageWriter and TauriLspMessageReader
 * for deduplicating `textDocument/codeLens` responses.
 *
 * Unlike the previous approach that tried Writer-level request dedup and
 * response cloning, this now uses a simple 500ms safety dedup at the Reader
 * level. The ROOT CAUSE fix is in monacoVscodeServices.ts: the `registerCodeLensProvider`
 * disposable is properly tracked and cleaned up, preventing Monaco from
 * accumulating duplicate provider registrations.
 *
 * If a duplicate still slips through (e.g. Monaco calls the same provider
 * twice within milliseconds), the 500ms safety dedup suppresses the second
 * identical response.
 *
 * IMPORTANT: Commands ARE preserved in code lens responses. Clicking a code
 * lens must trigger findReferences. Do NOT strip commands.
 */
const DEDUP_WINDOW_MS = 500;

interface CodeLensTracker {
  /** request ID → file URI (set by writer when sending codeLens requests) */
  requestUri: Map<number | string, string>;
  /** URI → { hash, timestamp } of last forwarded codeLens response (500ms dedup) */
  lastResult: Map<string, { hash: string; timestamp: number }>;
}

class TauriLspMessageReader extends AbstractMessageReader implements MessageReader {
  private unsubscribe: RuntimeUnsubscribe | null = null;

  constructor(
    private readonly session: LspSession,
    private readonly codeLensTracker: CodeLensTracker,
  ) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    this.session
      .onMessage((raw) => {
        try {
          if (raw == null) return;
          if (typeof console !== "undefined") {
            const msg = raw as {
              method?: string;
              id?: unknown;
              params?: unknown;
              result?: unknown;
              error?: unknown;
            };
            const tag = msg.method ?? (msg.error ? `error(id=${String(msg.id)})` : `response(id=${String(msg.id)})`);
            const stringify = (v: unknown): string => {
              try {
                const s = JSON.stringify(v);
                return s && s.length > 600 ? s.slice(0, 600) + "…" : s ?? String(v);
              } catch {
                return String(v);
              }
            };
            // Surface OmniSharp project-load errors and result payloads so
            // we can tell whether the server has analysis info vs. silently
            // returning empty results. window/logMessage is too noisy to log
            // in full (OmniSharp emits hundreds during boot).
            if (msg.method === "o#/error") {
              console.log("[lsp:rx]", tag, stringify(msg.params));
            } else if (msg.method === "window/logMessage") {
              // Skip — too verbose during startup.
            } else if (msg.result !== undefined && !msg.method) {
              console.log("[lsp:rx]", tag, stringify(msg.result));
            } else if (msg.method) {
              console.log("[lsp:rx]", tag);
            } else {
              console.log("[lsp:rx]", tag);
            }
          }

          // ---- codeLens 500ms safety dedup ----
          // Monaco may call the same codeLens provider twice within milliseconds.
          // If both responses are identical and within 500ms, suppress the second.
          // This is a SAFETY NET only — the root cause (provider registration
          // accumulation) is handled in monacoVscodeServices.ts.
          //
          // Commands are preserved so clicking code lens triggers findReferences.
          const r = raw as Record<string, unknown>;
          if (r.id !== undefined && r.result !== undefined) {
            const uri = this.codeLensTracker.requestUri.get(r.id as string | number);
            if (uri) {
              this.codeLensTracker.requestUri.delete(r.id as string | number);
              const hash = JSON.stringify(r.result);
              const prev = this.codeLensTracker.lastResult.get(uri);
              const now = Date.now();
              if (prev && prev.hash === hash && now - prev.timestamp < DEDUP_WINDOW_MS) {
                if (typeof console !== "undefined") {
                  console.log("[lsp:rx] codeLens dedup: suppressed duplicate for", uri);
                }
                return;
              }
              this.codeLensTracker.lastResult.set(uri, { hash, timestamp: now });
            }
          }

          callback(raw as Message);
        } catch (err) {
          this.fireError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .then((release) => {
        this.unsubscribe = release;
      })
      .catch((err) => {
        this.fireError(err instanceof Error ? err : new Error(String(err)));
      });
    return { dispose: () => this.dispose() };
  }

  override dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.dispose();
  }
}

class TauriLspMessageWriter extends AbstractMessageWriter implements MessageWriter {
  constructor(
    private readonly session: LspSession,
    private readonly codeLensTracker: CodeLensTracker,
  ) {
    super();
  }

  async write(msg: Message): Promise<void> {
    try {
      const raw = msg as Record<string, unknown>;

      // Track codeLens request IDs → file URI for the reader to correlate responses.
      if (raw.method === "textDocument/codeLens") {
        const params = raw.params as { textDocument?: { uri?: string } } | undefined;
        const uri = params?.textDocument?.uri;
        if (uri && raw.id !== undefined) {
          this.codeLensTracker.requestUri.set(raw.id as string | number, uri);
        }
      }

      await this.doSend(msg);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.fireError(error, msg, undefined);
      throw error;
    }
  }

  private async doSend(msg: Message): Promise<void> {
    if (typeof console !== "undefined") {
      const m = msg as { method?: string; id?: unknown };
      console.log("[lsp:tx]", m.method ?? `response(id=${String(m.id)})`);
    }
    await this.session.send(msg);
  }

  end(): void {}

  override dispose(): void {
    super.dispose();
  }
}

export interface LanguageClientHandle {
  client: MonacoLanguageClient;
  session: LspSession;
  workspaceDir: string;
  stop(): Promise<void>;
}

interface StartArgs {
  kind: LspKind;
  name: string;
  workspaceDir: string;
  clientOptions: LanguageClientOptions;
}

async function startLanguageClient(args: StartArgs): Promise<LanguageClientHandle> {
  const session = await startLsp(args.kind, args.workspaceDir);

  const codeLensTracker: CodeLensTracker = {
    requestUri: new Map(),
    lastResult: new Map(),
  };
  const reader = new TauriLspMessageReader(session, codeLensTracker);
  const writer = new TauriLspMessageWriter(session, codeLensTracker);

  const client = new MonacoLanguageClient({
    name: args.name,
    clientOptions: args.clientOptions,
    messageTransports: { reader, writer },
  });

  try {
    await client.start();
  } catch (err) {
    await session.stop().catch(() => {});
    throw err;
  }

  return {
    client,
    session,
    workspaceDir: args.workspaceDir,
    async stop() {
      try {
        await client.stop();
      } finally {
        await session.stop().catch(() => {});
      }
    },
  };
}

export async function startCsharpLanguageClient(workspaceDir: string): Promise<LanguageClientHandle> {
  const folderUri = monaco.Uri.file(workspaceDir);
  return startLanguageClient({
    kind: "omnisharp",
    name: "OmniSharp C#",
    workspaceDir,
    clientOptions: {
      documentSelector: [{ language: "csharp" }],
      workspaceFolder: {
        uri: folderUri,
        name: leafName(workspaceDir),
        index: 0,
      },
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue }),
        closed: () => ({ action: CloseAction.DoNotRestart }),
      },
    },
  });
}

function leafName(absPath: string): string {
  const norm = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}
