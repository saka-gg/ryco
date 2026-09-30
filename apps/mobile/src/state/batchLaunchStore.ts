import {
  createBatchLaunchStore,
  createBatchSourceDraftStore,
} from "@ryco/client-runtime/state/composer";
import { mobileKV } from "../platform/kv";
import { newThreadId } from "../lib/ids";

export const batchLaunchStore = createBatchLaunchStore(mobileKV);

export const batchSourceDraftStore = createBatchSourceDraftStore(mobileKV, {
  isSourceReleased: batchLaunchStore.isSourceReleased,
  newSourceId: newThreadId,
});
