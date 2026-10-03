import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, BarChart3Icon } from "lucide-react";

import { useSettingsDialogStore } from "~/settingsDialogStore";
import { useSettingsTarget } from "~/settingsTarget";
import { parseStatisticsSearch } from "../statistics/statisticsSearch";

import { Button } from "../ui/button";
import { SettingsCard, SettingsEmpty, SettingsPageContainer } from "./settingsLayout";

export function StatisticsSettingsLink() {
  const navigate = useNavigate();
  const target = useSettingsTarget();
  const closeSettings = useSettingsDialogStore((state) => state.closeSettings);
  return (
    <SettingsPageContainer>
      <SettingsCard>
        <SettingsEmpty
          icon={<BarChart3Icon />}
          title="Statistics has its own page"
          description="Explore provider-recorded usage and Ryco-observed activity in the standalone dashboard."
          className="py-14"
          action={
            <Button
              size="sm"
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
          }
        />
      </SettingsCard>
    </SettingsPageContainer>
  );
}
