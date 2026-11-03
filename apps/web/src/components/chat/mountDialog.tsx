import { createRoot } from "react-dom/client";

/**
 * Renders a dialog outside the React tree, for choices a send asks for from
 * non-React code (the shared send engine's presentations). Returns `close`,
 * which unmounts it once; `render` receives the same function.
 */
export function mountDialog(render: (close: () => void) => React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      root.unmount();
      container.remove();
    });
  };
  root.render(render(close));
  return close;
}
