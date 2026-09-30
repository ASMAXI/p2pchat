import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { createApp } from "./app";
import { RoomHub, type RoomHubOptions } from "./lib/room-hub";

export type SyncServer = {
  hub: RoomHub;
  server: Server;
  listen: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
};

export function createSyncServer(options: RoomHubOptions = {}): SyncServer {
  const hub = new RoomHub(options);
  const server = createServer(createApp(hub));
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  hub.attach(webSocketServer);

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });

  return {
    hub,
    server,
    listen: (port, host = "0.0.0.0") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        hub.close();
        webSocketServer.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
