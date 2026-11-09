import type {
  ProviderSettingsFormAnnotation,
  ProviderSettingsFormControl,
  ProviderSettingsFormSchemaAnnotation,
} from "@ryco/contracts";
import {
  containsRedactedSettingSecret,
  REDACTED_SETTING_SECRET,
} from "@ryco/shared/settingsSecrets";
import * as Schema from "effect/Schema";

import type { ProviderDriverDefinition } from "./providerDrivers.ts";

type FieldSchema = ProviderDriverDefinition["settingsSchema"]["fields"][string];

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly defaultBooleanValue?: boolean | undefined;
  /** A select's choices, and the value it shows while the key is unset. */
  readonly options?: NonNullable<ProviderSettingsFormAnnotation["options"]> | undefined;
  readonly defaultStringValue?: string | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readFieldAnnotations(fieldSchema: FieldSchema) {
  return Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
}

function readFieldAnnotationString(
  fieldSchema: FieldSchema,
  key: "title" | "description",
): string | undefined {
  const annotations = readFieldAnnotations(fieldSchema);
  const value = annotations?.[key];
  return typeof value === "string" ? value : undefined;
}

function readProviderSettingsFormAnnotation(
  fieldSchema: FieldSchema,
): ProviderSettingsFormAnnotation {
  const annotation = readFieldAnnotations(fieldSchema)?.providerSettingsForm;
  return annotation ?? {};
}

function readProviderSettingsFormSchemaAnnotation(
  definition: Pick<ProviderDriverDefinition, "settingsSchema">,
): ProviderSettingsFormSchemaAnnotation {
  return Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
}

function readFieldDefault(fieldSchema: FieldSchema): unknown {
  try {
    return Schema.decodeUnknownSync(fieldSchema as Schema.Decoder<unknown>)(undefined);
  } catch {
    return undefined;
  }
}

function readFieldBooleanDefault(fieldSchema: FieldSchema): boolean | undefined {
  const decoded = readFieldDefault(fieldSchema);
  return typeof decoded === "boolean" ? decoded : undefined;
}

function readFieldStringDefault(fieldSchema: FieldSchema): string | undefined {
  const decoded = readFieldDefault(fieldSchema);
  return typeof decoded === "string" ? decoded : undefined;
}

export function deriveProviderSettingsFields(
  definition: Pick<ProviderDriverDefinition, "settingsSchema">,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const schemaAnnotation = readProviderSettingsFormSchemaAnnotation(definition);
  const orderedKeys = new Map(
    (schemaAnnotation.order ?? []).map((key, index) => [key, index] as const),
  );
  const orderFallbackOffset = orderedKeys.size;

  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) => {
      return (
        (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index)
      );
    })
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const formAnnotation = readProviderSettingsFormAnnotation(fieldSchema);
      if (formAnnotation.hidden) return [];

      const annotatedTitle = readFieldAnnotationString(fieldSchema, "title");
      const annotatedDescription = readFieldAnnotationString(fieldSchema, "description");
      return [
        {
          key,
          control: formAnnotation.control ?? "text",
          label: annotatedTitle ?? titleizeFieldKey(key),
          ...(annotatedDescription !== undefined ? { description: annotatedDescription } : {}),
          ...(formAnnotation.placeholder !== undefined
            ? { placeholder: formAnnotation.placeholder }
            : {}),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : {}),
          ...(formAnnotation.control === "select"
            ? {
                options: formAnnotation.options ?? [],
                defaultStringValue: readFieldStringDefault(fieldSchema),
              }
            : {}),
        } satisfies ProviderSettingsFieldModel,
      ];
    });
}

export function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function readProviderConfigBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  if (config === null || typeof config !== "object") return defaultValue;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : defaultValue;
}

/**
 * How a text field shows its value. The server never sends secrets: a saved
 * password arrives as the redaction marker and is shown as "saved" with an
 * empty input (typing replaces it, an empty input keeps it), and a URL whose
 * credentials were hidden is flagged so the user knows to enter it in full.
 */
export function providerSettingsTextFieldDisplay(
  field: Pick<ProviderSettingsFieldModel, "control">,
  value: string,
): {
  readonly inputValue: string;
  readonly savedSecret: boolean;
  readonly hiddenCredentials: boolean;
} {
  const savedSecret = field.control === "password" && value === REDACTED_SETTING_SECRET;
  return {
    inputValue: savedSecret ? "" : value,
    savedSecret,
    hiddenCredentials: !savedSecret && containsRedactedSettingSecret(value),
  };
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "boolean") {
    const emptyBooleanValue = field.defaultBooleanValue ?? false;
    if (field.clearWhenEmpty === "omit" && value === emptyBooleanValue) {
      delete base[field.key];
    } else {
      base[field.key] = value;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const trimmed = value.trim();
  if (
    field.clearWhenEmpty === "omit" &&
    (trimmed.length === 0 || trimmed === field.defaultStringValue)
  ) {
    delete base[field.key];
  } else {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}
