import { readonly, ref } from "vue";

export type OmniSharpState =
  | "disabled"
  | "connecting"
  | "initializing"
  | "ready"
  | "error";

/** Module-level singleton state, shared by all consumers. */
const state = ref<OmniSharpState>("disabled");
const detail = ref("");
const name = ref("LSP");

export function useOmnisharpStatus() {
  function setStatus(s: OmniSharpState, d = "") {
    state.value = s;
    detail.value = d;
  }

  function setName(n: string) {
    name.value = n;
  }

  return {
    state: readonly(state),
    detail: readonly(detail),
    name: readonly(name),
    setStatus,
    setName,
  };
}
