/** What the server and its clients both need, kept free of imports so a client stays small. */

/** Applies every fix to the document named by its one argument; answers whether it changed anything. */
export const FIX_ALL_COMMAND = "dcx.server.fixAll";

export const isDevcontainer = (path: string) => /(^|[\\/])\.?devcontainer\.json$/.test(path);
