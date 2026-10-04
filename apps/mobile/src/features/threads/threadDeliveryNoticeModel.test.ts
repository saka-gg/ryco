import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  acknowledgeThreadDelivery,
  buildThreadDeliveryNotice,
  selectThreadDeliveryRecord,
  type ThreadDeliveryRecord,
} from "./threadDeliveryNoticeModel";

const studio = "env-studio" as EnvironmentId;
const laptop = "env-laptop" as EnvironmentId;

function record(
  environmentId: EnvironmentId,
  overrides: Partial<ThreadDeliveryRecord> = {},
): ThreadDeliveryRecord {
  return {
    environmentId,
    label: environmentId === studio ? "Studio Mac" : "Laptop",
    sessionStatus: "ready",
    sessionRecoveredAfterUnknown: false,
    ...overrides,
  };
}

describe("thread delivery notice", () => {
  it("shows only for the thread's own machine", () => {
    const records = [
      record(studio, { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: true }),
      record(laptop),
    ];

    expect(buildThreadDeliveryNotice(selectThreadDeliveryRecord(records, laptop))).toBeNull();
    const notice = buildThreadDeliveryNotice(selectThreadDeliveryRecord(records, studio));
    expect(notice).toMatchObject({ canAcknowledge: true, actionLabel: "Continue" });
    expect(notice?.description).toContain("Studio Mac");
  });

  it("waits for the replacement session before it can be continued", () => {
    expect(
      buildThreadDeliveryNotice(
        record(studio, { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false }),
      ),
    ).toMatchObject({ canAcknowledge: false });
  });

  it("is absent for a machine with no hosted record", () => {
    expect(selectThreadDeliveryRecord([], studio)).toBeNull();
    expect(buildThreadDeliveryNotice(null)).toBeNull();
  });

  it("selects the same record object so unrelated publishes do not re-render", () => {
    const studioRecord = record(studio);
    expect(selectThreadDeliveryRecord([record(laptop), studioRecord], studio)).toBe(studioRecord);
  });

  it("acknowledges through the machine's own record", () => {
    const coordinator = { acknowledgeDeliveryUnknown: vi.fn() };
    acknowledgeThreadDelivery(coordinator, laptop);
    expect(coordinator.acknowledgeDeliveryUnknown).toHaveBeenCalledWith(laptop);
  });
});
