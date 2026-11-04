/** `fetch`'s shape, injected so tests never touch the network. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 10_000;

/** `fetch` with a timeout, cancelled by `signal` too; never a request that can hang a run. */
export function request(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetchFn(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

/** Coalesces concurrent calls for one key into one in-flight promise. */
export class Inflight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    let p = this.pending.get(key);
    if (!p) {
      p = work().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }
}
