/**
 * "Logs", then "Logs 2", "Logs 3" -- several sessions of one kind is the
 * point, so they have to be tellable apart at a glance.
 *
 * Its own module because both places that open a session need it: the rail's
 * catalogue and the subheader's + button.
 */
export function nextTitle(label: string, taken: string[]): string {
  if (!taken.includes(label)) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}
