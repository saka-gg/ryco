interface NoticeState {
  readonly key: string | null;
  readonly outage: boolean;
  readonly connected: boolean;
  readonly delayMs: number;
  readonly requireObservedConnection?: boolean;
}
interface NoticePorts {
  readonly showOutage: () => void;
  readonly showRecovery: () => void;
  readonly close: () => void;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

/** One owned notification per connection, including its delayed publication. */
export function createConnectionNoticeGate(ports: NoticePorts) {
  let key: string | null = null;
  let timer: unknown = null;
  let reported = false;
  let observedConnection = false;
  const cancel = () => {
    if (timer !== null) ports.clearTimeout(timer);
    timer = null;
  };
  const close = () => {
    cancel();
    reported = false;
    ports.close();
  };
  return {
    update(state: NoticeState) {
      if (state.key !== key) {
        close();
        key = state.key;
        observedConnection = false;
      }
      if (state.connected) observedConnection = true;
      if (state.requireObservedConnection && !observedConnection) {
        close();
        return;
      }
      if (!state.outage) {
        cancel();
        if (state.connected && reported) {
          reported = false;
          ports.showRecovery();
        } else if (!state.connected) close();
        return;
      }
      if (reported || state.delayMs === 0) {
        cancel();
        reported = true;
        ports.showOutage();
      } else if (timer === null) {
        timer = ports.setTimeout(() => {
          timer = null;
          reported = true;
          ports.showOutage();
        }, state.delayMs);
      }
    },
    isOutageVisible: () => reported,
    dispose: close,
  };
}
