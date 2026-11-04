/** The contents of the first file in a tar archive whose name (minus any `./`) is `name`. */
export function tarFile(tar: Uint8Array, name: string): Uint8Array | undefined {
  const decoder = new TextDecoder();
  const field = (at: number, len: number) =>
    decoder.decode(tar.subarray(at, at + len)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= tar.length;) {
    const header = field(at, 100);
    if (!header) return undefined;
    const prefix = field(at + 345, 155);
    const size = parseInt(field(at + 124, 12).trim() || "0", 8);
    const path = (prefix ? `${prefix}/${header}` : header).replace(/^\.\//, "");
    const type = field(at + 156, 1);
    const start = at + 512;
    if (path === name && (type === "0" || type === "")) return tar.subarray(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}
