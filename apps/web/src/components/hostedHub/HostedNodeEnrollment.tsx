import { AlertTriangleIcon, CheckCircle2Icon, CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import { hostedHubController } from "../../hostedHub/state";
import type { HostedNodeEnrollment } from "../../hostedHub/types";
import { Button } from "../ui/button";
import { DataList, DataListItem } from "../ui/data-list";
import { Input, TOUCH_INPUT_CLASS_NAME } from "../ui/input";
import { Label } from "../ui/label";
import { SlidingTabs, type SlidingTab } from "../ui/sliding-tabs";
import { HubStepIndicator } from "./shell/HubStepIndicator";

export function HostedNodeEnrollmentFlow({ onClose }: { readonly onClose: () => void }) {
  const [input, setInput] = useState("");
  const [enrollment, setEnrollment] = useState<HostedNodeEnrollment | null>(null);
  const [status, setStatus] = useState<
    "input" | "review" | "confirm-denial" | "approved" | "denied"
  >("input");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState<EnrollmentSource>("desktop");
  const hubOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const codeRef = useRef("");
  const operationRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      operationRef.current?.abort();
      operationRef.current = null;
      codeRef.current = "";
    },
    [],
  );

  const startOperation = () => {
    operationRef.current?.abort();
    const operation = new AbortController();
    operationRef.current = operation;
    setPending(true);
    setMessage(null);
    return operation;
  };

  const finishOperation = (operation: AbortController) => {
    if (operationRef.current !== operation) return;
    operationRef.current = null;
    setPending(false);
  };

  const handleFailure = async (error: unknown, fallback?: string) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (error instanceof HostedHubApiError && error.status === 401) {
      codeRef.current = "";
      setInput("");
      setEnrollment(null);
      await hostedHubController.expireSession();
      return;
    }
    setMessage(
      fallback ??
        (error instanceof HostedHubApiError ? error.message : "Hub is temporarily unavailable."),
    );
  };

  const lookup = async (event: FormEvent) => {
    event.preventDefault();
    const deviceCode = input.trim();
    setInput("");
    codeRef.current = "";
    const operation = startOperation();
    try {
      const result = await hostedHubApi.lookupNodeEnrollment(deviceCode, operation.signal);
      if (operation.signal.aborted) return;
      codeRef.current = deviceCode;
      setEnrollment(result);
      setStatus("review");
    } catch (error) {
      await handleFailure(error);
    } finally {
      finishOperation(operation);
    }
  };

  const approve = async () => {
    const deviceCode = codeRef.current;
    if (!deviceCode || !enrollment) return;
    const operation = startOperation();
    try {
      await hostedHubApi.approveNodeEnrollment(deviceCode, operation.signal);
      if (operation.signal.aborted) return;
      codeRef.current = "";
      setEnrollment(null);
      setStatus("approved");
      await hostedHubController.refreshDirectory();
    } catch (error) {
      codeRef.current = "";
      setEnrollment(null);
      setStatus("input");
      await handleFailure(
        error,
        "The approval result is unknown. Enter the device code again to verify its current state.",
      );
    } finally {
      finishOperation(operation);
    }
  };

  const deny = async () => {
    const deviceCode = codeRef.current;
    if (!deviceCode || !enrollment) return;
    const operation = startOperation();
    try {
      await hostedHubApi.denyNodeEnrollment(deviceCode, operation.signal);
      if (operation.signal.aborted) return;
      codeRef.current = "";
      setEnrollment(null);
      setStatus("denied");
    } catch (error) {
      await handleFailure(error);
    } finally {
      finishOperation(operation);
    }
  };

  const close = () => {
    operationRef.current?.abort();
    codeRef.current = "";
    setInput("");
    setEnrollment(null);
    onClose();
  };

  if (status === "approved" || status === "denied") {
    return (
      <div>
        <CheckCircle2Icon aria-hidden className="size-8 text-primary" />
        <h1 className="mt-4 text-2xl font-semibold">
          {status === "approved" ? "Machine added" : "Enrollment denied"}
        </h1>
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {status === "approved"
            ? "It finishes linking on its own and shows up in your nodes within a few seconds."
            : "This ceremony cannot be reused. Start a new enrollment on the node if needed."}
        </p>
        <Button className="mt-5" onClick={close}>
          Back to nodes
        </Button>
      </div>
    );
  }

  if (enrollment) {
    return (
      <div>
        <HubStepIndicator step={2} total={2} label="Review and approve" />
        <h1 className="text-2xl font-semibold tracking-tight">Is this your machine?</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Compare these details with what the machine shows, the fingerprint above all. Approve only
          if every field matches.
        </p>
        {/* The same primitive the node detail sheet uses. The fingerprint is
            the security-critical comparison, and one shared identifier
            treatment is what keeps it from wrapping differently on the two
            screens a reviewer holds side by side. */}
        <DataList className="mt-5 rounded-xl border border-border bg-background p-4">
          <DataListItem term="Label">
            <span className="font-medium break-words">{enrollment.label}</span>
          </DataListItem>
          <DataListItem term="Platform">
            {`${enrollment.platformOs} · ${enrollment.platformArch}`}
          </DataListItem>
          <DataListItem term="Version" mono>
            {enrollment.clientVersion}
          </DataListItem>
          <DataListItem term="Algorithm">{enrollment.algorithm}</DataListItem>
          <DataListItem term="Fingerprint" mono>
            {enrollment.fingerprint}
          </DataListItem>
          <DataListItem term="Expires">
            {new Date(enrollment.expiresAt).toLocaleString()}
          </DataListItem>
        </DataList>
        {message ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {message}
          </p>
        ) : null}
        {status === "confirm-denial" ? (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="flex gap-2 text-sm">
              <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0" /> Denial is
              permanent for this device code.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="destructive" disabled={pending} onClick={() => void deny()}>
                Confirm denial
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => setStatus("review")}>
                Keep reviewing
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => void approve()}>
              {pending ? "Approving…" : "Approve node"}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setStatus("confirm-denial")}
            >
              Deny
            </Button>
            <Button variant="ghost" disabled={pending} onClick={close}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <HubStepIndicator step={1} total={2} label="Enter the device code" />
      <h1 className="text-2xl font-semibold tracking-tight">Add a machine</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        A node is a computer running Ryco. Link it to your account and you can reach its projects
        and agents from any browser.
      </p>

      <ol className="mt-6 space-y-3">
        <EnrollmentStep index={1} title="Start linking on that machine">
          <SlidingTabs
            tabs={ENROLLMENT_SOURCES}
            activeId={source}
            onSelect={(id) => setSource(id as EnrollmentSource)}
            density="compact"
            aria-label="Where Ryco runs"
          />
          {source === "desktop" ? (
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p>
                In Ryco Desktop open <span className="text-foreground">Settings → Hub</span> and
                choose <span className="text-foreground">Connect account</span>. Signing in there
                links the computer on its own, with no code.
              </p>
              <p>
                Using a Hub other than the default? Set its address to{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground text-xs">
                  {hubOrigin}
                </code>{" "}
                first. If Desktop shows a device code, enter it below.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <CommandLine
                command={
                  hubOrigin === DEFAULT_HUB_ORIGIN
                    ? "ryco serve --hub"
                    : `ryco serve --hub --hub-origin ${hubOrigin}`
                }
              />
              <CommandLine command="ryco hub enroll" />
              <p className="text-muted-foreground text-xs">
                No Ryco there yet? Install it first with{" "}
                <code className="font-mono text-foreground">npm install -g ryco-cli</code>.
              </p>
            </div>
          )}
        </EnrollmentStep>

        <EnrollmentStep index={2} title="Enter the code it shows">
          {message ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <form autoComplete="off" onSubmit={(event) => void lookup(event)}>
            <Label htmlFor="hub-node-device-code">Device code</Label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <Input
                id="hub-node-device-code"
                required
                autoFocus
                maxLength={16}
                value={input}
                placeholder="XXXX-XXXX"
                className={`font-mono text-base tracking-[0.2em] uppercase sm:max-w-64 ${TOUCH_INPUT_CLASS_NAME}`}
                onChange={(event) => setInput(event.currentTarget.value)}
              />
              <div className="flex shrink-0 gap-2">
                <Button type="submit" disabled={pending}>
                  {pending ? "Looking up…" : "Review node"}
                </Button>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
              </div>
            </div>
            <p className="mt-2 text-muted-foreground text-xs">
              Codes expire after ten minutes. You compare the machine's details before anything is
              approved.
            </p>
          </form>
        </EnrollmentStep>
      </ol>

      <p className="mt-5 text-muted-foreground text-xs">
        Signing in with a password and two-factor authentication? Run{" "}
        <code className="font-mono text-foreground">ryco hub login</code> on the machine instead and
        skip the code.
      </p>
    </div>
  );
}

type EnrollmentSource = "desktop" | "terminal";

const ENROLLMENT_SOURCES: readonly SlidingTab[] = [
  { id: "desktop" satisfies EnrollmentSource, label: "Desktop app" },
  { id: "terminal" satisfies EnrollmentSource, label: "Terminal" },
];

/** The Hub a bare `--hub` already points at, so the command needs no origin. */
const DEFAULT_HUB_ORIGIN = "https://app.ryco.space";

function EnrollmentStep({
  index,
  title,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="app-surface rounded-2xl border p-4 sm:p-5">
      <h2 className="flex items-center gap-2.5 font-medium text-sm">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/12 font-semibold text-primary text-xs"
        >
          {index}
        </span>
        {title}
      </h2>
      <div className="mt-3 sm:pl-8.5">{children}</div>
    </li>
  );
}

/** One shell command with a copy button; the text is selectable either way. */
function CommandLine({ command }: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
        <span aria-hidden className="select-none text-muted-foreground">
          ${" "}
        </span>
        {command}
      </code>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy command: ${command}`}
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </Button>
    </div>
  );
}
