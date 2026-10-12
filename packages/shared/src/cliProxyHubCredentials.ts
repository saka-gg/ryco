/** Validation shared by the hub form and the node before sending Cloudflare Access headers. */
export function validateCloudflareAccessCredentials(input: {
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly hasSavedSecret?: boolean | undefined;
}): string | null {
  const clientId = input.clientId?.trim() ?? "";
  const clientSecret = input.clientSecret?.trim() ?? "";
  const hasSecret = clientSecret.length > 0 || input.hasSavedSecret === true;
  if (!clientId && !hasSecret) return null;
  if (!clientId || !hasSecret) {
    return "Enter both the Cloudflare Access Client ID and Client Secret, or clear both to connect without a service token.";
  }
  // Service-token values contain printable ASCII without whitespace. Reject malformed values
  // here so neither a header-construction failure nor a pasted newline sends a request.
  if (/[^\x21-\x7e]/.test(clientId) || /[^\x21-\x7e]/.test(clientSecret)) {
    return "Cloudflare Access credentials must not contain spaces, line breaks or non-ASCII characters.";
  }
  return null;
}
