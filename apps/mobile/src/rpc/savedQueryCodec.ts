import * as Schema from "effect/Schema";

import type { SavedQueryCodec } from "./savedQueries";

/**
 * A saved-query codec from a contracts schema: the JSON form of the schema's
 * encoded side, so a saved answer decodes to exactly what the RPC returned.
 * The JSON codec is built on first use, off the launch path.
 */
export function schemaSavedQueryCodec<S extends Schema.Top>(
  schema: S,
  version: number,
): SavedQueryCodec<S["Type"]> {
  let codec: Schema.Codec<unknown, unknown> | null = null;
  const resolve = () =>
    (codec ??= Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>);
  return {
    version,
    encode: (data) => JSON.stringify(Schema.encodeUnknownSync(resolve())(data)),
    decode: (payload) => {
      try {
        return Schema.decodeUnknownSync(resolve())(JSON.parse(payload)) as S["Type"];
      } catch {
        return null;
      }
    },
  };
}
