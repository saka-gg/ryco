import { Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { OrchestrationStopBackgroundTaskInput } from "./orchestration.ts";
import { ProviderStopBackgroundTaskInput } from "./provider.ts";

it("preserves displayed runtime and attempt through both stop boundaries and accepts legacy calls", () => {
  for (const schema of [OrchestrationStopBackgroundTaskInput, ProviderStopBackgroundTaskInput]) {
    const decode = Schema.decodeUnknownSync(schema);
    const legacy = { threadId: "thread", taskId: "task" };
    expect(decode(legacy)).toEqual(legacy);
    const guarded = { ...legacy, expected: { runtimeSessionId: "runtime", attempt: 2 } };
    expect(decode(guarded)).toEqual(guarded);
    expect(() => decode({ ...legacy, expected: { runtimeSessionId: "", attempt: 0 } })).toThrow();
    expect(() =>
      decode({ ...legacy, expected: { runtimeSessionId: "runtime", attempt: -1 } }),
    ).toThrow();
  }
});
