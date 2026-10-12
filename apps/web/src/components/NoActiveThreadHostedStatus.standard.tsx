/**
 * Standard-build stand-in for `./NoActiveThreadHostedStatus` (wired by
 * `src/clientModeSeams.ts`): the empty thread surface shows the hosted section
 * only in hosted-hub builds, so standard builds render nothing here.
 */
type Hosted = typeof import("./NoActiveThreadHostedStatus");

export const NoActiveThreadHostedStatus: (
  ...args: Parameters<Hosted["NoActiveThreadHostedStatus"]>
) => null = () => null;
