// Dialog policy and main-world dialog shim adapted from Synara (MIT) commit 8f6521a67 dialogHandling.ts (its window-held drain for the paired-browser scope); see docs/licenses/synara-computer-use.txt.
import type {
  BrowserCommandScope,
  BrowserDialogPolicy,
  BrowserHandledDialog,
  BrowserPendingDialog,
} from "./browser.ts";
import { truncateUtf8 } from "./browserDiagnostics.ts";

export const MAX_DIALOGS_PER_COMMAND = 20;
/**
 * Per dialog field. A result carries up to MAX_DIALOGS_PER_COMMAND dialogs of two fields each, so
 * page-chosen dialog text stays within the diagnostics cap that results going straight into the
 * model's context are held to (DIAGNOSTICS_OUTPUT_MAX_BYTES).
 */
const MAX_DIALOG_TEXT_BYTES = 1_024;
/** How long one shim cleanup command may take before the action's result goes out without it. */
export const DIALOG_SHIM_CLEANUP_TIMEOUT_MS = 1_000;
/** The longest one action's shim may answer dialogs: the desktop ends every request after 60 s. */
export const DIALOG_SHIM_MAX_MS = 60_000;
const DIALOG_SHIM_MIN_MS = 1_000;

const dialogText = (value: unknown): string =>
  truncateUtf8(
    (typeof value === "string" ? value : String(value ?? ""))
      // Control characters (JSON escapes them six times over) become spaces; line breaks and tabs stay.
      // oxlint-disable-next-line no-control-regex -- page text.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " "),
    MAX_DIALOG_TEXT_BYTES,
  );

/** Page-supplied dialog data (CDP params or shim records), bounded and typed. */
export function normalizeDialog(opening: Record<string, unknown>): BrowserPendingDialog {
  const raw = opening.type ?? opening.kind;
  const kind =
    raw === "confirm" || raw === "prompt" || raw === "beforeunload" ? raw : ("alert" as const);
  const defaultPrompt = opening.defaultPrompt ?? opening.defaultValue;
  const openedAt =
    typeof opening.openedAt === "string" && Number.isFinite(Date.parse(opening.openedAt))
      ? new Date(opening.openedAt).toISOString()
      : new Date().toISOString();
  return {
    kind,
    message: dialogText(opening.message),
    ...(defaultPrompt === undefined || kind !== "prompt"
      ? {}
      : { defaultPrompt: dialogText(defaultPrompt) }),
    openedAt,
  };
}

/**
 * Main-world expression that replaces alert/confirm/prompt for the length of one agent action and
 * returns a handle `{ drain(), restore() }`. Its state lives in the closure, and the policy is
 * embedded only as JSON data. After `maxMs` (or restore()) the shim hands every call to the page's
 * original function, so a cleanup that never ran cannot keep it alive.
 *
 * `key` is for a browser whose CDP has no remote object handles (the paired extension allows only
 * Runtime.evaluate): the handle is also kept under that one-off, non-enumerable window property,
 * where dialogShimFinish() finds and removes it.
 */
export function dialogShimInstall(
  policy: BrowserDialogPolicy,
  maxMs: number,
  key?: string,
): string {
  const data = JSON.stringify({
    accept: policy.dialog === "accept",
    promptText: policy.promptText ?? null,
    maxMs: Math.min(DIALOG_SHIM_MAX_MS, Math.max(DIALOG_SHIM_MIN_MS, Math.trunc(maxMs))),
  });
  const publish =
    key === undefined
      ? ""
      : `
  Object.defineProperty(page, ${JSON.stringify(key)}, { value: handle, configurable: true });`;
  return `(() => {
  const policy = ${data};
  const page = window;
  const originals = { alert: page.alert, confirm: page.confirm, prompt: page.prompt };
  const dialogs = [];
  const deadline = Date.now() + policy.maxMs;
  let restored = false;
  const live = () => !restored && Date.now() < deadline;
  const text = (value) => String(value).slice(0, 4096);
  const record = (kind, message, defaultPrompt) => {
    if (dialogs.length >= 20) return;
    dialogs.push({ kind, message: text(message), ...(defaultPrompt === undefined ? {} : { defaultPrompt: text(defaultPrompt) }), openedAt: new Date().toISOString() });
  };
  const shims = {
    alert: function (...args) {
      if (!live()) return Reflect.apply(originals.alert, page, args);
      record('alert', args.length ? args[0] : '');
    },
    confirm: function (...args) {
      if (!live()) return Reflect.apply(originals.confirm, page, args);
      record('confirm', args.length ? args[0] : '');
      return policy.accept;
    },
    prompt: function (...args) {
      if (!live()) return Reflect.apply(originals.prompt, page, args);
      const fallback = args.length > 1 && args[1] !== undefined ? String(args[1]) : '';
      record('prompt', args.length ? args[0] : '', fallback);
      return policy.accept ? (policy.promptText === null ? fallback : policy.promptText) : null;
    },
  };
  page.alert = shims.alert;
  page.confirm = shims.confirm;
  page.prompt = shims.prompt;
  const handle = {
    drain() { return dialogs.splice(0, 20); },
    restore() {
      restored = true;
      for (const name of ['alert', 'confirm', 'prompt']) if (page[name] === shims[name]) page[name] = originals[name];
      return true;
    },
  };${publish}
  return handle;
})()`;
}

/** Main-world expression: removes the keyed handle, puts the page's functions back and drains it. */
export function dialogShimFinish(key: string): string {
  const name = JSON.stringify(key);
  return `(() => {
  const handle = window[${name}];
  if (!handle) return [];
  delete window[${name}];
  handle.restore();
  return handle.drain();
})()`;
}

/**
 * What a shim's drain returned, as one action's records. The action is recomputed from the policy
 * the shim answered with; page data is never trusted for it.
 */
export function shimDialogs(drained: unknown, policy: BrowserDialogPolicy): BrowserHandledDialog[] {
  if (!Array.isArray(drained)) return [];
  const accept = policy.dialog === "accept";
  return drained.slice(0, MAX_DIALOGS_PER_COMMAND).map((value): BrowserHandledDialog => {
    const dialog: BrowserHandledDialog = Object.assign(
      normalizeDialog(value && typeof value === "object" ? (value as Record<string, unknown>) : {}),
      { action: "dismissed" as const, during: "command" as const },
    );
    if (dialog.kind === "alert" || accept) dialog.action = "accepted";
    return dialog;
  });
}

/** Runs one Runtime.evaluate in the tab's main world and returns the response. */
type MainWorldEvaluate = (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/**
 * One action's dialog shim in a paired Chrome, Brave or Edge tab, through the extension's
 * Runtime.evaluate only: a dialog the action's page code opens is answered inside the page, so the
 * browser never blocks the page (and the action with it) on a native box. `end` restores the page's
 * functions and drains what the shim answered. Dialogs the shim cannot see (frames, references the
 * page saved earlier) still block until the extension's request timeout.
 */
export async function beginPageDialogScope(
  evaluate: MainWorldEvaluate,
  policy: BrowserDialogPolicy,
  maxMs: number,
  signal: AbortSignal,
): Promise<BrowserCommandScope> {
  const key = `__rycoDialogs${crypto.randomUUID().replaceAll("-", "")}`;
  let installed = false;
  try {
    const response = (await evaluate(
      {
        expression: `${dialogShimInstall(policy, maxMs, key)}, true`,
        returnByValue: true,
        silent: true,
      },
      signal,
    )) as { exceptionDetails?: unknown } | undefined;
    installed = !response?.exceptionDetails;
  } catch {
    // A page that froze alert, or a document going away: the action runs without the shim.
  }
  let ended = false;
  return {
    end: async () => {
      if (!installed || ended) return { dialogs: [] };
      ended = true;
      try {
        // Never on the action's signal: a stopped or aborted action still gets its page back (the
        // shim also expires on its own).
        const response = (await evaluate(
          { expression: dialogShimFinish(key), returnByValue: true, silent: true },
          AbortSignal.timeout(DIALOG_SHIM_CLEANUP_TIMEOUT_MS),
        )) as { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
        return {
          dialogs: response?.exceptionDetails ? [] : shimDialogs(response?.result?.value, policy),
        };
      } catch {
        // A navigation destroyed the document, and the shim with it.
        return { dialogs: [] };
      }
    },
  };
}
