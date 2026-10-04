type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BoundedJsonResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly value: unknown;
}

export type BoundedJsonFailure =
  | { readonly kind: "transport" }
  | { readonly kind: "invalid_response"; readonly status: number };

export async function fetchBoundedJson(
  fetchImplementation: FetchLike,
  input: string | URL | Request,
  init: RequestInit,
  fail: (failure: BoundedJsonFailure) => never,
  options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {},
): Promise<BoundedJsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const maximum = options.maxResponseBytes ?? 16 * 1024;
  let response: Response;
  try {
    response = await fetchImplementation(input, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    return fail({ kind: "transport" });
  }
  try {
    const invalid = (): never => fail({ kind: "invalid_response", status: response.status });
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
        await response.body?.cancel().catch(() => undefined);
        return invalid();
      }
    }
    if (response.body === null) return invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let oversized = false;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maximum) {
          await reader.cancel().catch(() => undefined);
          oversized = true;
          break;
        }
        chunks.push(result.value);
      }
    } catch {
      return fail({ kind: "transport" });
    } finally {
      reader.releaseLock();
    }
    if (oversized) return invalid();
    let value: unknown;
    try {
      value = JSON.parse(
        Buffer.concat(
          chunks.map((chunk) => Buffer.from(chunk)),
          total,
        ).toString("utf8"),
      ) as unknown;
    } catch {
      return invalid();
    }
    return { ok: response.ok, status: response.status, value };
  } finally {
    clearTimeout(timeout);
  }
}
