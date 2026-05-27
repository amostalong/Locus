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

class TauriLspMessageReader extends AbstractMessageReader implements MessageReader {
  private unsubscribe: RuntimeUnsubscribe | null = null;

  constructor(private readonly session: LspSession) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    this.session
      .onMessage((raw) => {
        try {
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
  constructor(private readonly session: LspSession) {
    super();
  }

  async write(msg: Message): Promise<void> {
    try {
      if (typeof console !== "undefined") {
        const m = msg as { method?: string; id?: unknown };
        console.log("[lsp:tx]", m.method ?? `response(id=${String(m.id)})`);
      }
      await this.session.send(msg);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.fireError(error, msg, undefined);
      throw error;
    }
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
  const reader = new TauriLspMessageReader(session);
  const writer = new TauriLspMessageWriter(session);

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
