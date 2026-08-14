import { useChatStore, lastStreamEventTrace } from "../stores/chat";
import { useUiStore } from "../stores/ui";
import { invoke } from "@tauri-apps/api/core";

function heapMb(): number | null {
  try {
    const memory = (performance as unknown as {
      memory?: { usedJSHeapSize: number };
    }).memory;
    if (!memory) return null;
    return Math.round(memory.usedJSHeapSize / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * Frontend liveness heartbeat for the backend watchdog
 * (`frontend_watchdog.rs`). Sends a snapshot every 2s while the event loop
 * is alive. When the UI freezes (microtask storm / sync render loop) the
 * interval stops firing and the backend logs the last known snapshot.
 */
export function useFrontendHeartbeat() {
  const timer = window.setInterval(() => {
    let payload: string;
    try {
      const chat = useChatStore();
      const ui = useUiStore();
      payload = JSON.stringify({
        tab: ui.activeTab,
        layoutTransitioning: ui.isLayoutTransitioning,
        streaming: chat.isStreaming,
        messages: chat.messages.length,
        runId: chat.currentRunId ?? null,
        lastStreamEvent: lastStreamEventTrace.type || null,
        lastStreamEventAt: lastStreamEventTrace.at || null,
        streamEventCount: lastStreamEventTrace.count,
        heapMB: heapMb(),
      });
    } catch {
      payload = JSON.stringify({ error: "snapshot_failed" });
    }
    void invoke("frontend_heartbeat", { payload }).catch(() => {
      /* watchdog is best-effort */
    });
  }, 2000);

  return () => window.clearInterval(timer);
}
