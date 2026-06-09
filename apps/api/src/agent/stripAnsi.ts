/** Strip ANSI escape sequences and their remnants from a string.
 *  Handles both full sequences (\x1b[1m) and bare remnants ([1m, [0m])
 *  that remain after the ESC byte is stripped. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[\d*(;\d+)*m/g, '')  // full ANSI: ESC[...m
    .replace(/\[\d+m\]/g, '')                  // bare remnants: [1m], [0m]
    .trim();
}
