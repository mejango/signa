import { createSignaProtocol } from "../../src/signaProtocol.js";

/** Use the actual pinned Center catalog; documentation tests never make network requests. */
export const protocolOperations = createSignaProtocol({
  fetch: async () => { throw new Error("Documentation tests never prepare transactions"); },
});
