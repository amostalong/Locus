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
