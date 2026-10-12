import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@ryco/contracts";
import { useEffect, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { SettingsTargetProvider, type SettingsTarget } from "../../settingsTarget";
import { ProviderInstanceCard } from "./ProviderInstanceCard";

type Environment = ReadonlyArray<ProviderInstanceEnvironmentVariable>;

const INVALID_NAME_ERROR =
  "Names may only use letters, digits, and underscores, and cannot start with a digit.";

const nodeTarget = (environmentId: string): SettingsTarget => ({
  environmentId: EnvironmentId.make(environmentId),
  nodeLabel: environmentId,
  serverConfig: null,
  primary: false,
  connected: true,
});

/** Renders the real card over local instance state, like the settings panel does. */
async function mountCard(environment: Environment) {
  const published: Environment[] = [];
  const server = {
    setEnvironment: (_environment: Environment) => {},
    switchNode: (_target: SettingsTarget, _environment: Environment) => {},
  };
  function Harness() {
    const [target, setTarget] = useState<SettingsTarget | null>(null);
    const [instance, setInstance] = useState<ProviderInstanceConfig>({
      driver: ProviderDriverKind.make("forkDriver"),
      environment,
    });
    useEffect(() => {
      server.setEnvironment = (next) =>
        setInstance((current) => ({ ...current, environment: next }));
      server.switchNode = (nextTarget, next) => {
        setTarget(nextTarget);
        setInstance((current) => ({ ...current, environment: next }));
      };
    }, []);
    return (
      <SettingsTargetProvider value={target}>
        <ProviderInstanceCard
          instanceId={ProviderInstanceId.make("fork_instance")}
          instance={instance}
          driverOption={undefined}
          liveProvider={undefined}
          isDefault={false}
          onUpdate={(next) => {
            published.push(next.environment ?? []);
            setInstance(next);
          }}
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={() => {}}
          onFavoriteModelsChange={() => {}}
          onModelOrderChange={() => {}}
        />
      </SettingsTargetProvider>
    );
  }
  await render(<Harness />);
  return { published, server };
}

const nameInput = (row: number) =>
  page.getByLabelText(`Environment variable name ${row}`, { exact: true });
const valueInput = (row: number) =>
  page.getByLabelText(`Environment variable value ${row}`, { exact: true });

async function commit(input: ReturnType<typeof nameInput>, text: string) {
  await input.fill(text);
  await userEvent.keyboard("{Enter}");
}

/** Returns whether the browser's default paste would still run. */
function paste(input: ReturnType<typeof nameInput>, text: string): boolean {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  return input
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
}

describe("ProviderInstanceCard environment variables", () => {
  it("publishes valid rows while incomplete rows show their errors inline", async () => {
    const { published } = await mountCard([{ name: "KEEP", value: "1", sensitive: false }]);

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await commit(nameInput(2), "MY-KEY");
    await expect.element(page.getByText(INVALID_NAME_ERROR)).toBeVisible();
    await expect.element(nameInput(2)).toHaveAttribute("aria-invalid", "true");
    expect(published).toEqual([]);

    await commit(valueInput(1), "2");
    expect(published.at(-1)).toStrictEqual([{ name: "KEEP", value: "2", sensitive: false }]);
    await expect.element(nameInput(2)).toHaveValue("MY-KEY");
    await expect.element(page.getByText(INVALID_NAME_ERROR)).toBeVisible();

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await commit(valueInput(3), "orphan");
    await expect.element(page.getByText("Enter a name for this variable.")).toBeVisible();

    await commit(nameInput(2), "A".repeat(129));
    await expect.element(page.getByText("Names may be at most 128 characters.")).toBeVisible();

    await commit(nameInput(2), "MY_KEY");
    expect(published.at(-1)).toStrictEqual([
      { name: "KEEP", value: "2", sensitive: false },
      { name: "MY_KEY", value: "", sensitive: true },
    ]);
    await expect.element(page.getByText("Enter a name for this variable.")).toBeVisible();
  });

  it("splits a pasted assignment into name and value and publishes it on blur", async () => {
    const { published } = await mountCard([]);

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await nameInput(1).click();
    paste(nameInput(1), "export API_KEY='sk-123'\n");

    await expect.element(nameInput(1)).toHaveValue("API_KEY");
    await expect.element(valueInput(1)).toHaveValue("sk-123");
    expect(published).toEqual([]);

    await userEvent.keyboard("{Enter}");
    expect(published.at(-1)).toStrictEqual([{ name: "API_KEY", value: "sk-123", sensitive: true }]);
  });

  it("pastes a padded token into a stored secret's name verbatim", async () => {
    const { published } = await mountCard([
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ]);

    await nameInput(1).fill("");
    expect(paste(nameInput(1), "dGVzdA==")).toBe(true);
    await commit(nameInput(1), "dGVzdA==");

    await expect.element(nameInput(1)).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(valueInput(1))
      .toHaveAttribute("placeholder", "Stored secret - enter a new value to replace");
    expect(published).toEqual([]);
  });

  it("ignores a blank row whose Sensitive box was toggled", async () => {
    const { published } = await mountCard([{ name: "KEEP", value: "1", sensitive: false }]);

    await page.getByRole("button", { name: "Add", exact: true }).click();
    const blankSensitive = page.getByRole("checkbox", { name: "Sensitive" }).nth(1);
    await blankSensitive.click();
    await blankSensitive.click();
    await commit(valueInput(1), "2");

    expect(published.at(-1)).toStrictEqual([{ name: "KEEP", value: "2", sensitive: false }]);
    await expect.element(nameInput(2)).not.toHaveAttribute("aria-invalid");
    await expect.element(page.getByText("Enter a name for this variable.")).not.toBeInTheDocument();
  });

  it("keeps a renamed stored secret on the server until its value is entered again", async () => {
    const { published, server } = await mountCard([
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
      { name: "OTHER", value: "x", sensitive: false },
    ]);

    await commit(nameInput(1), "NEW_KEY");
    await expect
      .element(page.getByText("Enter the value again to rename this stored secret."))
      .toBeVisible();
    expect(published).toEqual([]);

    await commit(valueInput(2), "y");
    expect(published.at(-1)).toStrictEqual([
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
      { name: "OTHER", value: "y", sensitive: false },
    ]);
    await expect.element(nameInput(1)).toHaveValue("NEW_KEY");

    await commit(valueInput(1), "s3cret");
    expect(published.at(-1)).toStrictEqual([
      { name: "NEW_KEY", value: "s3cret", sensitive: true },
      { name: "OTHER", value: "y", sensitive: false },
    ]);

    server.setEnvironment([
      { name: "NEW_KEY", value: "", sensitive: true, valueRedacted: true },
      { name: "OTHER", value: "y", sensitive: false },
    ]);
    await expect.element(valueInput(1)).toHaveValue("");
    await expect
      .element(valueInput(1))
      .toHaveAttribute("placeholder", "Stored secret - enter a new value to replace");
  });

  it("holds an unchecked stored secret until a plain value is entered, and can cancel", async () => {
    const storedSecret = { name: "API_KEY", value: "", sensitive: true, valueRedacted: true };
    const { published } = await mountCard([
      storedSecret,
      { name: "OTHER", value: "x", sensitive: false },
    ]);
    const sensitive = page.getByRole("checkbox", { name: "Sensitive" }).first();
    const hint = page.getByText("Enter a new value to store it as plain text.");

    await sensitive.click();
    await expect.element(hint).toBeVisible();
    expect(published).toEqual([]);

    await commit(valueInput(2), "y");
    expect(published.at(-1)).toStrictEqual([
      storedSecret,
      { name: "OTHER", value: "y", sensitive: false },
    ]);

    await page
      .getByRole("button", { name: "Cancel changes to environment variable API_KEY" })
      .click();
    await expect.element(hint).not.toBeInTheDocument();
    await expect.element(sensitive).toBeChecked();
    expect(published).toHaveLength(1);

    await sensitive.click();
    await commit(valueInput(1), "plain");
    expect(published.at(-1)).toStrictEqual([
      { name: "API_KEY", value: "plain", sensitive: false },
      { name: "OTHER", value: "y", sensitive: false },
    ]);
  });

  it("keeps drafts across unchanged re-renders and merges real server changes", async () => {
    const { server } = await mountCard([{ name: "KEEP", value: "1", sensitive: false }]);

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await commit(nameInput(2), "BAD-NAME");

    server.setEnvironment([{ name: "KEEP", value: "1", sensitive: false }]);
    await expect.element(nameInput(2)).toHaveValue("BAD-NAME");
    await expect.element(page.getByText(INVALID_NAME_ERROR)).toBeVisible();

    server.setEnvironment([
      { name: "KEEP", value: "changed", sensitive: false },
      { name: "ADDED", value: "z", sensitive: false },
    ]);
    await expect.element(valueInput(1)).toHaveValue("changed");
    await expect.element(nameInput(2)).toHaveValue("BAD-NAME");
    await expect.element(nameInput(3)).toHaveValue("ADDED");
  });

  it("drops drafts when the settings switch to another node", async () => {
    const environment: Environment = [
      { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
    ];
    const { published, server } = await mountCard(environment);

    await commit(nameInput(1), "NEW_KEY");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await commit(nameInput(2), "MY-KEY");

    server.switchNode(nodeTarget("node-b"), environment);
    await expect.element(nameInput(1)).toHaveValue("API_KEY");
    await expect.element(nameInput(2)).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Enter the value again to rename this stored secret."))
      .not.toBeInTheDocument();
    expect(published).toEqual([]);
  });
});
