import { homedir } from "node:os";
import { createConnection } from "vscode-languageserver/node";
import { startServer } from "../../../src/server/server";
import { DiskFS } from "../../../src/vfs/diskfs";

// the transport (--node-ipc or --stdio) comes from the arguments the client starts it with
startServer(createConnection(), { fs: new DiskFS(), env: process.env, home: homedir() });
