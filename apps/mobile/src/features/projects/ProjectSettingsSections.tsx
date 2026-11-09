import { projectRemoteChoices } from "@ryco/client-runtime/projectSettings/remotes";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { ProjectScript } from "@ryco/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { openWebLink } from "../../lib/openWebLink";
import { useThemeColor } from "../../lib/useThemeColor";
import { SettingsRow } from "../settings/components/SettingsRow";
import { ProjectSettingsSection, SectionMessage } from "./ProjectSettingsSection";
import {
  instructionsDraftView,
  PROJECT_SCRIPT_SYMBOLS,
  type ProjectCheckoutRow,
  type ProjectMissingMachine,
} from "./projectSettingsModel";

/** Where the project is checked out, and the machines that lack it ("Copy here"). */
export function ProjectMachinesSection(props: {
  readonly checkouts: readonly ProjectCheckoutRow[];
  readonly missing: readonly ProjectMissingMachine[];
  readonly onOpenCheckout: (checkout: ProjectCheckoutRow) => void;
  readonly onCopyHere: (machine: ProjectMissingMachine) => void;
}) {
  return (
    <ProjectSettingsSection
      section="devices"
      footer={
        props.checkouts.length > 1
          ? "Pick a machine to edit the project as it is there."
          : "Where this project is checked out."
      }
    >
      {props.checkouts.map((checkout, index) => (
        <SettingsRow
          key={checkout.key}
          first={index === 0}
          label={checkout.label}
          detail={`${checkout.path} · ${checkout.status}`}
          {...(checkout.current
            ? { value: "Editing" }
            : { onPress: () => props.onOpenCheckout(checkout) })}
        />
      ))}
      {props.missing.map((machine) => (
        <SettingsRow
          key={machine.environmentId}
          label={`Not on ${machine.label}`}
          value="Copy here"
          onPress={() => props.onCopyHere(machine)}
        />
      ))}
    </ProjectSettingsSection>
  );
}

/** Where the project lives on its machine; changing it re-points the project, files stay. */
export function ProjectLocationSection(props: {
  readonly cwd: string;
  readonly machineLabel: string;
  readonly canEdit: boolean;
  readonly error: string | null;
  readonly onChangeRoot: () => void;
}) {
  return (
    <ProjectSettingsSection
      section="location"
      footer={`The folder on ${props.machineLabel} tasks run in. Changing it re-points the project; nothing on disk moves.`}
    >
      <SettingsRow
        first
        label="Project root"
        detail={props.cwd}
        {...(props.canEdit ? { onPress: props.onChangeRoot } : {})}
      />
      {props.error ? <SectionMessage tone="danger" message={props.error} /> : null}
    </ProjectSettingsSection>
  );
}

/**
 * The checkout's git remotes and which one is primary: pull requests and links use it.
 * Auto-detect follows the machine's choice (upstream, then origin, then the first).
 */
export function ProjectRepositorySection(props: {
  readonly project: Pick<Project, "repositoryIdentity" | "preferredRemoteName">;
  /** Whether the folder is a git repository, once known (only asked when it has no remotes). */
  readonly isRepo: boolean | null;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChoose: (remoteName: string | null) => void;
  readonly onInitializeGit: () => void;
}) {
  const choices = projectRemoteChoices(props.project);
  const iconColor = useThemeColor("--color-icon");
  if (choices.remotes.length === 0) {
    const notARepository = props.isRepo === false;
    return (
      <ProjectSettingsSection section="repository">
        <SettingsRow
          first
          label={notARepository ? "Not a git repository" : "No remote"}
          detail={
            notARepository
              ? "Initialize git to track changes, create worktrees and open pull requests."
              : "Add a remote to the repository to open it in the browser and review its pull requests."
          }
        />
        {notARepository ? (
          <SettingsRow
            label={props.busy ? "Initializing…" : "Initialize git"}
            disabled={!props.canEdit || props.busy}
            onPress={props.onInitializeGit}
          />
        ) : null}
        {props.error ? <SectionMessage tone="danger" message={props.error} /> : null}
      </ProjectSettingsSection>
    );
  }
  return (
    <ProjectSettingsSection
      section="repository"
      footer={
        choices.choosable ? "The primary remote is the one pull requests and links use." : null
      }
    >
      {choices.choosable ? (
        <RadioRow
          first
          label="Auto-detect"
          detail={choices.autoRemoteName ? `Currently ${choices.autoRemoteName}` : undefined}
          selected={choices.preferred === null}
          disabled={!props.canEdit}
          onPress={() => props.onChoose(null)}
        />
      ) : null}
      {choices.remotes.map((remote, index) => (
        <View
          key={remote.name}
          className={`flex-row items-center ${!choices.choosable && index === 0 ? "" : "border-t border-border-subtle"}`}
        >
          <View className="min-w-0 flex-1">
            {choices.choosable ? (
              <RadioRow
                first
                label={remote.name}
                detail={remote.location}
                selected={remote.selected}
                disabled={!props.canEdit}
                onPress={() => props.onChoose(remote.name)}
              />
            ) : (
              <SettingsRow first label={remote.name} detail={remote.location} />
            )}
          </View>
          {remote.browserUrl ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open ${remote.name} in the browser`}
              hitSlop={6}
              onPress={() => openWebLink(remote.browserUrl)}
              className="mr-3 h-11 w-11 items-center justify-center rounded-full active:bg-subtle"
            >
              <SymbolView
                name="arrow.up.right"
                size={16}
                tintColor={iconColor as string}
                type="monochrome"
              />
            </Pressable>
          ) : null}
        </View>
      ))}
      {props.error ? <SectionMessage tone="danger" message={props.error} /> : null}
    </ProjectSettingsSection>
  );
}

function RadioRow(props: {
  readonly label: string;
  readonly detail: string | undefined;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly first?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`flex-row items-center gap-3 px-5 py-3.5 active:bg-subtle ${props.first ? "" : "border-t border-border-subtle"}`}
    >
      <View className="min-w-0 flex-1">
        <Text className="font-sans text-[17px] text-foreground">{props.label}</Text>
        {props.detail ? (
          <Text
            className="mt-0.5 font-mono text-xs leading-4 text-foreground-muted"
            numberOfLines={1}
          >
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView name="checkmark" size={16} tintColor={iconColor as string} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

/** The project's actions (scripts): what each runs, and which one sets up new worktrees. */
export function ProjectActionsSection(props: {
  readonly scripts: readonly ProjectScript[];
  readonly canEdit: boolean;
  readonly onEdit: (script: ProjectScript) => void;
  readonly onAdd: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <ProjectSettingsSection
      section="actions"
      footer="Commands you run in this project: tests, a dev server, a build. The setup action runs once on every new worktree."
    >
      {props.scripts.map((script, index) => (
        <Pressable
          key={script.id}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${script.name}`}
          disabled={!props.canEdit}
          onPress={() => props.onEdit(script)}
          className={`flex-row items-center gap-3 px-5 py-3 active:bg-subtle ${index === 0 ? "" : "border-t border-border-subtle"}`}
        >
          <View className="h-8 w-8 items-center justify-center rounded-lg bg-subtle">
            <SymbolView
              name={PROJECT_SCRIPT_SYMBOLS[script.icon]}
              size={15}
              tintColor={iconColor as string}
              type="monochrome"
            />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 shrink text-[17px] text-foreground" numberOfLines={1}>
                {script.name}
              </Text>
              {script.runOnWorktreeCreate ? (
                <View className="rounded-md bg-subtle px-1.5 py-0.5">
                  <Text className="text-[11px] text-foreground-muted">setup</Text>
                </View>
              ) : null}
            </View>
            <Text className="mt-0.5 font-mono text-xs text-foreground-muted" numberOfLines={1}>
              {script.command}
            </Text>
          </View>
        </Pressable>
      ))}
      <SettingsRow
        first={props.scripts.length === 0}
        label="Add action"
        disabled={!props.canEdit}
        onPress={props.onAdd}
      />
    </ProjectSettingsSection>
  );
}

/**
 * Instructions appended to every agent prompt in this project. A draft is held here; Save and
 * Revert appear only while it differs from the saved text.
 */
export function ProjectInstructionsSection(props: {
  readonly saved: string | null | undefined;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSave: (next: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const view = instructionsDraftView(props.saved, draft);
  const save = () => {
    void props.onSave(view.next).then((saved) => {
      if (saved) setDraft(null);
    });
  };
  return (
    <ProjectSettingsSection
      section="instructions"
      footer="Appended to every agent prompt in this project, on this machine."
    >
      <View className="px-5 py-3">
        <AppTextInput
          accessibilityLabel="Agent instructions"
          value={view.value}
          editable={props.canEdit && !props.busy}
          multiline
          maxLength={view.max}
          placeholder="Prefer Effect Schema over zod. Run bun run test before committing."
          textAlignVertical="top"
          onChangeText={setDraft}
          className="min-h-36 text-sm"
        />
        <Text
          className={`mt-1.5 text-right text-[11px] ${
            view.counterTone === "danger"
              ? "text-danger-foreground"
              : view.counterTone === "warning"
                ? "text-warning"
                : "text-foreground-tertiary"
          }`}
        >
          {view.counter}
        </Text>
      </View>
      {props.error ? <SectionMessage tone="danger" message={props.error} /> : null}
      {view.dirty ? (
        <View className="flex-row justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            onPress={() => setDraft(null)}
            className="h-11 justify-center rounded-full px-4 active:bg-subtle disabled:opacity-40"
          >
            <Text className="text-sm font-ryco-bold text-foreground">Revert</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!props.canEdit || props.busy}
            onPress={save}
            className="h-11 justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">
              {props.busy ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ProjectSettingsSection>
  );
}

/** Removing the project from its machine: its tasks (with their history) go, files stay. */
export function ProjectDangerSection(props: {
  readonly machineLabel: string;
  readonly threadCount: number;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onRemove: () => void;
}) {
  return (
    <ProjectSettingsSection section="danger">
      <SettingsRow
        first
        destructive
        label={props.busy ? "Removing…" : `Remove from ${props.machineLabel}`}
        detail={
          props.threadCount > 0
            ? `Deletes its ${props.threadCount} task${props.threadCount === 1 ? "" : "s"} and their history. Files on disk are not touched.`
            : "Removes the project entry. Files on disk are not touched."
        }
        disabled={!props.canEdit || props.busy}
        onPress={props.onRemove}
      />
      {props.error ? <SectionMessage tone="danger" message={props.error} /> : null}
    </ProjectSettingsSection>
  );
}
