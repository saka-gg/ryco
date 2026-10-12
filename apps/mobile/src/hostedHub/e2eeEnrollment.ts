import type { NativeE2eeEnrollmentCoordinator } from "@ryco/client-runtime/authorization/e2ee";

let coordinator: NativeE2eeEnrollmentCoordinator | null = null;
let unsubscribeCoordinator: (() => void) | undefined;
const listeners = new Set<() => void>();
const IDLE_STATE = {
  status: "idle" as const,
  generation: 0,
  ready: null,
  errorCode: null,
};

export function setMobileNativeE2eeEnrollmentCoordinator(
  next: NativeE2eeEnrollmentCoordinator | null,
): void {
  unsubscribeCoordinator?.();
  coordinator = next;
  unsubscribeCoordinator = next?.subscribe(() => listeners.forEach((listener) => listener()));
  listeners.forEach((listener) => listener());
}

export function getMobileNativeE2eeEnrollmentCoordinator(): NativeE2eeEnrollmentCoordinator | null {
  return coordinator;
}

export function getMobileNativeE2eeEnrollmentState() {
  return coordinator?.getState() ?? IDLE_STATE;
}

export function subscribeMobileNativeE2eeEnrollment(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
