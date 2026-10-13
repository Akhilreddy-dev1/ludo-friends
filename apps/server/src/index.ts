import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Ack,
} from "@ludo/shared";
import { RoomManager } from "./room-manager";

const app = express();
app.use(cors());
app.get("/health", (_request, response) => response.json({ ok: true }));
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: "*" },
});
const manager = new RoomManager();
const timers = new Map<string, NodeJS.Timeout>();
const port = Number(process.env.PORT ?? 3001);
const turnSeconds = Math.max(
  15,
  Math.min(30, Number(process.env.TURN_SECONDS ?? 20)),
);

function respond<T>(ack: Ack<T>, action: () => T): void {
  try {
    ack({ ok: true, data: action() });
  } catch (error) {
    ack({
      ok: false,
      error: {
        code: "ACTION_FAILED",
        message: error instanceof Error ? error.message : "Action failed",
      },
    });
  }
}
function broadcast(roomCode: string): void {
  const room = [...io.sockets.sockets].find(
    ([, socket]) => manager.getBySocket(socket.id)?.code === roomCode,
  );
  const data = room ? manager.getBySocket(room[0]) : undefined;
  if (data) io.to(roomCode).emit("snapshot", manager.snapshot(data));
}
function armTimer(roomCode: string): void {
  const room = [...io.sockets.sockets]
    .map(([, socket]) => manager.getBySocket(socket.id))
    .find((candidate) => candidate?.code === roomCode);
  if (!room || room.state.phase !== "playing") return;
  const existing = timers.get(roomCode);
  if (existing) clearTimeout(existing);
  room.state.turnDeadline = Date.now() + room.turnSeconds * 1000;
  timers.set(
    roomCode,
    setTimeout(() => {
      manager.timeout(room);
      broadcast(roomCode);
      armTimer(roomCode);
    }, room.turnSeconds * 1000),
  );
}
io.on("connection", (socket) => {
  const emit = () => {
    const room = manager.getBySocket(socket.id);
    if (room) {
      socket.join(room.code);
      io.to(room.code).emit("snapshot", manager.snapshot(room));
      if (room.state.phase === "playing") armTimer(room.code);
    }
  };
  socket.on("createRoom", (payload, ack) =>
    respond(ack, () => {
      const room = manager.create(
        socket.id,
        payload.name,
        Math.max(15, Math.min(30, payload.turnSeconds ?? turnSeconds)),
      );
      socket.join(room.code);
      emit();
      return { code: room.code };
    }),
  );
  socket.on("joinRoom", (payload, ack) =>
    respond(ack, () => {
      const room = manager.join(socket.id, payload.code, payload.name);
      socket.join(room.code);
      emit();
      return { code: room.code };
    }),
  );
  socket.on("selectColor", (payload, ack) =>
    respond(ack, () => {
      const room = manager.getBySocket(socket.id);
      if (!room) throw new Error("Not in a room");
      manager.selectColor(room, socket.id, payload.color);
      emit();
      return null;
    }),
  );
  socket.on("setReady", (payload, ack) =>
    respond(ack, () => {
      const room = manager.getBySocket(socket.id);
      if (!room) throw new Error("Not in a room");
      manager.setReady(room, socket.id, payload.ready);
      emit();
      return null;
    }),
  );
  socket.on("rollDice", (ack) =>
    respond(ack, () => {
      const room = manager.getBySocket(socket.id);
      if (!room) throw new Error("Not in a room");
      manager.roll(room, socket.id);
      emit();
      return null;
    }),
  );
  socket.on("moveToken", (payload, ack) =>
    respond(ack, () => {
      const room = manager.getBySocket(socket.id);
      if (!room) throw new Error("Not in a room");
      manager.move(room, socket.id, payload.tokenId);
      emit();
      return null;
    }),
  );
  socket.on("leaveRoom", (ack) =>
    respond(ack, () => {
      const room = manager.remove(socket.id);
      if (room) {
        socket.leave(room.code);
        broadcast(room.code);
      }
      return null;
    }),
  );
  socket.on("disconnect", () => {
    const room = manager.remove(socket.id);
    if (room) {
      broadcast(room.code);
      if (room.state.currentPlayerId === socket.id) {
        manager.timeout(room);
        broadcast(room.code);
      }
    }
  });
});
httpServer.listen(port, () =>
  console.log(`Ludo server listening on http://localhost:${port}`),
);
