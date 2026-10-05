import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createConnectionNoticeGate } from "./connectionNoticeGate";

function setup() {
  vi.useFakeTimers();
  const ports = {
    showOutage: vi.fn(),
    showRecovery: vi.fn(),
    close: vi.fn(),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  return { ...ports, gate: createConnectionNoticeGate(ports) };
}
const outage = { key: "node-a", outage: true, connected: false, delayMs: 4_000 };
afterEach(() => vi.useRealTimers());

describe("connection notice ownership", () => {
  it("does not describe planned node selection as a disconnect even if setup is slow", () => {
    const h = setup();
    h.gate.update({ ...outage, requireObservedConnection: true });
    vi.advanceTimersByTime(30_000);
    expect(h.showOutage).not.toHaveBeenCalled();
    h.gate.update({ ...outage, requireObservedConnection: true, outage: false, connected: true });
    h.gate.update({ ...outage, requireObservedConnection: true });
    vi.advanceTimersByTime(4_000);
    expect(h.showOutage).toHaveBeenCalledOnce();
  });

  it("does not announce a transient hosted reconnect or its recovery", () => {
    const h = setup();
    h.gate.update(outage);
    vi.advanceTimersByTime(3_000);
    h.gate.update({ ...outage, outage: false, connected: true });
    vi.advanceTimersByTime(10_000);
    expect(h.showOutage).not.toHaveBeenCalled();
    expect(h.showRecovery).not.toHaveBeenCalled();
  });

  it("does not let countdown updates reuse a recovery toast for an unreported next outage", () => {
    const h = setup();
    h.gate.update({ ...outage, delayMs: 0 });
    expect(h.gate.isOutageVisible()).toBe(true);
    h.gate.update({ ...outage, outage: false, connected: true });
    h.gate.update(outage);
    expect(h.gate.isOutageVisible()).toBe(false);
    vi.advanceTimersByTime(4_000);
    expect(h.gate.isOutageVisible()).toBe(true);
  });

  it("reports a persistent outage despite intermediate status updates, then one recovery", () => {
    const h = setup();
    h.gate.update(outage);
    vi.advanceTimersByTime(2_000);
    h.gate.update(outage);
    vi.advanceTimersByTime(2_000);
    expect(h.showOutage).toHaveBeenCalledOnce();
    h.gate.update({ ...outage, outage: false, connected: true });
    h.gate.update({ ...outage, outage: false, connected: true });
    expect(h.showRecovery).toHaveBeenCalledOnce();
  });

  it("reports exhausted retries or offline state immediately", () => {
    const h = setup();
    h.gate.update(outage);
    h.gate.update({ ...outage, delayMs: 0 });
    expect(h.showOutage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(4_000);
    expect(h.showOutage).toHaveBeenCalledOnce();
  });

  it("cancels pending notices on navigation and never calls it a recovery", () => {
    const h = setup();
    h.gate.update(outage);
    h.gate.update({ ...outage, key: "node-b", outage: false, connected: true });
    vi.advanceTimersByTime(5_000);
    expect(h.showOutage).not.toHaveBeenCalled();
    expect(h.showRecovery).not.toHaveBeenCalled();
  });

  it("closes a persistent toast on unmount and cancels delayed publication", () => {
    const h = setup();
    h.gate.update(outage);
    vi.advanceTimersByTime(4_000);
    h.close.mockClear();
    h.gate.dispose();
    expect(h.close).toHaveBeenCalledOnce();
    h.gate.update(outage);
    h.gate.dispose();
    vi.advanceTimersByTime(4_000);
    expect(h.showOutage).toHaveBeenCalledOnce();
  });
});
