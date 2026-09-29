import { Router, type IRouter } from "express";
import { z } from "zod";
import { RoomHub } from "../lib/room-hub";

const createRoomSchema = z.object({
  name: z.string().trim().max(80).optional().default("Комната без названия"),
  peerId: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(40),
});

const joinRoomSchema = z.object({
  invite: z.string().trim().min(1).max(1000),
  displayName: z.string().trim().min(1).max(40),
});

export function createRoomsRouter(hub: RoomHub): IRouter {
  const router = Router();

  router.post("/rooms", async (req, res) => {
    const input = createRoomSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Некорректные данные комнаты", details: input.error.flatten() });
      return;
    }
    const result = await hub.createRoom({
      name: input.data.name,
      ownerId: input.data.peerId,
      displayName: input.data.displayName,
    });
    res.status(201).json({
      room: result.state,
      invite: result.invite,
      inviteToken: result.inviteToken,
    });
  });

  router.post("/rooms/join", async (req, res) => {
    const input = joinRoomSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Некорректные данные приглашения", details: input.error.flatten() });
      return;
    }
    try {
      const result = hub.joinByInvite(input.data);
      res.json({ room: result.state });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : "Комната не найдена" });
    }
  });

  return router;
}