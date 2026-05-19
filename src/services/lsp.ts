import { ipcInvoke } from "./ipc";
import { getLocusRuntime, type RuntimeUnsubscribe } from "./locusRuntime";

export type LspKind = "omnisharp";

interface LspMessageEvent {
  session_id: string;
  message: unknown;
}

interface LspExitEvent {
  session_id: string;
  code: number | null;
  error: string | null;
}

export interface LspSession {
  readonly id: string;
  send(message: unknown): Promise<void>;
  onMessage(handler: (message: unknown) => void): Promise<RuntimeUnsubscribe>;
  onExit(handler: (info: { code: number | null; error: string | null }) => void): Promise<RuntimeUnsubscribe>;
  stop(): Promise<void>;
}

export async function startLsp(kind: LspKind, workspaceDir: string): Promise<LspSession> {
  const id = await ipcInvoke<string>("lsp_start", { kind, workspaceDir });
  const runtime = getLocusRuntime();

  return {
    id,
    send(message) {
      return ipcInvoke<void>("lsp_send", { sessionId: id, message });
    },
    onMessage(handler) {
      return runtime.subscribe<LspMessageEvent>(`lsp:${id}:message`, (payload) => {
        handler(payload.message);
      });
    },
    onExit(handler) {
      return runtime.subscribe<LspExitEvent>(`lsp:${id}:exit`, (payload) => {
        handler({ code: payload.code, error: payload.error });
      });
    },
    stop() {
      return ipcInvoke<void>("lsp_stop", { sessionId: id });
    },
  };
}
