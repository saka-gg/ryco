import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { TurnstileWidget } from "./TurnstileWidget";

let mounted: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  delete window.turnstile;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("TurnstileWidget", () => {
  for (const action of [
    "public_signup",
    "external_signup",
    "password_login",
    "password_reset",
  ] as const) {
    it(`binds ${action} to the server-verified Turnstile action`, async () => {
      const renderWidget = vi.fn(
        (
          _container: HTMLElement,
          _options: Parameters<NonNullable<Window["turnstile"]>["render"]>[1],
        ) => "widget-id",
      );
      window.turnstile = {
        render: renderWidget,
        remove: vi.fn(),
      };

      mounted = await render(
        <TurnstileWidget siteKey="0x4AAAAAAAAAAABBBBBBBBBB" action={action} onToken={vi.fn()} />,
      );

      await vi.waitFor(() => expect(renderWidget).toHaveBeenCalledOnce());
      expect(renderWidget.mock.calls[0]?.[1]).toMatchObject({
        sitekey: "0x4AAAAAAAAAAABBBBBBBBBB",
        action,
      });
    });
  }
});
