const LISTENING_LOG_FRAGMENT = "Listening on http://";
const LISTENING_PORT_PATTERN = /^Listening on http:\/\/(?:\[[^\]]*\]|[^\s/:]+):(\d+)(?=\D)/;
const MAX_BUFFER_CHARS = 8_192;

export class ServerListeningDetector {
  private buffer = "";
  private settled = false;
  private readonly expectedPort: number | undefined;
  private readonly resolvePromise: () => void;
  private readonly rejectPromise: (error: unknown) => void;
  readonly promise: Promise<void>;

  constructor(options: { readonly expectedPort?: number } = {}) {
    this.expectedPort = options.expectedPort;
    let resolvePromise: (() => void) | null = null;
    let rejectPromise: ((error: unknown) => void) | null = null;

    this.promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    this.resolvePromise = () => {
      if (this.settled) {
        return;
      }
      this.settled = true;
      resolvePromise?.();
    };
    this.rejectPromise = (error) => {
      if (this.settled) {
        return;
      }
      this.settled = true;
      rejectPromise?.(error);
    };
  }

  push(chunk: unknown): void {
    if (this.settled) {
      return;
    }

    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.buffer = `${this.buffer}${text.replace(/\r/g, "")}`;
    const fragmentIndex = this.buffer.indexOf(LISTENING_LOG_FRAGMENT);
    if (fragmentIndex >= 0) {
      const line = this.buffer.slice(fragmentIndex);
      const portMatch = LISTENING_PORT_PATTERN.exec(line);
      // A chunk can end inside the port number; wait for the rest of the line.
      if (this.expectedPort !== undefined && !portMatch && !line.includes("\n")) {
        return;
      }
      const port = portMatch ? Number(portMatch[1]) : undefined;
      if (this.expectedPort !== undefined && port !== undefined && port !== this.expectedPort) {
        this.rejectPromise(
          new Error(`backend is listening on port ${port}, expected ${this.expectedPort}`),
        );
        return;
      }
      this.resolvePromise();
      return;
    }

    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_CHARS);
    }
  }

  fail(error: unknown): void {
    this.rejectPromise(error);
  }
}
