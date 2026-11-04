/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  const n = [...s].length;
  for (const k of counts.values()) bits -= (k / n) * Math.log2(k / n);
  return bits;
}

// anchored, no nested quantifiers: these run on text dcx didn't write
const KNOWN: readonly [RegExp, string][] = [
  [/^(?:AKIA|ASIA)[0-9A-Z]{16}$/, "an AWS access key ID"],
  [/^gh[pousr]_[A-Za-z0-9]{36,255}$/, "a GitHub token"],
  [/^github_pat_[A-Za-z0-9_]{60,255}$/, "a GitHub fine-grained token"],
  [/^glpat-[A-Za-z0-9_-]{20,64}$/, "a GitLab token"],
  [/^xox[abposr]-[A-Za-z0-9-]{10,250}$/, "a Slack token"],
  [/^sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,250}$/, "an API secret key"],
  [/^AIza[0-9A-Za-z_-]{35}$/, "a Google API key"],
  [/^-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----/, "a private key"],
];

const SECRET_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|AUTH)(?:_|$)/i;

/** Thresholds for an unrecognised value: long, varied, and no human would type it. */
const NAMED_MIN = { length: 16, entropy: 3.5 };
const GENERIC_MIN = { length: 32, entropy: 4.2 };

/** Why `value` (under env var or build arg `key`) looks like a credential, if it does. */
export function looksLikeSecret(key: string, value: string): string | undefined {
  // a ${...} reference is the right way to pass one in; nothing literal here
  if (value.includes("${")) return undefined;
  const v = value.trim();
  for (const [re, what] of KNOWN) if (re.test(v)) return what;
  // spaces mean prose or flags; a slash without a "+" is a path or URL, not base64
  if (/\s/.test(v) || (v.includes("/") && !v.includes("+"))) return undefined;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(v)).length;
  if (
    SECRET_NAME.test(key) &&
    v.length >= NAMED_MIN.length &&
    entropy(v) >= NAMED_MIN.entropy &&
    classes >= 2
  )
    return `a credential-shaped value for "${key}"`;
  if (v.length >= GENERIC_MIN.length && entropy(v) >= GENERIC_MIN.entropy && classes === 3)
    return "a high-entropy literal";
  return undefined;
}
