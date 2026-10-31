import { describe, expect, it } from "vite-plus/test";

import { resolveEnabledHardwareKeyboardCommands } from "./hardwareKeyboardCommandScope";
import { THREAD_JUMP_COMMANDS, type HardwareKeyboardCommand } from "./hardwareKeyboardCommands";

const THREAD = "/threads/node/thread";

function enabled(
  input: Partial<
    Omit<Parameters<typeof resolveEnabledHardwareKeyboardCommands>[0], "registered">
  > & {
    readonly registered?: ReadonlyArray<HardwareKeyboardCommand>;
  } = {},
) {
  return resolveEnabledHardwareKeyboardCommands({
    pathname: input.pathname ?? "/",
    workspacePathname: input.workspacePathname ?? input.pathname ?? "/",
    canGoBack: input.canGoBack ?? false,
    registered: new Set(input.registered ?? []),
  }).toSorted();
}

describe("resolveEnabledHardwareKeyboardCommands", () => {
  it("offers the palette and New Task everywhere, and Back once there is somewhere to go", () => {
    expect(enabled()).toEqual(["commandPalette", "newTask"]);
    expect(enabled({ canGoBack: true })).toEqual(["back", "commandPalette", "newTask"]);
    expect(enabled({ pathname: "/settings", workspacePathname: "/" })).toEqual([
      "back",
      "commandPalette",
      "newTask",
    ]);
  });

  it("does not offer New Task while it is open", () => {
    expect(
      enabled({ pathname: "/tasks/new", workspacePathname: "/", registered: ["newTask"] }),
    ).not.toContain("newTask");
  });

  it("offers what screens registered, such as Home's search", () => {
    expect(enabled({ registered: ["focusSearch"] })).toContain("focusSearch");
  });

  it("offers thread jumps over Home and threads, sheets included, but not elsewhere", () => {
    const registered = THREAD_JUMP_COMMANDS;
    expect(enabled({ registered })).toEqual(
      expect.arrayContaining([...THREAD_JUMP_COMMANDS, "commandPalette"]),
    );
    expect(enabled({ pathname: `${THREAD}/files`, registered })).toContain("thread.jump.1");
    expect(enabled({ pathname: "/settings", workspacePathname: THREAD, registered })).toContain(
      "thread.jump.9",
    );
    expect(enabled({ pathname: "/projects/node/project", registered })).not.toContain(
      "thread.jump.1",
    );
  });

  it("offers a thread's files, terminal and review only on an uncovered thread screen", () => {
    const registered: HardwareKeyboardCommand[] = ["files", "terminal", "review"];
    expect(enabled({ pathname: THREAD, registered })).toEqual(
      expect.arrayContaining(["files", "terminal", "review"]),
    );
    expect(enabled({ pathname: `${THREAD}/review`, registered })).toContain("files");
    expect(
      enabled({ pathname: "/tasks/new", workspacePathname: THREAD, registered }),
    ).not.toContain("files");
    expect(enabled({ pathname: "/", registered })).not.toContain("terminal");
  });

  it("leaves the palette's own commands to the palette's view", () => {
    expect(enabled({ registered: ["paletteNext", "paletteDismiss"] })).toEqual([
      "commandPalette",
      "newTask",
    ]);
  });
});
