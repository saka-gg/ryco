import type { ComputerUseApp, ComputerUseResult } from "@ryco/contracts";
import { ComputerNativeHelper } from "./helper.ts";
import type { ComputerOperationContext } from "./policy.ts";

type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as RecordValue;
}
export function textArg(args: RecordValue, name: string, max = 512): string {
  const value = args[name];
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}
export function numberArg(args: RecordValue, name: string, min = 0, max = 100_000): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid ${name}.`);
  return value;
}
export function result(value: unknown): ComputerUseResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

interface NativeWindow extends RecordValue {
  app: string;
  id: number;
  pid?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
function windowValue(value: unknown): NativeWindow {
  const raw = record(value);
  textArg(raw, "app");
  for (const key of ["id", "x", "y", "width", "height"])
    numberArg(raw, key, -100_000, Number.MAX_SAFE_INTEGER);
  return raw as NativeWindow;
}

const ACTIONS = new Set([
  "observe",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "drag",
  "find_elements",
  "invoke_element",
  "set_element_value",
  "activate",
]);

export class NativeComputerDriver {
  private readonly apps = new Map<string, ComputerUseApp>();
  private readonly observed = new Map<string, NativeWindow>();
  private readonly elements = new Map<string, { x: number; y: number }>();
  readonly helper: ComputerNativeHelper;
  private readonly ownAppPath: string;
  constructor(helper: ComputerNativeHelper, ownAppPath: string) {
    this.helper = helper;
    this.ownAppPath = ownAppPath;
  }

  private allowedIdentity(id: string): boolean {
    return (
      id !== this.ownAppPath &&
      !/(?:^|\/)(?:Ryco(?: Preview)?|System Settings|System Preferences|SecurityAgent|loginwindow)\.app(?:\/|$)/iu.test(
        id,
      )
    );
  }

  async listApps(query?: string, signal?: AbortSignal): Promise<ComputerUseApp[]> {
    const values = await this.helper.call(
      "list_apps",
      query === undefined ? {} : { query },
      signal,
    );
    if (!Array.isArray(values)) throw new Error("Invalid native app catalogue.");
    const apps = values
      .slice(0, 1_000)
      .map((value) => {
        const raw = record(value);
        return { id: textArg(raw, "id"), name: textArg(raw, "displayName") };
      })
      .filter((entry) => this.allowedIdentity(entry.id));
    for (const app of apps) this.apps.set(app.id, app);
    while (this.apps.size > 2_000) this.apps.delete(this.apps.keys().next().value!);
    return apps;
  }

  async hello(signal?: AbortSignal): Promise<RecordValue> {
    const hello = record(
      await this.helper.call("hello", { protocolVersion: 3, clientVersion: "ryco" }, signal),
    );
    if (hello.protocolVersion !== 3)
      throw new Error("Unsupported native helper protocol. Rebuild Ryco.");
    return hello;
  }

  async execute(context: ComputerOperationContext): Promise<ComputerUseResult> {
    const args = context.request.args;
    const action = textArg(args, "action");
    if (action === "status") return result(await this.hello(context.signal));
    if (action === "apps")
      return result(
        await this.listApps(
          typeof args.query === "string" ? textArg(args, "query") : undefined,
          context.signal,
        ),
      );
    if (!ACTIONS.has(action) && action !== "windows" && action !== "launch")
      throw new Error("Unknown computer action.");
    const appId = textArg(args, "app");
    if (!this.apps.has(appId)) await this.listApps(undefined, context.signal);
    const app = this.apps.get(appId);
    if (!app || !this.allowedIdentity(appId))
      throw new Error("Choose an app id returned by computer apps first.");
    await context.authorizeApp(app.id, app.name);
    const mode = args.mode ?? "background";
    if (mode !== "background" && mode !== "foreground") throw new Error("Invalid input mode.");
    if (mode === "foreground" || action === "activate") await context.authorizeForeground();
    const hello = await this.hello(context.signal);
    if (hello.screenLocked === true)
      throw new Error("The desktop is locked. Unlock it before continuing computer use.");
    context.check();
    if (action === "launch") {
      // These upstream launchers always activate; never allow an implicit takeover.
      if (process.platform !== "darwin" && mode !== "foreground")
        throw new Error(
          "Background launch is unavailable on this platform. Request foreground explicitly.",
        );
      context.claim(`app:${appId}`);
      await context.activity({ target: app.name, mode, action });
      return result(await this.helper.call("launch_app", { app: appId, mode }, context.signal));
    }
    const windows = await this.helper.call("list_windows", {}, context.signal);
    if (!Array.isArray(windows)) throw new Error("Invalid window catalogue.");
    const matching = windows
      .map(windowValue)
      .filter((window) => window.app === appId && window.pid !== process.pid);
    const scope = JSON.stringify([context.request.sessionId, context.request.turnId]);
    if (action === "windows") {
      for (const window of matching) this.observed.set(`${scope}:${window.id}`, window);
      while (this.observed.size > 2_000) this.observed.delete(this.observed.keys().next().value!);
      return result(matching);
    }
    const id = numberArg(args, "window", 1, Number.MAX_SAFE_INTEGER);
    const original = this.observed.get(`${scope}:${id}`);
    const window = matching.find((item) => item.id === id);
    if (!original || !window || original.app !== window.app || original.pid !== window.pid)
      throw new Error(
        "Window identity changed or was not observed in this turn. List windows again.",
      );
    context.claim(`window:${window.app}:${window.id}`);
    context.check();
    const input: RecordValue = { window: { app: window.app, id: window.id }, mode, verify: "fast" };
    let nativeAction = action;
    switch (action) {
      case "observe":
        nativeAction = "get_window_state";
        Object.assign(input, {
          include_screenshot: args.screenshot !== false,
          include_text: true,
          tree_max_nodes: 1_000,
          max_dimension: 1600,
          format: "png",
        });
        break;
      case "activate":
        nativeAction = "activate_window";
        break;
      case "click":
      case "scroll":
        input.x = numberArg(args, "x", 0, window.width - 1);
        input.y = numberArg(args, "y", 0, window.height - 1);
        if (action === "scroll") {
          input.scrollX = numberArg(args, "scrollX", -5_000, 5_000);
          input.scrollY = numberArg(args, "scrollY", -5_000, 5_000);
        } else {
          input.click_count =
            args.click_count === undefined ? 1 : numberArg(args, "click_count", 1, 2);
          input.mouse_button =
            args.mouse_button === undefined ? "left" : textArg(args, "mouse_button", 10);
        }
        break;
      case "drag":
        for (const key of ["from_x", "to_x"])
          input[key] = numberArg(args, key, 0, window.width - 1);
        for (const key of ["from_y", "to_y"])
          input[key] = numberArg(args, key, 0, window.height - 1);
        input.steps = 16;
        break;
      case "type_text":
        input.text = textArg(args, "text", 20_000);
        break;
      case "press_key":
        input.key = textArg(args, "key", 100);
        break;
      case "find_elements":
        for (const key of ["role", "name", "text"])
          if (args[key] !== undefined) input[key] = textArg(args, key);
        if (args.query !== undefined) input.text = textArg(args, "query");
        input.max_results = 50;
        break;
      case "invoke_element":
        input.element_id = textArg(args, "element_id");
        input.action = textArg(args, "element_action", 50);
        break;
      case "set_element_value":
        input.element_id = textArg(args, "element_id");
        input.value = textArg(args, "value", 20_000);
        break;
    }
    if (action === "invoke_element" || action === "set_element_value") {
      const point = this.elements.get(`${scope}:${id}:${String(input.element_id)}`);
      if (!point) throw new Error("Find this element in the current turn before invoking it.");
      input.x = point.x;
      input.y = point.y;
    }
    await context.activity({
      target: app.name,
      mode: action === "activate" ? "foreground" : mode,
      action,
      ...(typeof input.x === "number" && typeof input.y === "number"
        ? { x: window.x + input.x, y: window.y + input.y }
        : {}),
    });
    if (action === "drag") {
      for (const fraction of [0, 0.5, 1])
        await context.activity({
          target: app.name,
          mode,
          action,
          x:
            window.x +
            Number(input.from_x) +
            (Number(input.to_x) - Number(input.from_x)) * fraction,
          y:
            window.y +
            Number(input.from_y) +
            (Number(input.to_y) - Number(input.from_y)) * fraction,
        });
    }
    const value = await this.helper.call(nativeAction, input, context.signal);
    context.check();
    if (action === "find_elements") {
      const found = record(value).elements;
      if (Array.isArray(found))
        for (const raw of found) {
          const element = record(raw);
          const bounds = record(element.bounds);
          this.elements.set(`${scope}:${id}:${textArg(element, "id")}`, {
            x: numberArg(bounds, "x", -100_000) + numberArg(bounds, "width") / 2,
            y: numberArg(bounds, "y", -100_000) + numberArg(bounds, "height") / 2,
          });
        }
      while (this.elements.size > 2_000) this.elements.delete(this.elements.keys().next().value!);
    }
    if (action !== "observe") return result(value);
    const state = record(value);
    const screenshots = Array.isArray(state.screenshots) ? state.screenshots : [];
    const content: Array<ComputerUseResult["content"][number]> = [
      {
        type: "text",
        text: JSON.stringify({
          ...state,
          screenshots: screenshots.map((raw) => {
            const shot = record(raw);
            const { data: _data, ...metadata } = shot;
            return metadata;
          }),
        }),
      },
    ];
    for (const raw of screenshots.slice(0, 1)) {
      const shot = record(raw);
      const mimeType = textArg(shot, "mimeType");
      if (mimeType !== "image/png" && mimeType !== "image/jpeg")
        throw new Error("Unexpected native screenshot format.");
      content.push({ type: "image", data: textArg(shot, "data", 16 * 1024 * 1024), mimeType });
    }
    return { content };
  }

  stop(): void {
    this.observed.clear();
    this.elements.clear();
    this.helper.stop();
  }
}
