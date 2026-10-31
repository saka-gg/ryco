import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchHardwareKeyboardCommand,
  getRegisteredHardwareKeyboardCommands,
  registerHardwareKeyboardCommand,
  subscribeToHardwareKeyboardCommandRegistrations,
  THREAD_JUMP_COMMANDS,
  threadJumpIndex,
} from "./hardwareKeyboardCommands";

// The provider reads the registered set through useSyncExternalStore and builds
// its enabled-command list in a memo keyed on that set. React Compiler keys a
// memo on what its callback reads, so the snapshot itself has to change when
// (and only when) the registrations do: a version counter the memo never read
// was dropped, and a fresh set per read would loop the external store.

const cleanups: Array<() => void> = [];

function register(...args: Parameters<typeof registerHardwareKeyboardCommand>): () => void {
  const unregister = registerHardwareKeyboardCommand(...args);
  cleanups.push(unregister);
  return unregister;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

describe("hardware keyboard command registrations", () => {
  it("keeps the snapshot's identity while nothing changes", () => {
    const before = getRegisteredHardwareKeyboardCommands();
    expect(getRegisteredHardwareKeyboardCommands()).toBe(before);

    register("review", () => true);
    const registered = getRegisteredHardwareKeyboardCommands();
    expect(getRegisteredHardwareKeyboardCommands()).toBe(registered);
    expect(registered).not.toBe(before);
  });

  it("publishes a new set and notifies on register and on unregister", () => {
    const listener = vi.fn();
    cleanups.push(subscribeToHardwareKeyboardCommandRegistrations(listener));

    const unregister = register("files", () => true);
    expect(listener).toHaveBeenCalledTimes(1);
    const registered = getRegisteredHardwareKeyboardCommands();
    expect([...registered]).toEqual(["files"]);

    unregister();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getRegisteredHardwareKeyboardCommands()).not.toBe(registered);
    expect(getRegisteredHardwareKeyboardCommands().has("files")).toBe(false);
  });

  it("keeps a command registered until its last handler leaves", () => {
    const listener = vi.fn();
    cleanups.push(subscribeToHardwareKeyboardCommandRegistrations(listener));
    const leaveFirst = register("terminal", () => true);
    const registered = getRegisteredHardwareKeyboardCommands();

    const leaveSecond = register("terminal", () => true);
    // The set of commands did not change, so neither did the snapshot.
    expect(getRegisteredHardwareKeyboardCommands()).toBe(registered);
    leaveFirst();
    expect(getRegisteredHardwareKeyboardCommands().has("terminal")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    leaveSecond();
    expect(getRegisteredHardwareKeyboardCommands().has("terminal")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("offers a command to the most recently registered handler first", () => {
    const calls: string[] = [];
    register("back", () => {
      calls.push("app");
      return true;
    });
    register("back", () => {
      calls.push("screen");
      return false;
    });
    const leaveSheet = register("back", () => {
      calls.push("sheet");
      return true;
    });

    expect(dispatchHardwareKeyboardCommand("back")).toBe(true);
    expect(calls).toEqual(["sheet"]);

    leaveSheet();
    calls.length = 0;
    // A handler that returns false passes the command on.
    expect(dispatchHardwareKeyboardCommand("back")).toBe(true);
    expect(calls).toEqual(["screen", "app"]);
    expect(dispatchHardwareKeyboardCommand("newTask")).toBe(false);
  });
});

describe("thread jump commands", () => {
  it("lists Command-1 through Command-9 in order with their positions", () => {
    expect(THREAD_JUMP_COMMANDS).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
    ]);
    expect(threadJumpIndex("thread.jump.1")).toBe(0);
    expect(threadJumpIndex("thread.jump.9")).toBe(8);
    expect(threadJumpIndex("commandPalette")).toBe(-1);
  });

  it("registers one handler for several commands and tells it which one came", () => {
    const received: string[] = [];
    const unregister = register(THREAD_JUMP_COMMANDS, (command) => {
      received.push(command);
    });
    expect([...getRegisteredHardwareKeyboardCommands()]).toEqual(THREAD_JUMP_COMMANDS);

    expect(dispatchHardwareKeyboardCommand("thread.jump.3")).toBe(true);
    expect(dispatchHardwareKeyboardCommand("thread.jump.7")).toBe(true);
    expect(received).toEqual(["thread.jump.3", "thread.jump.7"]);

    unregister();
    expect(getRegisteredHardwareKeyboardCommands().size).toBe(0);
    expect(dispatchHardwareKeyboardCommand("thread.jump.3")).toBe(false);
  });
});
