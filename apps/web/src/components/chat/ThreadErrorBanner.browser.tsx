import "../../index.css";

import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ToastProvider, toastManager } from "../ui/toast";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

function NotificationHarness({ onDismiss }: { onDismiss: () => void }) {
  const [providerReady, setProviderReady] = useState(false);
  useEffect(() => setProviderReady(true), []);
  return (
    <ToastProvider>
      {providerReady ? (
        <ThreadErrorBanner
          error="Thread references an unknown provider instance."
          threadRef={null}
          onDismiss={onDismiss}
        />
      ) : null}
    </ToastProvider>
  );
}

vi.mock("@tanstack/react-router", () => ({
  useParams: (options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = {};
    return options?.select ? options.select(params) : params;
  },
}));

describe("thread error notification", () => {
  afterEach(() => {
    toastManager.close();
    document.body.innerHTML = "";
  });

  it("uses the persistent error notification and dismisses thread state", async () => {
    const onDismiss = vi.fn();
    const mounted = await render(<NotificationHarness onDismiss={onDismiss} />);

    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="toast-root"]')).not.toBeNull();
      });
      const root = document.querySelector<HTMLElement>('[data-slot="toast-root"]')!;
      expect(root.dataset.type).toBe("error");
      expect(root.classList.contains("app-toast-surface")).toBe(true);
      expect(root.querySelectorAll(":scope > .liquid-glass-ring")).toHaveLength(0);
      expect(root.textContent).toContain("Thread references an unknown provider instance.");
      expect(document.querySelector('[data-slot="alert"]')).toBeNull();

      const close = root.querySelector<HTMLButtonElement>('[data-slot="toast-close"]');
      expect(close).not.toBeNull();
      close!.click();
      await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    } finally {
      await mounted.unmount();
    }
  });
});
