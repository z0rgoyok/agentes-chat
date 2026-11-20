/**
 * `address` without the slashes it ends with, read from the end. Not by `/\/+$/`: addresses come from outside (a
 * setting, a typed field, a request), and that pattern reads each run of slashes that doesn't end the text again from
 * each of its slashes, quadratic in the run's length.
 */
export function withoutTrailingSlashes(address: string): string {
  let end = address.length;
  while (end > 0 && address.charAt(end - 1) === "/") end--;
  return address.slice(0, end);
}
