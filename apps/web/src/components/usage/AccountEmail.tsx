import { cliProxyAccountDisplayName } from "@ryco/client-runtime/usage";
import type { CliProxyAccount } from "@ryco/contracts";

import { cn } from "~/lib/utils";

import { RedactedEmail } from "../settings/RedactedSensitiveText";

/** An account email, blurred until clicked. Shared by provider settings, limits, and the composer. */
export function AccountEmail(props: {
  readonly email: string | undefined;
  readonly prefix?: string;
  readonly separator?: boolean;
  readonly className?: string | undefined;
}) {
  const trimmed = props.email?.trim();
  if (!trimmed) return null;

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      {props.separator ? <span aria-hidden>·</span> : null}
      {props.prefix ? <span className="text-muted-foreground/80">{props.prefix}</span> : null}
      <RedactedEmail email={trimmed} className={props.className} />
    </span>
  );
}

/**
 * A hub account by its blurred email, or by its label or credential file when it has none.
 * Those are usually named after the email, so one that contains an email is blurred too.
 */
export function CliProxyAccountName(props: {
  readonly account: CliProxyAccount;
  readonly className?: string | undefined;
}) {
  const name = cliProxyAccountDisplayName(props.account);
  if (name.sensitive) return <AccountEmail email={name.value} className={props.className} />;
  return (
    <span className={cn("truncate", props.className)} title={name.value}>
      {name.value}
    </span>
  );
}
