export { epochMillis, optionalValue } from "@ryco/shared/changeRequestChecks";

export function sameLogin(left: string | null | undefined, right: string | null | undefined) {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.toLowerCase() === right.toLowerCase()
  );
}
