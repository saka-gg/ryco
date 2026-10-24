/**
 * A Copilot SDK client double for the Copilot retention test and
 * `scripts/measure-adapter-retention.ts`: one session that forwards the root (main agent) SDK
 * events the caller sends to the subscribed adapter, and keeps none of them.
 *
 * No test-runner imports, so the measurement script uses it as well.
 *
 * @module provider/testUtils/fakeCopilotClient
 */
type SdkEventHandler = (event: unknown) => void;

export function makeFakeCopilotClient(sessionId: string) {
  let handler: SdkEventHandler | undefined;
  const session = {
    sessionId,
    on: (next: SdkEventHandler) => {
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
      };
    },
    disconnect: async () => {},
    abort: async () => {},
    send: async () => {},
    setModel: async () => {},
  };
  let sequence = 0;
  return {
    /** Pass as `clientFactory: () => fake.client as never`. */
    client: {
      createSession: async () => session,
      resumeSession: async () => session,
      stop: async () => [],
      forceStop: async () => {},
    },
    /** Sends a root (main agent) SDK event to the subscribed adapter and returns it. */
    send: (type: string, data: Record<string, unknown>) => {
      const event = {
        id: `${sessionId}-event-${sequence++}`,
        timestamp: new Date().toISOString(),
        parentId: null,
        type,
        data,
      };
      if (!handler) throw new Error("Copilot session is not subscribed");
      handler(event);
      return event;
    },
  };
}

export type FakeCopilotClient = ReturnType<typeof makeFakeCopilotClient>;
