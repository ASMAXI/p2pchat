import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { roomHub } from "./app";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
const webSocketServer = new WebSocketServer({ noServer: true });
roomHub.attach(webSocketServer);

server.on("upgrade", (request, socket, head) => {
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (url.pathname !== "/api/ws") {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit("connection", client, request);
  });
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

void roomHub.init().then(() => {
  server.listen(port, () => {
    logger.info({ port }, "Server listening");
  });
}).catch((err: unknown) => {
  logger.error({ err }, "Could not initialize room store");
  process.exit(1);
});
