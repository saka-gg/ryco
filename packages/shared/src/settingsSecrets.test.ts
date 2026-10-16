import {
  ClaudeSettings,
  CodexSettings,
  CopilotSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
} from "@ryco/contracts/settings";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  containsRedactedSettingSecret,
  PROVIDER_SECRET_CONFIG_KEYS,
  REDACTED_SETTING_SECRET,
  redactSettingSecret,
  redactUrlCredentials,
  resolveRedactedSettingValue,
  settingSecretAddress,
} from "./settingsSecrets.ts";

const MARK = REDACTED_SETTING_SECRET;

describe("redactUrlCredentials", () => {
  it("hides user info, query values and fragments but keeps the address", () => {
    expect(redactUrlCredentials("https://user:pass@collector.example:4318/v1/traces")).toBe(
      `https://${MARK}:${MARK}@collector.example:4318/v1/traces`,
    );
    expect(redactUrlCredentials("https://token@collector.example/v1")).toBe(
      `https://${MARK}@collector.example/v1`,
    );
    expect(redactUrlCredentials("https://collector.example/v1?api_key=abc&flag&region=eu")).toBe(
      `https://collector.example/v1?api_key=${MARK}&flag=&region=${MARK}`,
    );
    expect(redactUrlCredentials("https://collector.example/v1#access_token=abc")).toBe(
      `https://collector.example/v1#${MARK}`,
    );
  });

  it("hides the whole value of a non-URL that could carry credentials", () => {
    for (const value of ["opencode:pw@127.0.0.1:4096", "127.0.0.1:4096?token=abc", "h#frag"]) {
      expect(redactUrlCredentials(value)).toBe(MARK);
    }
  });

  it("binds secrets to a server address with loopback hosts interchangeable", () => {
    expect(settingSecretAddress("http://u:p@127.0.0.1:4096/x?y=1")).toBe("http://localhost:4096");
    expect(settingSecretAddress("http://localhost:4096")).toBe("http://localhost:4096");
    expect(settingSecretAddress("https://other.example")).toBe("https://other.example");
    expect(settingSecretAddress("")).toBe("");
    expect(settingSecretAddress(undefined)).toBe("");
  });

  it("returns URLs without credentials and non-URLs exactly as given", () => {
    for (const value of ["", "http://127.0.0.1:4096", "https://example.com/v1?flag", "not a url"]) {
      expect(redactUrlCredentials(value)).toBe(value);
    }
  });
});

describe("resolveRedactedSettingValue", () => {
  it("keeps the stored value for its redacted form, or the value itself when untouched", () => {
    expect(resolveRedactedSettingValue(MARK, ["secret"], redactSettingSecret)).toBe("secret");
    const url = "https://u:p@h.example/v1?k=v";
    expect(
      resolveRedactedSettingValue(redactUrlCredentials(url), [url], redactUrlCredentials),
    ).toBe(url);
    // The most specific stored value wins; empty candidates stand for nothing.
    expect(resolveRedactedSettingValue(MARK, ["", "legacy"], redactSettingSecret)).toBe("legacy");
    // A stored value that happens to hold the marker is kept when the patch leaves it alone.
    expect(resolveRedactedSettingValue(`x${MARK}`, [`x${MARK}`], redactSettingSecret)).toBe(
      `x${MARK}`,
    );
  });

  it("passes new values and clears through, and refuses markers with nothing behind them", () => {
    expect(resolveRedactedSettingValue("new", ["secret"], redactSettingSecret)).toBe("new");
    expect(resolveRedactedSettingValue("", ["secret"], redactSettingSecret)).toBe("");
    expect(resolveRedactedSettingValue(MARK, [""], redactSettingSecret)).toBeUndefined();
    expect(resolveRedactedSettingValue(MARK, [undefined], redactSettingSecret)).toBeUndefined();
    const edited = redactUrlCredentials("https://u:p@h.example/v1").replace("/v1", "/v2");
    expect(
      resolveRedactedSettingValue(edited, ["https://u:p@h.example/v1"], redactUrlCredentials),
    ).toBeUndefined();
    expect(containsRedactedSettingSecret(edited)).toBe(true);
  });
});

describe("PROVIDER_SECRET_CONFIG_KEYS", () => {
  it("covers every provider settings field the settings form treats as a password", () => {
    const schemas = [
      CodexSettings,
      ClaudeSettings,
      CursorSettings,
      CopilotSettings,
      GrokSettings,
      OpenCodeSettings,
    ];
    const passwordKeys = schemas.flatMap((schema) =>
      Object.entries(schema.fields).flatMap(([key, field]) => {
        const annotations =
          Schema.resolveAnnotationsKey(field as Schema.Top) ??
          Schema.resolveAnnotations(field as Schema.Top);
        return annotations?.providerSettingsForm?.control === "password" ? [key] : [];
      }),
    );
    expect(passwordKeys).toContain("serverPassword");
    for (const key of passwordKeys) expect(PROVIDER_SECRET_CONFIG_KEYS).toContain(key);
  });
});
