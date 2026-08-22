import "../../index.css";

import { EnvironmentId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { StrictMode } from "react";

const navigate = vi.fn(async () => undefined);
// These suites render the hosted root outside a `RouterProvider`. The toast
// host the entry surfaces now mount reads route params to scope thread-scoped
// toasts, which is neither what these suites exercise nor reachable here, so
// the read is stubbed alongside the navigation that was already stubbed.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => undefined,
}));

// Hosted mode, which no browser test gets by default: there is no `.env` in
// this harness, so `isHostedHubMode()` answers false and every hosted gate runs
// as the standard client. See `HostedNodeDirectory.browser.tsx` for the full
// note.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

import {
  hostedHubController,
  useHostedAccountStore,
  useHostedHubStore,
} from "../../hostedHub/state";
import { resetHubRoutesForTests } from "../../hostedHub/hubRoutes";
import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import type { HostedHubNode } from "../../hostedHub/types";
import { HostedHubRoot, HostedNodeMenu } from "./HostedHubRoot";
import { hostedRelayTrustDisclosure } from "./HostedRelayTrustNotice.logic";
import { RETIRED_HOSTED_RELAY_TRUST_SENTENCE } from "../../../test/hostedConnectionVocabulary";
import { resetWebE2eeSession } from "../../hostedHub/e2eeSession";

const account = {
  id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const session = {
  id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
  accountId: account.id,
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
};
const activeSpace = {
  id: "space_aaaaaaaaaaaaaaaaaaaaaa",
  kind: "personal" as const,
  displayName: "Ada's space",
  role: "owner" as const,
};
const publicIdentity = {
  account: { ...account, username: "ada" },
  session: { ...session, activeSpaceId: activeSpace.id },
  activeSpace,
  spaces: [activeSpace],
  csrfToken: "csrf-sensitive-browser-canary",
} as never;

function node(id: string, online: boolean, role: "viewer" | "operator" | "owner"): HostedHubNode {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label: online ? "Studio online" : "Travel offline",
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role },
    effectiveRole: role,
    presence: { online, lastHeartbeatAt: online ? 1 : null },
  };
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  hostedHubController.resetForTests();
  resetHubRoutesForTests();
  // The §13 projection is module scope, so a channel left standing by another
  // case would render this one's disclosure at the wrong claim.
  resetWebE2eeSession();
  navigate.mockClear();
  window.history.replaceState(null, "", "/");
  vi.spyOn(hostedHubApi, "getPublicSignupConfiguration").mockResolvedValue({
    status: "disabled",
  });
  vi.spyOn(hostedHubApi, "getPendingExternalIdentity").mockResolvedValue({ status: "none" });
  vi.spyOn(hostedHubController, "refreshExternalIdentityConfiguration").mockResolvedValue();
});

afterEach(async () => {
  await mounted?.unmount();
  await page.viewport(1_280, 720);
  mounted = null;
  hostedHubController.resetForTests();
  resetHubRoutesForTests();
  resetWebE2eeSession();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/**
 * The nearest ancestor a person could actually scroll. `overflow: hidden`
 * boxes still respond to programmatic scrolling, so they do not count.
 */
function userScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element.parentElement;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

describe("HostedHubRoot accessibility and responsive flows", () => {
  it("shows GitHub sign-in only when the provider policy advertises it", async () => {
    mounted = await render(<HostedHubRoot />);
    await expect
      .element(page.getByRole("button", { name: "Continue with GitHub" }))
      .not.toBeInTheDocument();
    await mounted.unmount();

    useHostedAccountStore.setState({
      externalIdentityConfiguration: {
        version: 1,
        providers: [{ provider: "github", login: true, signup: true, link: true }],
      },
      externalIdentityConfigurationStatus: "ready",
    });
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  });

  it("returns GitHub authentication to account completion", async () => {
    window.history.replaceState(null, "", "/sign-in");
    useHostedAccountStore.setState({
      externalIdentityConfiguration: {
        version: 1,
        providers: [{ provider: "github", login: true, signup: true, link: true }],
      },
      externalIdentityConfigurationStatus: "ready",
    });
    const start = vi
      .spyOn(hostedHubApi, "startExternalIdentityAuthorization")
      .mockRejectedValue(new HostedHubApiError("external_identity_unavailable", 503));

    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Continue with GitHub" }).click();

    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledWith({
        provider: "github",
        intent: "authenticate",
        returnTo: "/sign-up",
      });
    });
  });

  it("replaces GitHub account completion with the directory after linked login", async () => {
    window.history.replaceState(null, "", "/sign-up");
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [],
    });

    mounted = await render(<HostedHubRoot />);

    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/nodes");
    });
  });

  it("confirms a GitHub-backed signup before creating the Ryco account", async () => {
    window.history.replaceState(null, "", "/sign-up");
    vi.mocked(hostedHubApi.getPublicSignupConfiguration).mockResolvedValue({
      status: "enabled",
      antiBot: { provider: "bypass" },
    });
    vi.mocked(hostedHubApi.getPendingExternalIdentity).mockResolvedValue({
      status: "signup",
      provider: "github",
      suggestedUsername: "octocat",
      displayName: "The Octocat",
      expiresAt: 2,
    } as never);
    const finish = vi.spyOn(hostedHubApi, "finishExternalIdentitySignup").mockResolvedValue({
      status: "complete",
      identity: publicIdentity,
      recoveryCodes: ["recovery-one", "recovery-two"],
    });
    const adopt = vi.spyOn(hostedHubController, "adoptPublicBrowserIdentity").mockResolvedValue();

    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByText("GitHub verified")).toBeVisible();
    await expect.element(page.getByLabelText("Username")).toHaveValue("octocat");
    await page.getByLabelText("Username").fill("octo_ryco");
    await page.getByRole("button", { name: "Create account with GitHub" }).click();

    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        username: "octo_ryco",
        antiBotAssertion: "development",
        idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      }),
    );
    expect(adopt).toHaveBeenCalledWith(publicIdentity, ["recovery-one", "recovery-two"]);
  });

  it("contains hosted admission and node selection at 320 CSS pixels", async () => {
    await page.viewport(320, 568);
    try {
      mounted = await render(<HostedHubRoot />);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      await mounted.unmount();

      const selected = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account,
        session,
        directoryStatus: "ready",
        nodes: [selected],
      });
      mounted = await render(<HostedHubRoot />);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      const selectButton = page.getByRole("button", { name: /^Studio online/ });
      await expect.element(selectButton).toBeVisible();
      const box = selectButton.element().getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
      expect(box.height).toBeGreaterThanOrEqual(44);
    } finally {
      await page.viewport(1_280, 720);
    }
  });

  it("keeps the primary hosted entry action reachable by scrolling at 320x568", async () => {
    // Regression: the hosted entry surface used to be a `min-h-dvh` centred
    // card inside a non-scrolling root, so at the narrowest supported phone
    // the primary action fell below the fold with no way to reach it.
    await page.viewport(320, 568);
    try {
      useHostedHubStore.setState({ bootstrapAvailable: true });
      mounted = await render(<HostedHubRoot />);

      const signIn = page.getByRole("button", { name: "Sign in with passkey" });
      await expect.element(signIn).toBeVisible();
      const button = signIn.element() as HTMLElement;

      // The content is taller than the viewport here, so reachability depends
      // on a *user*-scrollable ancestor. `overflow: hidden` would still answer
      // `scrollIntoView`, which is why the ancestor's computed overflow is
      // asserted rather than the scroll result alone.
      const scroller = userScrollableAncestor(button);
      expect(scroller, "the hosted entry surface must be user-scrollable").not.toBeNull();
      expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);

      scroller!.scrollTop = scroller!.scrollHeight;
      await vi.waitFor(() => {
        const rect = button.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      });

      // Reaching it never costs horizontal overflow.
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(scroller!.scrollWidth).toBeLessThanOrEqual(scroller!.clientWidth);
    } finally {
      await page.viewport(1_280, 720);
    }
  });

  it("keeps sign-in and node-selection screen-reader traversal named with status regions", async () => {
    await page.viewport(390, 844);
    const accessibleName = (control: HTMLElement): string => {
      const ariaLabel = control.getAttribute("aria-label")?.trim();
      if (ariaLabel) return ariaLabel;
      const labelledBy = control.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const content = control.textContent?.trim();
      if (content) return content;
      return control.getAttribute("title")?.trim() ?? "";
    };
    const unnamedVisibleControls = () =>
      [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter((control) => control.checkVisibility?.() ?? true)
        .filter((control) => accessibleName(control) === "")
        .map((control) => control.outerHTML.slice(0, 160));

    try {
      // Sign-in: every visible control is named, and the passkey ceremony has
      // a polite in-progress announcement region.
      useHostedHubStore.setState({ bootstrapAvailable: true });
      mounted = await render(<HostedHubRoot />);
      await expect
        .element(page.getByRole("button", { name: "Sign in with passkey" }))
        .toBeVisible();
      expect(unnamedVisibleControls()).toEqual([]);
      const signInLiveRegion = document.querySelector<HTMLElement>('[aria-live="polite"]');
      expect(signInLiveRegion).not.toBeNull();
      useHostedHubStore.setState({ accountStatus: "authenticating" });
      await vi.waitFor(() => {
        expect(signInLiveRegion!.textContent).toContain("Passkey authentication is in progress");
      });
      await mounted.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetHubRoutesForTests();

      // Node selection: rows and controls are named, presence reads as text
      // (never color alone), and stale directory data announces as a status.
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account,
        session,
        directoryStatus: "ready",
        browserStatus: "current",
        nodes: [
          node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator"),
          node("node_bbbbbbbbbbbbbbbbbbbbbb", false, "viewer"),
        ],
      });
      mounted = await render(<HostedHubRoot />);
      const onlineRow = page.getByRole("button", { name: /^Studio online/ });
      await expect.element(onlineRow).toBeVisible();
      expect(unnamedVisibleControls()).toEqual([]);
      expect(onlineRow.element().textContent).toContain("Online");
      const offlineRow = page.getByRole("button", { name: /^Travel offline/ });
      expect(offlineRow.element().textContent).toContain("Offline");

      useHostedHubStore.setState({ directoryStatus: "stale" });
      await vi.waitFor(() => {
        const status = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(
          (region) => region.textContent?.includes("Directory data is stale"),
        );
        expect(status).not.toBeUndefined();
      });
    } finally {
      await page.viewport(1_280, 720);
    }
  });

  it("provides keyboard-labelled authentication and registration controls with focus management", async () => {
    useHostedHubStore.setState({ bootstrapAvailable: true });
    mounted = await render(<HostedHubRoot />);
    await expect
      .element(page.getByRole("heading", { name: "Connect to your Ryco nodes" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
    // No node is selected here, so no §4 channel exists: the disclosure states
    // the no-channel claim and never the retired sentence, which asserts the
    // opposite of what a locked NX channel makes true (§2.2).
    await expect
      .element(page.getByText(hostedRelayTrustDisclosure("unavailable").body))
      .toBeVisible();
    expect(document.body.textContent).not.toContain(RETIRED_HOSTED_RELAY_TRUST_SENTENCE);

    await page.getByRole("button", { name: "Redeem invitation" }).click();
    await expect.element(page.getByLabelText("Invitation code")).toBeVisible();
    await expect
      .element(page.getByLabelText("Invitation code"))
      .toHaveAttribute("type", "password");
    await expect.element(page.getByLabelText("Display name")).toBeVisible();
    await expect.element(page.getByLabelText(/Passkey label/)).toBeVisible();
    await expect.element(page.getByLabelText("Invitation code")).toHaveFocus();

    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Set up first owner" }).click();
    await expect.element(page.getByLabelText("Bootstrap credential")).toBeVisible();
    await expect
      .element(page.getByLabelText("Bootstrap credential"))
      .toHaveAttribute("type", "password");
    await expect.element(page.getByLabelText("Bootstrap credential")).toHaveFocus();
  });

  it("submits first-owner bootstrap without retaining its credential in the form", async () => {
    const bootstrapOwner = vi.spyOn(hostedHubController, "bootstrapOwner").mockResolvedValue();
    useHostedHubStore.setState({ bootstrapAvailable: true });
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Set up first owner" }).click();
    await page.getByLabelText("Bootstrap credential").fill("bootstrap-sensitive-browser-canary");
    await page.getByLabelText("Display name").fill("Ada");
    await page.getByLabelText(/Passkey label/).fill("Primary");
    await page.getByRole("button", { name: "Create owner and passkey" }).click();

    expect(bootstrapOwner).toHaveBeenCalledWith({
      credential: "bootstrap-sensitive-browser-canary",
      displayName: "Ada",
      passkeyLabel: "Primary",
    });
    await expect.element(page.getByLabelText("Bootstrap credential")).toHaveValue("");
    expect(JSON.stringify(localStorage)).not.toContain("bootstrap-sensitive-browser-canary");
    expect(JSON.stringify(sessionStorage)).not.toContain("bootstrap-sensitive-browser-canary");
    expect(location.href).not.toContain("bootstrap-sensitive-browser-canary");
  });

  it("offers every browser fallback sign-in without retaining submitted credentials", async () => {
    await page.viewport(1_280, 577);
    const passwordStart = vi.spyOn(hostedHubApi, "startPasswordLogin").mockResolvedValue({
      status: "factor_required",
      attemptId: "login_aaaaaaaaaaaaaaaaaaaaaa",
      attemptSecret: "A".repeat(43),
      factor: "email_code",
      issuedAt: 1,
      expiresAt: 2,
    } as never);
    const passwordFinish = vi
      .spyOn(hostedHubApi, "finishPasswordLogin")
      .mockResolvedValue(publicIdentity);
    const adopt = vi.spyOn(hostedHubController, "adoptPublicBrowserIdentity").mockResolvedValue();
    const recoverySignIn = vi.spyOn(hostedHubApi, "signInWithRecoveryCode").mockResolvedValue({
      account,
      session,
    });
    const bootstrap = vi.spyOn(hostedHubController, "bootstrap").mockResolvedValue();
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Password, recovery code, or reset" }).click();
    const recoveryChoice = page.getByRole("button", { name: "Use recovery code" });
    const resetChoice = page.getByRole("button", { name: "Forgot password?" });
    await expect.element(recoveryChoice).toBeVisible();
    await expect.element(resetChoice).toBeVisible();
    const fallbackScroller = userScrollableAncestor(recoveryChoice.element() as HTMLElement);
    expect(
      fallbackScroller,
      "fallback choices must have a user-scrollable ancestor",
    ).not.toBeNull();
    fallbackScroller!.scrollTop = fallbackScroller!.scrollHeight;
    await vi.waitFor(() => {
      for (const choice of [recoveryChoice, resetChoice]) {
        const rect = choice.element().getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      }
    });
    await expect
      .element(page.getByRole("button", { name: "Back to sign in" }))
      .not.toBeInTheDocument();
    await page.getByLabelText("Username or verified email").fill("Ada");
    await page.getByLabelText("Password").fill("password-sensitive-browser-canary");
    await page.getByRole("button", { name: "Continue" }).click();
    expect(passwordStart).toHaveBeenCalledWith({
      identifier: "ada",
      password: "password-sensitive-browser-canary",
    });
    await expect.element(page.getByLabelText("Password")).not.toBeInTheDocument();
    await page.getByLabelText("Email code").fill("123456");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(passwordFinish).toHaveBeenCalledWith({
      attemptId: "login_aaaaaaaaaaaaaaaaaaaaaa",
      attemptSecret: "A".repeat(43),
      factor: "email_code",
      code: "123456",
    });
    expect(adopt).toHaveBeenCalledWith(publicIdentity);
    await expect.element(page.getByLabelText("Email code")).toHaveValue("");

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await page.getByLabelText("Recovery code").fill("recovery-sensitive-browser-canary");
    await page.getByRole("button", { name: "Use recovery code" }).click();
    expect(recoverySignIn).toHaveBeenCalledWith("recovery-sensitive-browser-canary");
    expect(bootstrap).toHaveBeenCalledOnce();
    await expect.element(page.getByLabelText("Recovery code")).toHaveValue("");

    for (const sensitive of [
      "password-sensitive-browser-canary",
      "recovery-sensitive-browser-canary",
      "123456",
    ]) {
      expect(JSON.stringify(localStorage)).not.toContain(sensitive);
      expect(JSON.stringify(sessionStorage)).not.toContain(sensitive);
      expect(location.href).not.toContain(sensitive);
    }
  });

  it("creates a public password account after mailbox verification and preserves recovery codes", async () => {
    await page.viewport(320, 568);
    vi.mocked(hostedHubApi.getPublicSignupConfiguration).mockResolvedValue({
      status: "enabled",
      antiBot: { provider: "bypass" },
    });
    const start = vi.spyOn(hostedHubApi, "startPublicSignup").mockResolvedValue({
      status: "accepted",
      attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
      attemptSecret: "A".repeat(43),
      resendAfterMs: 30_000,
      issuedAt: 1,
      expiresAt: 2,
    } as never);
    const verify = vi.spyOn(hostedHubApi, "verifyPublicSignup").mockResolvedValue({
      status: "verified",
      attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
      activationSecret: "B".repeat(43),
      issuedAt: 1,
      expiresAt: 2,
    } as never);
    const finish = vi.spyOn(hostedHubApi, "finishPublicSignupWithPassword").mockResolvedValue({
      status: "complete",
      identity: publicIdentity,
      recoveryCodes: ["recovery-one", "recovery-two"],
    });
    const adopt = vi.spyOn(hostedHubController, "adoptPublicBrowserIdentity").mockResolvedValue();
    mounted = await render(<HostedHubRoot />);

    const createAccount = page.getByRole("button", { name: "Create account" });
    const signupScroller = userScrollableAncestor(createAccount.element() as HTMLElement);
    expect(signupScroller, "signup must live in the hosted surface scroller").not.toBeNull();
    signupScroller!.scrollTop = signupScroller!.scrollHeight;
    expect(signupScroller!.scrollTop).toBeGreaterThan(0);
    await createAccount.click();
    await vi.waitFor(() => expect(signupScroller!.scrollTop).toBe(0));
    await page.getByLabelText("Username").fill("Ada_2026");
    await page.getByLabelText("Email").fill("ADA@example.test");
    await page.getByRole("button", { name: "Send verification email" }).click();
    expect(start).toHaveBeenCalledWith({
      username: "ada_2026",
      email: "ada@example.test",
      antiBotAssertion: "development",
    });

    await page.getByLabelText("Verification code").fill("123456");
    await page.getByRole("button", { name: "Verify email" }).click();
    expect(verify).toHaveBeenCalledWith({
      attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
      attemptSecret: "A".repeat(43),
      proof: { kind: "email_code", code: "123456" },
    });
    await page.getByRole("button", { name: "Use a password instead" }).click();
    await page.getByLabelText("Password", { exact: true }).fill("correct horse battery");
    await page.getByLabelText("Repeat password").fill("correct horse battery");
    await page.getByRole("button", { name: "Create account" }).click();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
        activationSecret: "B".repeat(43),
        password: "correct horse battery",
        idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      }),
    );
    expect(adopt).toHaveBeenCalledWith(publicIdentity, ["recovery-one", "recovery-two"]);
  });

  it("consumes a fragment reset link, changes the password, and keeps the bearer out of history", async () => {
    const token = "C".repeat(43);
    window.history.replaceState(null, "", `/password-reset#token=${token}`);
    const verify = vi.spyOn(hostedHubApi, "verifyPasswordReset").mockResolvedValue({
      status: "verified",
      attemptId: "reset_aaaaaaaaaaaaaaaaaaaaaa",
      attemptSecret: "D".repeat(43),
      requiresTotp: true,
      issuedAt: 1,
      expiresAt: 2,
    } as never);
    const finish = vi.spyOn(hostedHubApi, "finishPasswordReset").mockResolvedValue({
      status: "complete",
    });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByLabelText("New password")).toBeVisible();
    expect(verify).toHaveBeenCalledWith({ token }, expect.any(AbortSignal));
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(token);
    await page.getByLabelText("New password").fill("correct horse battery");
    await page.getByLabelText("Repeat password").fill("correct horse battery");
    await page.getByLabelText("Authenticator code").fill("123456");
    await page.getByRole("button", { name: "Change password" }).click();
    expect(finish).toHaveBeenCalledWith({
      attemptId: "reset_aaaaaaaaaaaaaaaaaaaaaa",
      attemptSecret: "D".repeat(43),
      password: "correct horse battery",
      factor: { kind: "totp", code: "123456" },
    });
    await expect.element(page.getByText("Password changed")).toBeVisible();
  });

  it("verifies an existing-account email from a scrubbed fragment link", async () => {
    const token = "E".repeat(43);
    window.history.replaceState(null, "", `/email-verification#token=${token}`);
    const confirm = vi.spyOn(hostedHubApi, "confirmEmailVerification").mockResolvedValue();
    mounted = await render(
      <StrictMode>
        <HostedHubRoot />
      </StrictMode>,
    );

    await expect.element(page.getByText("Email verified")).toBeVisible();
    expect(confirm).toHaveBeenCalledWith(token, expect.any(AbortSignal));
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(token);
    await page.getByRole("button", { name: "Continue" }).click();
    expect(window.location.pathname).toBe("/");
  });

  it("hides unavailable bootstrap without hiding invitation redemption", async () => {
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByRole("button", { name: "Redeem invitation" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Set up first owner" }))
      .not.toBeInTheDocument();
  });

  it("announces session expiry without exposing prior account or session state", async () => {
    useHostedHubStore.setState({ accountStatus: "session-expired" });
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByRole("heading", { name: "Your session expired" })).toBeVisible();
    expect(document.body.textContent).not.toContain(account.id);
    expect(document.body.textContent).not.toContain(session.id);
  });

  it("distinguishes online and offline authorized nodes and disables stale selection", async () => {
    const nodes = [
      node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator"),
      node("node_bbbbbbbbbbbbbbbbbbbbbb", false, "viewer"),
    ];
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "stale",
      nodes,
      errorMessage: "Directory refresh failed.",
    });
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByRole("status")).toHaveTextContent(/Directory data is stale/);
    await expect.element(page.getByRole("button", { name: /^Studio online/ })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: /^Travel offline/ })).toBeDisabled();
    await expect.element(page.getByText("Online", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Offline", { exact: true })).toBeVisible();
    // The directory is reached with no channel open — `returnToDirectory` resets
    // the projection — so this mount site is the no-channel claim too.
    await expect
      .element(page.getByText(hostedRelayTrustDisclosure("unavailable").body))
      .toBeVisible();
    expect(document.body.textContent).not.toContain(RETIRED_HOSTED_RELAY_TRUST_SENTENCE);
  });

  it("takes the viewport over for codes nothing is displaying, and yields to a display that is", async () => {
    // The safety net for a set of codes whose display went away without an
    // acknowledgement — a node switch closing the settings dialog, a lost
    // grant. The codes stay in the runtime's slot, so this is what puts them in
    // front of the user rather than leaving the account holding codes its owner
    // never saw. While a surface *is* showing them, taking the viewport would
    // tear that surface down mid-flow instead.
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      recoveryCodes: ["recovery-sensitive-browser-canary"],
    });
    const release = hostedHubController.leaseRecoveryCodeDisplay();
    mounted = await render(<HostedHubRoot />);
    await expect
      .element(page.getByRole("heading", { name: "Save your recovery codes" }))
      .not.toBeInTheDocument();

    release();
    await expect
      .element(page.getByRole("heading", { name: "Save your recovery codes" }))
      .toBeVisible();
  });

  it("keeps one-time recovery material out of browser storage, copy included", async () => {
    const clipboard: Array<string> = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          clipboard.push(value);
          return Promise.resolve();
        },
      },
    });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      recoveryCodes: ["recovery-sensitive-browser-canary", "second-sensitive-browser-canary"],
    });
    mounted = await render(<HostedHubRoot />);
    await expect
      .element(page.getByRole("heading", { name: "Save your recovery codes" }))
      .toBeVisible();
    // The count comes from the set rather than from a hardcoded eight or ten.
    await expect.element(page.getByText(/Save all 2 codes/)).toBeVisible();
    expect(JSON.stringify(localStorage)).not.toContain("recovery-sensitive-browser-canary");
    expect(JSON.stringify(sessionStorage)).not.toContain("recovery-sensitive-browser-canary");
    expect(location.href).not.toContain("recovery-sensitive-browser-canary");

    // The copy control this surface gained is a second path the same secret can
    // travel, and it must reach the clipboard and nowhere else.
    await page.getByRole("button", { name: "Copy codes" }).click();
    expect(clipboard).toEqual([
      "recovery-sensitive-browser-canary\nsecond-sensitive-browser-canary",
    ]);
    expect(JSON.stringify(localStorage)).not.toContain("recovery-sensitive-browser-canary");
    expect(JSON.stringify(sessionStorage)).not.toContain("recovery-sensitive-browser-canary");
    expect(document.cookie).not.toContain("recovery-sensitive-browser-canary");
    expect(location.href).not.toContain("recovery-sensitive-browser-canary");

    // And the acknowledgement is still the group's last child, so it stays the
    // primary action the fold assertions measure.
    const acknowledge = [...document.querySelectorAll<HTMLElement>("button")].find(
      (button) => button.textContent?.trim() === "I saved the codes",
    );
    expect(acknowledge).not.toBeUndefined();
    expect(acknowledge!.parentElement!.lastElementChild).toBe(acknowledge);
  });

  it("keeps the node session UI unmounted until the initial snapshot is ready", async () => {
    const selectedNode = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [selectedNode],
      selectedNode,
      transportStatus: "online",
      sessionEstablished: false,
    });
    mounted = await render(<HostedHubRoot />);
    await expect
      .element(page.getByRole("heading", { name: `Connecting to ${selectedNode.label}` }))
      .toBeVisible();
    await expect.element(page.getByRole("status")).toHaveTextContent(/synchronizing Ryco state/);
  });

  it("shows a labelled relay failure without mounting the node session UI", async () => {
    const selectedNode = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [selectedNode],
      selectedNode,
      transportStatus: "terminal-failure",
      errorMessage: "The relay authentication attempt expired or was rejected.",
    });
    mounted = await render(<HostedHubRoot />);
    await expect
      .element(page.getByRole("heading", { name: `Unable to connect to ${selectedNode.label}` }))
      .toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(/authentication attempt expired/);
    await expect.element(page.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("retries bounded synchronization failures from the selected node", async () => {
    const selectedNode = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
    const retry = vi.spyOn(hostedHubController, "retrySelectedNode").mockResolvedValue();
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [selectedNode],
      selectedNode,
      transportStatus: "terminal-failure",
      errorMessage: "Ryco state could not be synchronized.",
    });

    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Retry" }).click();

    expect(retry).toHaveBeenCalledOnce();
  });

  it("starts sign-in and node selection from keyboard-operable controls", async () => {
    const signIn = vi.spyOn(hostedHubController, "signIn").mockResolvedValue();
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    expect(signIn).toHaveBeenCalledOnce();

    await mounted.unmount();
    mounted = null;
    const selectable = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [selectable],
    });
    const selectNode = vi.spyOn(hostedHubController, "selectNode").mockResolvedValue();
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: /^Studio online/ }).click();
    expect(selectNode).toHaveBeenCalledWith(selectable.id);
  });

  it("disables cached node selection while browser access is being revalidated", async () => {
    const selectable = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      browserStatus: "checking-access",
      nodes: [selectable],
    });
    const selectNode = vi.spyOn(hostedHubController, "selectNode").mockResolvedValue();

    mounted = await render(<HostedHubRoot />);

    const nodeButton = page.getByRole("button", { name: /^Studio online/ });
    await expect.element(nodeButton).toBeDisabled();
    expect(selectNode).not.toHaveBeenCalled();
  });

  it("lets an owner review and approve bounded node enrollment metadata", async () => {
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [],
    });
    const lookup = vi.spyOn(hostedHubApi, "lookupNodeEnrollment").mockResolvedValue({
      id: "enr_aaaaaaaaaaaaaaaaaaaaaa",
      label: "Trusted studio",
      platformOs: "darwin",
      platformArch: "arm64",
      clientVersion: "0.1.8",
      algorithm: "ed25519",
      fingerprint: `SHA256:${"a".repeat(43)}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const approve = vi.spyOn(hostedHubApi, "approveNodeEnrollment").mockResolvedValue();
    vi.spyOn(hostedHubController, "refreshDirectory").mockResolvedValue();
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Enroll node" }).click();
    await expect.element(page.getByLabelText("Device code")).toHaveFocus();
    await page.getByLabelText("Device code").fill("SECR-ETCANARY123");
    await page.getByRole("button", { name: "Review node" }).click();

    expect(lookup).toHaveBeenCalledWith("SECR-ETCANARY123", expect.any(AbortSignal));
    await expect
      .element(page.getByRole("heading", { name: "Review node enrollment" }))
      .toBeVisible();
    await expect.element(page.getByText("Trusted studio")).toBeVisible();
    await expect.element(page.getByText(`SHA256:${"a".repeat(43)}`)).toBeVisible();
    expect(JSON.stringify(useHostedHubStore.getState())).not.toContain("ETCANARY123");
    expect(JSON.stringify(localStorage)).not.toContain("ETCANARY123");
    expect(JSON.stringify(sessionStorage)).not.toContain("ETCANARY123");
    expect(location.href).not.toContain("ETCANARY123");

    await page.getByRole("button", { name: "Approve node" }).click();
    expect(approve).toHaveBeenCalledWith("SECR-ETCANARY123", expect.any(AbortSignal));
    await expect.element(page.getByRole("heading", { name: "Node approved" })).toBeVisible();
  });

  it("requires confirmation before denying and hides enrollment from non-owners", async () => {
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [],
    });
    vi.spyOn(hostedHubApi, "lookupNodeEnrollment").mockResolvedValue({
      id: "enr_aaaaaaaaaaaaaaaaaaaaaa",
      label: "Unknown studio",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
      algorithm: "ed25519",
      fingerprint: `SHA256:${"b".repeat(43)}`,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    const deny = vi.spyOn(hostedHubApi, "denyNodeEnrollment").mockResolvedValue();
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Enroll node" }).click();
    await page.getByLabelText("Device code").fill("WXYZ-1234");
    await page.getByRole("button", { name: "Review node" }).click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    expect(deny).not.toHaveBeenCalled();
    await expect.element(page.getByText(/Denial is permanent/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm denial" }).click();
    expect(deny).toHaveBeenCalledWith("WXYZ-1234", expect.any(AbortSignal));

    await mounted.unmount();
    mounted = null;
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account: { ...account, role: "operator" },
      session,
      directoryStatus: "ready",
      nodes: [],
    });
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByRole("button", { name: "Enroll node" })).not.toBeInTheDocument();
  });

  it("expires the hosted session when enrollment authorization is lost", async () => {
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [],
    });
    vi.spyOn(hostedHubApi, "lookupNodeEnrollment").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Enroll node" }).click();
    await page.getByLabelText("Device code").fill("ABCD-EFGH");
    await page.getByRole("button", { name: "Review node" }).click();
    await expect.element(page.getByRole("heading", { name: "Your session expired" })).toBeVisible();
  });

  it("disables revoked nodes and announces authorization removal", async () => {
    const revoked = {
      ...node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "viewer"),
      revokedAt: 2,
      revocationReasonCode: "administrative",
    };
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [revoked],
      selectionStatus: "authorization-removed",
    });
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByRole("alert")).toHaveTextContent(/Authorization.*removed/);
    await expect.element(page.getByRole("button", { name: /^Studio online/ })).toBeDisabled();
    await expect.element(page.getByText("Revoked", { exact: true })).toBeVisible();
  });

  it("announces reconnect, switches nodes, and preserves delivery uncertainty", async () => {
    const current = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
    const replacement = {
      ...node("node_bbbbbbbbbbbbbbbbbbbbbb", true, "owner"),
      label: "Second node",
    };
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [current, replacement],
      selectedNode: current,
      selectionStatus: "online",
      transportStatus: "reconnecting",
      sessionStatus: "stale",
    });
    const selectNode = vi.spyOn(hostedHubController, "selectNode").mockResolvedValue();
    mounted = await render(<HostedNodeMenu />);
    await expect.element(page.getByText("Reconnecting", { exact: true })).toBeVisible();
    await page.getByText("Reconnecting", { exact: true }).click();
    await page.getByRole("button", { name: new RegExp(replacement.label) }).click();
    expect(selectNode).toHaveBeenCalledWith(replacement.id);

    useHostedHubStore.setState({
      transportStatus: "online",
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    await expect.element(page.getByText("Delivery unknown", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/did not resend it automatically/)).toBeVisible();
  });

  it("allows another node after terminal failure ends browser synchronization", async () => {
    const current = node("node_aaaaaaaaaaaaaaaaaaaaaa", true, "operator");
    const replacement = {
      ...node("node_bbbbbbbbbbbbbbbbbbbbbb", true, "owner"),
      label: "Second node",
    };
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      browserStatus: "synchronizing",
      nodes: [current, replacement],
      selectedNode: current,
      selectionStatus: "online",
      effectiveRole: current.effectiveRole,
      transportStatus: "connecting",
      sessionStatus: "synchronizing",
      generation: 9,
    });
    mounted = await render(<HostedNodeMenu />);
    await page.getByText("Synchronizing", { exact: true }).click();
    const replacementButton = page.getByRole("button", { name: new RegExp(replacement.label) });
    await expect.element(replacementButton).toBeDisabled();

    hostedHubController.failure(9, { kind: "incompatible", retryable: false });

    await expect.element(page.getByText("Incompatible", { exact: true })).toBeVisible();
    await expect.element(replacementButton).toBeEnabled();
  });
});

/**
 * The Hub's pages have addresses.
 *
 * Every one of these screens used to be a `useState` discriminator at `/`, so a
 * refresh restored nothing, Back left the Hub instead of stepping out of the
 * ceremony, and no page could be linked or bookmarked.
 */
describe("hosted Hub routes", () => {
  it("gives each signed-out ceremony its own address and restores it on reload", async () => {
    for (const [control, pathname, heading] of [
      ["Redeem invitation", "/invitation", "Redeem your invitation"],
      ["Password, recovery code, or reset", "/sign-in/password", "Sign in with a password"],
    ] as const) {
      mounted = await render(<HostedHubRoot />);
      await page.getByRole("button", { name: control }).click();
      await expect.element(page.getByRole("heading", { name: heading })).toBeVisible();
      expect(window.location.pathname, control).toBe(pathname);

      // A reload is a fresh mount against the same URL.
      await mounted.unmount();
      mounted = await render(<HostedHubRoot />);
      await expect.element(page.getByRole("heading", { name: heading })).toBeVisible();

      await mounted.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
    }
  });

  it("steps back through a ceremony instead of leaving the Hub", async () => {
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Redeem invitation" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Redeem your invitation" }))
      .toBeVisible();

    window.history.back();
    await expect
      .element(page.getByRole("heading", { name: "Connect to your Ryco nodes" }))
      .toBeVisible();
    // Back lands on the Hub home the ceremony was entered from — `/` and
    // `/sign-in` both render the landing page — rather than leaving the site.
    expect(window.location.pathname).not.toBe("/invitation");
  });

  it("names each page in the document title", async () => {
    mounted = await render(<HostedHubRoot />);
    // The Hub home is titled with the bare wordmark; a page adds its own name.
    await vi.waitFor(() => {
      expect(document.title).toContain("Ryco Hub");
    });
    await page.getByRole("button", { name: "Redeem invitation" }).click();
    await vi.waitFor(() => {
      expect(document.title).toContain("Redeem your invitation");
    });
    // Not the desktop client's name or release channel: the Hub is its own
    // product. `branding.ts` would have produced "Ryco (Beta)".
    expect(document.title).toContain("Ryco Hub");
    expect(document.title).not.toContain("(Beta)");
  });
});
