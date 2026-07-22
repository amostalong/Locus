import type { LocalWebSearchStatus, SearchEngine } from "../types";
import { ipcInvoke } from "./ipc";

export function localWebSearchGetConfig(): Promise<LocalWebSearchStatus> {
  return ipcInvoke<LocalWebSearchStatus>("get_local_web_search_config", undefined, {
    operation: "localWebSearchGetConfig",
    notify: false,
    throwOnError: true,
  });
}

export function localWebSearchSetConfig(args: {
  enabled: boolean;
  engine: SearchEngine;
  apiKey: string | null;
}): Promise<LocalWebSearchStatus> {
  return ipcInvoke<LocalWebSearchStatus>(
    "set_local_web_search_config",
    { enabled: args.enabled, engine: args.engine, apiKey: args.apiKey },
    {
      operation: "localWebSearchSetConfig",
      notify: false,
      throwOnError: true,
    },
  );
}

export function localWebSearchTestConnection(): Promise<boolean> {
  return ipcInvoke<boolean>("test_local_web_search_connection", undefined, {
    operation: "localWebSearchTestConnection",
    notify: false,
    throwOnError: true,
  });
}
