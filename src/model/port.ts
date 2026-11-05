/** A port as `forwardPorts`, `appPort` and `portsAttributes` keys write it. */
export interface PortSpec {
  /** `localhost` when none is given. */
  readonly host: string;
  readonly port: number;
  /** Set only for a `start-end` range. */
  readonly end?: number;
}

export const MAX_PORT = 65535;

export const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_PORT;

const NUMBER = /^[0-9]{1,6}$/;

/**
 * A bare port, `host:port`, or (`ranges` only) `start-end`. Undefined for anything else;
 * numbers out of 1–65535 still parse, so the range check can say what's wrong with them.
 */
export function parsePort(value: unknown, ranges = false): PortSpec | undefined {
  if (typeof value === "number")
    return Number.isInteger(value) ? { host: "localhost", port: value } : undefined;
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (NUMBER.test(s)) return { host: "localhost", port: Number(s) };
  const dash = /^([0-9]{1,6})-([0-9]{1,6})$/.exec(s);
  if (ranges && dash) return { host: "localhost", port: Number(dash[1]), end: Number(dash[2]) };
  const colon = s.lastIndexOf(":");
  if (colon > 0 && NUMBER.test(s.slice(colon + 1)) && /^[A-Za-z0-9.-]+$/.test(s.slice(0, colon)))
    return { host: s.slice(0, colon).toLowerCase(), port: Number(s.slice(colon + 1)) };
  return undefined;
}

/** Whether `spec` (a port, or a range) includes `port` on `host`. */
export function covers(spec: PortSpec, port: PortSpec): boolean {
  const sameHost =
    spec.host === port.host || spec.host === "localhost" || port.host === "localhost";
  return sameHost && port.port >= spec.port && port.port <= (spec.end ?? spec.port);
}

/** A `portsAttributes` key that's a regular expression, as VS Code also accepts. */
export function isPattern(key: string): boolean {
  if (!/[\\^$*+?()[\]{}|]/.test(key)) return false;
  try {
    new RegExp(key);
    return true;
  } catch {
    return false;
  }
}
