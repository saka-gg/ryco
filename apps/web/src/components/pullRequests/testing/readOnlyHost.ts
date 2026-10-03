import {
  getChangeRequestHostCapabilities,
  type ChangeRequestHostCapabilities,
} from "@ryco/shared/sourceControl";

/**
 * A host whose provider implements only list, search, the detail, checkout
 * and create: no activity, diff, checks, review, lifecycle or merge. Pass it
 * as `capabilities` (with a real `host` for the host's terminology) to test
 * the page's read-only fallbacks independently of how far any one host's
 * matrix entry has grown.
 */
export const READ_ONLY_HOST_CAPABILITIES: ChangeRequestHostCapabilities = {
  ...getChangeRequestHostCapabilities("unknown"),
  search: true,
  checkout: true,
  create: { supported: true, draft: false },
};
