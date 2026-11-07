let supported: boolean | null = null;

/**
 * Whether this browser can create a WebGL 2 context, checked once with a
 * throwaway canvas whose context is released straight away. three.js needs
 * WebGL 2; a browser with it switched off (or a GPU blocklist) offers none.
 */
export function webglSupported(): boolean {
  if (supported !== null) return supported;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", { powerPreference: "low-power" });
    supported = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    supported = false;
  }
  return supported;
}
