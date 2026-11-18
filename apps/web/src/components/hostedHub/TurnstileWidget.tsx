import { useEffect, useRef, useState } from "react";

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * The action each public form binds its token to. The Hub checks the token's
 * action against the endpoint it was submitted to, so these must match the
 * Hub's names (the phone app's Turnstile challenge uses the same ones).
 */
export type TurnstileAction =
  | "external_signup"
  | "password_login"
  | "password_reset"
  | "public_signup";

interface TurnstileApi {
  readonly render: (
    container: HTMLElement,
    options: {
      readonly sitekey: string;
      readonly action: TurnstileAction;
      readonly theme: "auto" | "dark" | "light";
      readonly callback: (token: string) => void;
      readonly "expired-callback": () => void;
      readonly "error-callback": () => void;
    },
  ) => string;
  readonly remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    );
    const script = existing ?? document.createElement("script");
    const loaded = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile did not initialize"));
    };
    const failed = () => reject(new Error("Turnstile could not be loaded"));
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  }).catch((error: unknown) => {
    turnstileScriptPromise = null;
    throw error;
  });
  return turnstileScriptPromise;
}

export function TurnstileWidget({
  siteKey,
  action,
  onToken,
}: {
  readonly siteKey: string;
  readonly action: TurnstileAction;
  readonly onToken: (token: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let widget: { readonly api: TurnstileApi; readonly id: string } | null = null;
    onToken(null);
    setFailed(false);
    void loadTurnstile()
      .then((api) => {
        if (disposed || containerRef.current === null) return;
        const id = api.render(containerRef.current, {
          sitekey: siteKey,
          action,
          // The app's resolved scheme, not `"auto"`. Turnstile's `auto` follows
          // the OS `prefers-color-scheme`, while Ryco's is chosen in-app and
          // applied as a `dark` class on the root — so a light OS with a dark
          // Ryco dropped a white third-party box into the middle of a dark
          // sign-up card.
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          callback: (token) => {
            if (!disposed) onToken(token);
          },
          "expired-callback": () => {
            if (!disposed) onToken(null);
          },
          "error-callback": () => {
            if (!disposed) {
              onToken(null);
              setFailed(true);
            }
          },
        });
        widget = { api, id };
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      onToken(null);
      if (widget) widget.api.remove(widget.id);
    };
  }, [action, onToken, siteKey]);

  return (
    <div className="space-y-2">
      {/* The widget's own height, reserved before it loads. Turnstile's managed
          widget renders at 65px, and injecting that into a form that had
          collapsed to nothing moved every control below it once the script
          arrived. */}
      <div ref={containerRef} aria-label="Anti-bot verification" className="min-h-[65px]" />
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          Verification could not load. Check your connection and try again.
        </p>
      ) : null}
    </div>
  );
}
