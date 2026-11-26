// Compatibility launcher only; no domain routes, templates, or handlers.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationServer } from "../application/server.ts";
import declaration from "./model.ts";

export const createLeaveServer = ({
  directory = resolve("artifacts/leave-data"),
  port = 0,
} = {}) =>
  createApplicationServer(declaration, {
    directory,
    port,
    database: "leave.sqlite",
  });

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await createLeaveServer({
    directory: process.env["LEAVE_DIR"],
    port: Number(process.env["PORT"] ?? 4174),
  });

  console.log(`Time away: ${server.url}`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close().catch(console.error));
  }
}
