import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, BarChart3Icon } from "lucide-react";

import { useSettingsDialogStore } from "~/settingsDialogStore";
import { useSettingsTarget } from "~/settingsTarget";
import { parseStatisticsSearch } from "../statistics/statisticsSearch";

import { Button } from "../ui/button";
import { SettingsPageContainer } from "./settingsLayout";

export function StatisticsSettingsLink() {
  const navigate = useNavigate();
  const target = useSettingsTarget();
  const closeSettings = useSettingsDialogStore((state) => state.closeSettings);
  return (
    <SettingsPageContainer>
      <div className="flex min-h-72 items-center justify-center">
        <div className="max-w-lg rounded-2xl border border-border/75 bg-card p-7 text-center shadow-sm/5">
          <div className="mx-auto flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <BarChart3Icon className="size-5" />
          </div>
          <h1 className="mt-4 text-lg font-semibold tracking-tight">
            Statistics has more room now
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Explore provider-recorded Usage and Ryco-observed Activity in the standalone dashboard.
          </p>
          <Button
            className="mt-5"
            onClick={() => {
              closeSettings();
              void navigate({
                to: "/statistics",
                search: parseStatisticsSearch(
                  target ? { environmentIds: [target.environmentId] } : {},
                ),
              });
            }}
          >
            Open Statistics <ArrowUpRightIcon />
          </Button>
        </div>
      </div>
    </SettingsPageContainer>
  );
}
