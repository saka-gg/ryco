import "../../index.css";

import { appAtomRegistry, serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  EventId,
  SecretRequestError,
  SecretRequestId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type OrchestrationThreadActivity,
  type SecretRequestAnswerInput,
  type ServerConfig,
} from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SecretRequestCards } from "./SecretRequestCards";

const ENVIRONMENT = EnvironmentId.make("env-secret-requests");
const THREAD = ThreadId.make("thread-secret-requests");
const REQUEST = SecretRequestId.make(`secret-request-${"f".repeat(32)}`);
// Built from parts, so no fixture looks like a real credential.
const VALUE = ["sk", "test", "browser", "1234"].join("_");

const requested: OrchestrationThreadActivity = {
  id: EventId.make(`${REQUEST}:requested`),
  tone: "info",
  kind: "secret.requested",
  summary: "Asked for STRIPE_SECRET_KEY for .env",
  payload: {
    requestId: REQUEST,
    key: "STRIPE_SECRET_KEY",
    purpose: "Charge test cards in the checkout flow",
    file: ".env",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    checkoutId: "c".repeat(32),
  },
  turnId: TurnId.make("turn-1"),
  createdAt: new Date().toISOString(),
};

function fakeNode(input: { readonly answers: boolean; readonly fail?: unknown }) {
  const environment = {
    environmentId: ENVIRONMENT,
    label: "Laptop",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "1",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: true,
      secretRequests: input.answers,
    },
  };
  writePrimaryEnvironmentDescriptor(environment);
  appAtomRegistry.set(serverConfigAtom, { environment } as ServerConfig);
  const sent: SecretRequestAnswerInput[] = [];
  const threads: Pick<NonNullable<EnvironmentApi["threads"]>, "answerSecretRequest"> = {
    answerSecretRequest: async (answer) => {
      sent.push(answer);
      if (input.fail !== undefined) throw input.fail;
      return {
        status: answer.answer.type === "provide" ? "provided" : "declined",
        file: ".env",
        key: "STRIPE_SECRET_KEY",
      };
    },
  };
  __setEnvironmentApiOverrideForTests(ENVIRONMENT, { threads } as unknown as EnvironmentApi);
  return { sent };
}

const mounts: Array<{ unmount: () => Promise<void> | void; host: HTMLElement }> = [];

async function mountCards(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <AppAtomRegistryProvider>
      <SecretRequestCards
        environmentId={ENVIRONMENT}
        threadId={THREAD}
        activities={activities}
        disabledReason={null}
      />
    </AppAtomRegistryProvider>,
    { container: host },
  );
  mounts.push({ unmount: () => screen.unmount(), host });
  return host;
}

describe("SecretRequestCards", () => {
  beforeEach(async () => {
    await page.viewport(1000, 700);
  });

  afterEach(async () => {
    for (const mount of mounts.splice(0).toReversed()) {
      await mount.unmount();
      mount.host.remove();
    }
    __resetEnvironmentApiOverridesForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    appAtomRegistry.set(serverConfigAtom, null);
  });

  it("asks for the key on a private card and sends the value only to the node", async () => {
    const node = fakeNode({ answers: true });
    const host = await mountCards([requested]);
    await expect.element(page.getByText("Charge test cards in the checkout flow")).toBeVisible();
    await expect.element(page.getByText(/Saved to/)).toBeVisible();
    const field = page.getByLabelText("Value for STRIPE_SECRET_KEY");
    // Masked, and kept away from autofill and spell checking.
    await expect.element(field).toHaveAttribute("type", "password");
    await expect.element(field).toHaveAttribute("autocomplete", "off");
    await expect.element(field).toHaveAttribute("spellcheck", "false");
    await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();

    await field.fill(VALUE);
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => node.sent)
      .toEqual([
        { threadId: THREAD, requestId: REQUEST, answer: { type: "provide", value: VALUE } },
      ]);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Saved STRIPE_SECRET_KEY to .env");
    // Once the node took it, the value is gone from the page.
    expect(host.innerHTML).not.toContain(VALUE);
    expect(host.querySelector("input")).toBeNull();
  });

  it("declines without a value, and shows the node's refusal without echoing the value", async () => {
    const node = fakeNode({
      answers: true,
      fail: new SecretRequestError({ reason: "not-ignored" }),
    });
    const host = await mountCards([requested]);
    await page.getByLabelText("Value for STRIPE_SECRET_KEY").fill(VALUE);
    await page.getByLabelText("Value for STRIPE_SECRET_KEY").click();
    // Enter on the field saves (no <form>: the composer below keeps its own Enter).
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Git does not ignore that file, so Ryco will not write a secret there.");
    expect(node.sent).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(VALUE);

    const declining = fakeNode({ answers: true });
    await page.getByRole("button", { name: "Decline" }).click();
    await expect
      .poll(() => declining.sent)
      .toEqual([{ threadId: THREAD, requestId: REQUEST, answer: { type: "decline" } }]);
  });

  it("shows an unencrypted connection's refusal and keeps the value to send again", async () => {
    const refusing = fakeNode({
      answers: true,
      fail: new SecretRequestError({ reason: "unencrypted-connection" }),
    });
    const host = await mountCards([requested]);
    const field = page.getByLabelText("Value for STRIPE_SECRET_KEY");
    await field.fill(VALUE);
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Secrets can only be sent over an encrypted connection. Open Ryco on the computer it runs on, or connect over HTTPS or Tailscale.",
      );
    expect(refusing.sent).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(VALUE);
    // The value stays in the field, masked, and Save works again once the connection does.
    await expect.element(field).toHaveValue(VALUE);
    await expect.element(field).toHaveAttribute("type", "password");
    await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();

    const encrypted = fakeNode({ answers: true });
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => encrypted.sent)
      .toEqual([
        { threadId: THREAD, requestId: REQUEST, answer: { type: "provide", value: VALUE } },
      ]);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Saved STRIPE_SECRET_KEY to .env");
  });

  it("stays read-only on a node that cannot answer, and hides answered requests", async () => {
    const node = fakeNode({ answers: false });
    await mountCards([requested]);
    await expect
      .element(page.getByText("Update this node to answer secret requests."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Value for STRIPE_SECRET_KEY")).toBeDisabled();
    expect(node.sent).toEqual([]);

    const resolved: OrchestrationThreadActivity = {
      ...requested,
      id: EventId.make(`${REQUEST}:resolved`),
      kind: "secret.resolved",
      summary: "STRIPE_SECRET_KEY saved to .env",
      payload: { requestId: REQUEST, status: "provided" },
    };
    const host = await mountCards([requested, resolved]);
    expect(host.querySelector("section")).toBeNull();
  });
});
