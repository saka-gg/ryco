/** Whether `error` carries the given `_tag`, as the tagged errors an RPC rejects with do. */
export function hasErrorTag(error: unknown, tag: string): error is Record<string, unknown> {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;
}
