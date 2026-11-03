import { usageSummaryCache } from "@ryco/client-runtime/usage";
import { WS_METHODS, type UsagePriceOverrides } from "@ryco/contracts";
import { CircleDollarSignIcon, LoaderIcon, PlusIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { cn } from "../../lib/utils";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import {
  SETTINGS_INSET_CLASS,
  SettingsEmpty,
  SettingsNotice,
  SettingsSection,
} from "./settingsLayout";
import { isNodeSettingsTargetReadOnly } from "./settingsSections.logic";
import {
  listsUsagePriceModel,
  resolveUsagePriceDrafts,
  upsertUsagePriceDraft,
  USAGE_PRICE_FIELDS,
  type UsagePriceDraft,
  type UsagePriceField,
  type UsagePriceMode,
  type UsagePriceRow,
} from "./usagePriceSettings.logic";
import {
  takeUsagePriceRow,
  USAGE_PRICE_SECTION_TITLE,
  useUsagePriceRowRequestStore,
  type UsagePriceRowRequest,
} from "./usagePriceSettingsRequest";

const NO_OVERRIDES: UsagePriceOverrides = {};

const MODE_OPTIONS: ReadonlyArray<SettingsSelectOption<UsagePriceMode>> = [
  { value: "price", label: "Price" },
  { value: "map", label: "Map to" },
];

type SaveStatus =
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly message: string }
  | null;

/**
 * Custom model prices and model mappings for this node's usage cost (node settings). Disabled
 * unless the node advertises them: an older node would silently drop the key. Not part of the
 * frozen web phone tier, which has no usage view either.
 */
export function UsagePriceSettings() {
  const target = useSettingsTarget();
  // Unsaved edits belong to the node they were made on.
  return <UsagePriceEditor key={target?.environmentId ?? ""} />;
}

function UsagePriceEditor() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const environmentId = target?.environmentId ?? null;
  const settingsCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings, environmentId);
  const saved = config?.settings.usagePriceOverrides ?? NO_OVERRIDES;
  const unsupported =
    config !== null && config.environment.capabilities.usagePriceOverrides !== true;
  const disabled =
    config === null ||
    unsupported ||
    target === null ||
    isNodeSettingsTargetReadOnly(scope, target) ||
    !settingsCapability.allowed;

  const [drafts, setDrafts] = useState<readonly UsagePriceDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveStatus>(null);
  const nextRowId = useRef(0);
  // The row "Add model" created: its model ID field takes focus when it mounts.
  const [addedRowId, setAddedRowId] = useState<string | null>(null);
  const { rows, patch, errors, limitError, blocked } = resolveUsagePriceDrafts(saved, drafts);
  const changeCount = Object.keys(patch).length;

  // "Set prices" on the Usage page asks for a row for its model on this node.
  const request = useUsagePriceRowRequestStore((state) => state.request);
  const [takenRequest, setTakenRequest] = useState<UsagePriceRowRequest | null>(null);
  if (
    request !== null &&
    request !== takenRequest &&
    config !== null &&
    request.environmentId === environmentId
  ) {
    setTakenRequest(request);
    if (!disabled && !listsUsagePriceModel(rows, request.model)) {
      setDrafts([
        ...drafts,
        { id: `requested:${request.serial}`, model: request.model, isNew: true },
      ]);
    }
  }
  useEffect(() => {
    if (takenRequest !== null) takeUsagePriceRow(takenRequest);
  }, [takenRequest]);

  const editable = !disabled && !saving;
  const draftFor = (row: UsagePriceRow): UsagePriceDraft =>
    drafts.find((draft) => draft.id === row.id) ?? {
      id: row.id,
      model: row.model,
      isNew: row.isNew,
    };
  const edit = (row: UsagePriceRow, change: Partial<Omit<UsagePriceDraft, "id" | "isNew">>) => {
    setStatus(null);
    setDrafts(upsertUsagePriceDraft(drafts, { ...draftFor(row), ...change }));
  };
  const dropDraft = (row: UsagePriceRow) => {
    setStatus(null);
    setDrafts(drafts.filter((draft) => draft.id !== row.id));
  };
  const addRow = () => {
    const id = `new:${nextRowId.current++}`;
    setAddedRowId(id);
    setStatus(null);
    setDrafts([...drafts, { id, model: "", isNew: true }]);
  };

  const save = () => {
    if (environmentId === null || blocked || changeCount === 0) return;
    setSaving(true);
    setStatus(null);
    void updateEnvironmentServerSettings(environmentId, { usagePriceOverrides: patch }).then(
      () => {
        // Summaries the client kept were priced before: the next view asks the node again.
        usageSummaryCache.forget(environmentId);
        setSaving(false);
        setDrafts([]);
        setStatus({ kind: "saved" });
      },
      (cause: unknown) => {
        setSaving(false);
        setStatus({
          kind: "failed",
          message: cause instanceof Error ? cause.message : "Could not save the prices. Try again.",
        });
      },
    );
  };

  return (
    <SettingsSection
      title={USAGE_PRICE_SECTION_TITLE}
      owner="node"
      description="Prices in USD per million tokens for models without published rates, such as preview IDs or models behind a gateway, or a model to count an ID as. They apply to all of this node's usage history at every speed, in place of provider-reported cost. A blank cache price charges the input price; 0 is free."
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!editable}
          onClick={addRow}
          aria-label="Add model price"
        >
          <PlusIcon />
          Add model
        </Button>
      }
    >
      {unsupported ? (
        <div className={cn("border-b border-border/60 py-3", SETTINGS_INSET_CLASS)}>
          <SettingsNotice tone="warning">
            Update Ryco on this node to set custom model prices.
          </SettingsNotice>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <SettingsEmpty
          icon={<CircleDollarSignIcon />}
          title="No custom prices"
          description="Usage cost uses published API rates. Add a model to price it yourself or to count it as another model."
        />
      ) : (
        <ul aria-label="Custom model prices">
          {rows.map((row) => (
            <UsagePriceRowEditor
              key={row.id}
              row={row}
              error={errors.get(row.id)}
              disabled={!editable}
              autoFocus={row.id === addedRowId}
              onModel={(model) => edit(row, { model })}
              onMode={(mode) => edit(row, { mode })}
              onPrice={(field, value) =>
                edit(row, { prices: { ...draftFor(row).prices, [field]: value } })
              }
              onMapTo={(mapTo) => edit(row, { mapTo })}
              onRemove={() => (row.isNew ? dropDraft(row) : edit(row, { removed: true }))}
              onRestore={() => dropDraft(row)}
            />
          ))}
        </ul>
      )}
      {limitError || status?.kind === "failed" ? (
        <div className={cn("border-t border-border/60 py-3", SETTINGS_INSET_CLASS)}>
          <SettingsNotice tone="error">
            {status?.kind === "failed" ? status.message : limitError}
          </SettingsNotice>
        </div>
      ) : null}
      {drafts.length > 0 || status?.kind === "saved" ? (
        <div
          className={cn(
            "flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 py-3",
            SETTINGS_INSET_CLASS,
          )}
        >
          {status?.kind === "saved" ? (
            <p role="status" className="mr-auto text-xs text-muted-foreground">
              Saved. Usage cost on this node uses these prices now.
            </p>
          ) : null}
          {drafts.length > 0 ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setStatus(null);
                  setDrafts([]);
                }}
              >
                Discard
              </Button>
              <Button size="xs" disabled={!editable || blocked || changeCount === 0} onClick={save}>
                {saving ? <LoaderIcon className="animate-spin" /> : null}
                Save prices
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function UsagePriceRowEditor(props: {
  readonly row: UsagePriceRow;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly autoFocus: boolean;
  readonly onModel: (model: string) => void;
  readonly onMode: (mode: UsagePriceMode) => void;
  readonly onPrice: (field: UsagePriceField, value: string) => void;
  readonly onMapTo: (mapTo: string) => void;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
}) {
  const { row, disabled } = props;
  const name = row.model.trim() || "new model";
  return (
    <li
      data-slot="usage-price-row"
      className={cn(
        "min-w-0 border-t border-border/60 py-3 first:border-t-0",
        SETTINGS_INSET_CLASS,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          {row.isNew ? (
            <Input
              autoFocus={props.autoFocus}
              size="sm"
              value={row.model}
              onChange={(event) => props.onModel(event.target.value)}
              aria-label="New model ID"
              aria-invalid={props.error === undefined ? undefined : true}
              placeholder="Model ID as recorded, e.g. claude-opus-5-preview"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={disabled}
            />
          ) : (
            <p
              className={cn(
                "truncate font-mono text-xs",
                row.removed && "text-muted-foreground line-through",
              )}
              title={row.model}
            >
              {row.model}
            </p>
          )}
        </div>
        {row.removed ? (
          <>
            <span className="shrink-0 text-xs text-muted-foreground">Removed when saved</span>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={props.onRestore}
              aria-label={`Keep ${name}`}
            >
              <Undo2Icon />
              Undo
            </Button>
          </>
        ) : (
          <>
            <SettingsSelect
              value={row.form.mode}
              onValueChange={props.onMode}
              options={MODE_OPTIONS}
              ariaLabel={`How to price ${name}`}
              disabled={disabled}
              width="sm"
              size="sm"
              className="w-28 sm:w-28"
            />
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={props.onRemove}
              aria-label={`Remove ${name}`}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </>
        )}
      </div>
      {row.removed ? null : row.form.mode === "map" ? (
        <div className="mt-2">
          <Input
            size="sm"
            value={row.form.mapTo}
            onChange={(event) => props.onMapTo(event.target.value)}
            aria-label={`Count ${name} as`}
            placeholder="Model ID to count it as and price it like, e.g. claude-opus-4-1"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
          />
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {USAGE_PRICE_FIELDS.map((field) => (
            <label key={field.key} className="grid min-w-0 gap-1">
              <span className="text-[11px] text-muted-foreground">{field.label}</span>
              <Input
                size="sm"
                inputMode="decimal"
                value={row.form.prices[field.key]}
                onChange={(event) => props.onPrice(field.key, event.target.value)}
                aria-label={`${field.label} price of ${name}`}
                placeholder={field.optional ? "Input price" : "0.00"}
                autoComplete="off"
                disabled={disabled}
              />
            </label>
          ))}
        </div>
      )}
      {props.error === undefined ? null : (
        <p
          role={row.edited ? "alert" : undefined}
          className="mt-1.5 text-xs text-destructive-foreground"
        >
          {props.error}
        </p>
      )}
    </li>
  );
}
