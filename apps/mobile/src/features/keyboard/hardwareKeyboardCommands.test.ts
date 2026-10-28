import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchHardwareKeyboardCommand,
  getRegisteredHardwareKeyboardCommands,
  registerHardwareKeyboardCommand,
  subscribeToHardwareKeyboardCommandRegistrations,
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
