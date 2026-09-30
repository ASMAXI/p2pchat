import { logger } from "./lib/logger";
import { createSyncServer } from "./server";

const rawPort = process.env["PORT"] ?? "5000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const syncServer = createSyncServer({ alwaysHost: true });

syncServer.server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

void syncServer.listen(port, "0.0.0.0").then((boundPort) => {
  logger.info({ port: boundPort, host: "0.0.0.0" }, "Bootstrap node listening");
});
