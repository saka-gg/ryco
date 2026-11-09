"use client";

import { useMemo, type ReactNode } from "react";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  providerSettingsTextFieldDisplay,
  readProviderConfigBoolean,
  readProviderConfigString,
  type ProviderSettingsFieldModel,
} from "@ryco/client-runtime/state/settings/providerSettingsFields";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { ProviderClientDefinition } from "./providerDriverMeta";
import { SettingsSelect } from "./SettingsSelect";

interface ProviderSettingsFormProps {
  readonly definition: ProviderClientDefinition;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div className="border-t border-border/60 px-4 py-3 sm:px-5">{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "card"
      ? "mt-1 block text-xs text-muted-foreground"
      : "text-[11px] text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  const description = field.description ? (
    <span className={descriptionClassName}>{field.description}</span>
  ) : null;

  if (field.control === "switch") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          <Switch
            checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
            onCheckedChange={(checked) =>
              onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
            }
            aria-label={field.label}
          />
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "select") {
    const stored = readProviderConfigString(value, field.key);
    // An unset key shows the default; a value this client does not offer shows no choice.
    return (
      <FieldFrame variant={variant}>
        <div>
          {label}
          <SettingsSelect
            className={cn(variant === "card" && "mt-1.5")}
            value={stored === "" ? field.defaultStringValue : stored}
            onValueChange={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
            options={field.options ?? []}
            ariaLabel={field.label}
            width="full"
          />
          {description}
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "textarea") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <Textarea
            id={inputId}
            className={cn(variant === "card" && "mt-1.5")}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  const type = field.control === "password" ? "password" : undefined;
  const display = providerSettingsTextFieldDisplay(
    field,
    readProviderConfigString(value, field.key),
  );
  // An empty input over a saved secret keeps it; only "Clear" removes it.
  const commit = (next: string) => {
    if (display.savedSecret && next.length === 0) return;
    onChange(nextProviderConfigWithFieldValue(value, field, next));
  };
  const placeholder = display.savedSecret
    ? "Saved - enter a new value to replace"
    : field.placeholder;
  const savedSecretNote = display.savedSecret ? (
    <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span>A value is saved.</span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => onChange(nextProviderConfigWithFieldValue(value, field, ""))}
        aria-label={`Clear ${field.label}`}
      >
        Clear
      </Button>
    </span>
  ) : null;
  const hiddenCredentialsNote = display.hiddenCredentials ? (
    <span className={descriptionClassName}>
      Credentials in this URL are hidden. To change the URL, enter it again in full.
    </span>
  ) : null;
  return (
    <FieldFrame variant={variant}>
      <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
        {label}
        {variant === "card" ? (
          <DraftInput
            id={inputId}
            className="mt-1.5"
            type={type}
            autoComplete={field.control === "password" ? "off" : undefined}
            value={display.inputValue}
            onCommit={commit}
            placeholder={placeholder}
            spellCheck={false}
          />
        ) : (
          <Input
            id={inputId}
            className="bg-background"
            type={type}
            autoComplete={field.control === "password" ? "off" : undefined}
            value={display.inputValue}
            onChange={(event) => commit(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
        )}
        {description}
        {hiddenCredentialsNote}
      </label>
      {savedSecretNote}
    </FieldFrame>
  );
}

export function ProviderSettingsForm({
  definition,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(() => deriveProviderSettingsFields(definition), [definition]);

  if (fields.length === 0) {
    return null;
  }

  return (
    <>
      {fields.map((field) => (
        <ProviderSettingsFieldRow
          key={field.key}
          field={field}
          value={value}
          idPrefix={idPrefix}
          variant={variant}
          onChange={onChange}
        />
      ))}
    </>
  );
}
