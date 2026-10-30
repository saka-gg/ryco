import { useShallow } from "zustand/react/shallow";
import { useSettingsTarget, useSettingsEditingScope } from "../../settingsTarget";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { openProjectImportDialog } from "../projectImport/projectImportDialogStore";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SessionImportPanel } from "./SessionImportPanel";
import { useSessionImportAccess } from "./sessionImportAccess";
import { excludeChatProjects } from "@ryco/shared/projectKind";
export function SessionImportSettings() {
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const tier = usePresentationTier();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const { allowed, client } = useSessionImportAccess(target);
  if (tier === "phone" || scope === "client" || !target) return null;
  return (
    <SettingsSection
      title="Import conversations"
      description={`Bring Codex or Claude Code history from ${target.nodeLabel} into Ryco. New turns continue in separate native session copies.`}
      owner="node"
    >
      <SettingsRow
        title="Whole projects"
        description="Find every Codex and Claude Code project on this node, grouped by folder, and create the Ryco projects they need."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!allowed}
            onClick={() => openProjectImportDialog({ environmentId: target.environmentId })}
          >
            Import projects…
          </Button>
        }
      />
      <SessionImportPanel
        key={target.environmentId}
        nodeLabel={target.nodeLabel}
        allowed={allowed}
        // Imports land in a real project; chats are not import targets.
        projects={excludeChatProjects(projects).filter(
          (project) => project.environmentId === target.environmentId,
        )}
        providerOptions={target.serverConfig?.providers ?? []}
        client={client}
      />
    </SettingsSection>
  );
}
