import { Router, type IRouter } from "express";
import type { RoomHub } from "../lib/room-hub";

export function createRoomsRouter(hub: RoomHub): IRouter {
  const router = Router();

  router.get("/rooms/:roomId/status", (req, res) => {
    const token = typeof req.query["token"] === "string" ? req.query["token"] : "";
    const status = hub.status(req.params.roomId, token);
    if (!status) {
      res.status(404).json({ error: "Комната не найдена" });
      return;
    }
    res.json(status);
  });

  return router;
}
