import {
  COLORS,
  createGameState,
  createPlayer,
  legalTokenIds,
  moveToken,
  type Color,
  type GameState,
} from "@ludo/game-core";
import type { RoomSnapshot } from "@ludo/shared";

export interface Room {
  code: string;
  hostId: string;
  turnSeconds: number;
  state: GameState;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private socketRooms = new Map<string, string>();

  create(socketId: string, name: string, turnSeconds: number): Room {
    const code = this.newCode();
    const room: Room = {
      code,
      hostId: socketId,
      turnSeconds,
      state: createGameState(),
    };
    room.state.players.push(createPlayer(socketId, name, "red"));
    this.rooms.set(code, room);
    this.socketRooms.set(socketId, code);
    return room;
  }
  join(socketId: string, code: string, name: string): Room {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new Error("Room not found");
    if (room.state.players.length >= 4) throw new Error("Room is full");
    const color = COLORS.find(
      (candidate) =>
        !room.state.players.some((player) => player.color === candidate),
    );
    if (!color) throw new Error("No colors available");
    room.state.players.push(createPlayer(socketId, name, color));
    this.socketRooms.set(socketId, room.code);
    return room;
  }
  getBySocket(socketId: string): Room | undefined {
    const code = this.socketRooms.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }
  remove(socketId: string): Room | undefined {
    const room = this.getBySocket(socketId);
    if (!room) return undefined;
    const player = room.state.players.find(
      (candidate) => candidate.id === socketId,
    );
    if (player) player.connected = false;
    this.socketRooms.delete(socketId);
    if (room.state.players.every((candidate) => !candidate.connected))
      this.rooms.delete(room.code);
    return room;
  }
  snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      hostId: room.hostId,
      turnSeconds: room.turnSeconds,
      state: room.state,
    };
  }
  selectColor(room: Room, socketId: string, color: Color): void {
    if (
      !COLORS.includes(color) ||
      room.state.players.some(
        (player) => player.id !== socketId && player.color === color,
      )
    )
      throw new Error("Color unavailable");
    const player = room.state.players.find(
      (candidate) => candidate.id === socketId,
    );
    if (!player || room.state.phase !== "lobby")
      throw new Error("Cannot change color now");
    player.color = color;
  }
  setReady(room: Room, socketId: string, ready: boolean): void {
    const player = room.state.players.find(
      (candidate) => candidate.id === socketId,
    );
    if (!player) throw new Error("Player not found");
    player.ready = ready;
    if (
      room.state.players.length >= 2 &&
      room.state.players.every(
        (candidate) => candidate.ready && candidate.connected,
      )
    ) {
      room.state.phase = "playing";
      room.state.currentPlayerId = room.state.players[0].id;
    }
  }
  roll(
    room: Room,
    socketId: string,
    random = Math.floor(Math.random() * 6) + 1,
  ): number {
    if (
      room.state.phase !== "playing" ||
      room.state.currentPlayerId !== socketId
    )
      throw new Error("Not your turn");
    if (room.state.dice !== null) throw new Error("Choose a token first");
    room.state.dice = random;
    room.state.consecutiveSixes =
      random === 6 ? room.state.consecutiveSixes + 1 : 0;
    if (room.state.consecutiveSixes >= 3) {
      room.state.dice = null;
      room.state.consecutiveSixes = 0;
      this.advance(room);
      return random;
    }
    return random;
  }
  move(room: Room, socketId: string, tokenId: number): void {
    const roll = room.state.dice;
    const player = room.state.players.find(
      (candidate) => candidate.id === socketId,
    );
    if (
      room.state.phase !== "playing" ||
      room.state.currentPlayerId !== socketId ||
      roll === null ||
      !player
    )
      throw new Error("Move not allowed");
    if (!legalTokenIds(player, roll).includes(tokenId))
      throw new Error("Illegal token");
    const result = moveToken(room.state, socketId, tokenId, roll);
    room.state.dice = null;
    if (!result.winner && (roll === 6 || result.captured)) return;
    this.advance(room);
  }
  timeout(room: Room): void {
    if (room.state.phase === "playing") {
      room.state.dice = null;
      this.advance(room);
    }
  }
  private advance(room: Room): void {
    const players = room.state.players;
    const index = players.findIndex(
      (player) => player.id === room.state.currentPlayerId,
    );
    room.state.currentPlayerId =
      players[(index + 1) % players.length]?.id ?? null;
    room.state.consecutiveSixes = 0;
  }
  private newCode(): string {
    let code = "";
    do {
      code = Math.random().toString(36).slice(2, 8).toUpperCase();
    } while (this.rooms.has(code));
    return code;
  }
}
