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
  private sessions = new Map<string, { code: string; playerId: string }>();

  create(socketId: string, name: string, turnSeconds: number, sessionId = socketId): Room {
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
    this.sessions.set(sessionId, { code, playerId: socketId });
    return room;
  }
  join(socketId: string, code: string, name: string, sessionId = socketId): Room {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new Error("Room not found");
    if (room.state.phase !== "lobby") throw new Error("This game has already started");
    if (room.state.players.length >= 4) throw new Error("Room is full");
    const color = COLORS.find(
      (candidate) =>
        !room.state.players.some((player) => player.color === candidate),
    );
    if (!color) throw new Error("No colors available");
    room.state.players.push(createPlayer(socketId, name, color));
    this.socketRooms.set(socketId, room.code);
    this.sessions.set(sessionId, { code: room.code, playerId: socketId });
    return room;
  }
  getBySocket(socketId: string): Room | undefined {
    const code = this.socketRooms.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }
  resume(socketId: string, sessionId: string): Room | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const room = this.rooms.get(session.code);
    const player = room?.state.players.find((candidate) => candidate.id === session.playerId);
    if (!room || !player) return undefined;
    const oldId = player.id;
    this.socketRooms.delete(oldId);
    player.id = socketId;
    player.connected = true;
    this.socketRooms.set(socketId, room.code);
    if (room.hostId === oldId) room.hostId = socketId;
    if (room.state.currentPlayerId === oldId) room.state.currentPlayerId = socketId;
    session.playerId = socketId;
    return room;
  }
  disconnect(socketId: string): Room | undefined {
    const room = this.getBySocket(socketId);
    if (!room) return undefined;
    const player = room.state.players.find((candidate) => candidate.id === socketId);
    if (player) player.connected = false;
    if (room.state.phase === "playing" && room.state.currentPlayerId === socketId) {
      room.state.dice = null;
      this.advance(room);
    }
    return room;
  }
  remove(socketId: string): Room | undefined {
    const room = this.getBySocket(socketId);
    if (!room) return undefined;
    const currentIndex = room.state.players.findIndex(
      (candidate) => candidate.id === socketId,
    );
    const wasCurrent = room.state.currentPlayerId === socketId;
    const nextPlayer = wasCurrent
      ? [...room.state.players.slice(currentIndex + 1), ...room.state.players.slice(0, currentIndex)].find(
          (candidate) => candidate.id !== socketId,
        )
      : undefined;
    room.state.players = room.state.players.filter(
      (candidate) => candidate.id !== socketId,
    );
    this.socketRooms.delete(socketId);
    for (const [sessionId, entry] of this.sessions) {
      if (entry.playerId === socketId) this.sessions.delete(sessionId);
    }
    if (room.hostId === socketId) room.hostId = room.state.players[0]?.id ?? "";
    if (wasCurrent && room.state.phase === "playing") {
      room.state.dice = null;
      room.state.consecutiveSixes = 0;
      room.state.currentPlayerId = nextPlayer?.id ?? room.state.players[0]?.id ?? null;
    }
    if (room.state.players.length === 0) this.rooms.delete(room.code);
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
    if (room.state.phase !== "lobby") throw new Error("Game already started");
    player.ready = ready;
  }
  start(room: Room, socketId: string): void {
    if (room.hostId !== socketId) throw new Error("Only the host can start the game");
    if (room.state.phase !== "lobby") throw new Error("Game already started");
    if (room.state.players.length < 2) throw new Error("At least two players are required");
    if (room.state.players.some((player) => !player.ready || !player.connected))
      throw new Error("Every connected player must be ready");
    room.state.phase = "playing";
    room.state.currentPlayerId = room.state.players[0].id;
  }
  playAgain(room: Room, socketId: string): void {
    if (room.hostId !== socketId) throw new Error("Only the host can start again");
    if (room.state.phase !== "finished") throw new Error("Game is not finished yet");
    const connected = room.state.players.filter((player) => player.connected);
    if (connected.length < 2) throw new Error("At least two players must be connected");
    for (const player of room.state.players) {
      player.tokens.forEach((token) => { token.position = 0; });
      player.ready = !player.connected;
    }
    room.state.phase = "lobby";
    room.state.currentPlayerId = null;
    room.state.dice = null;
    room.state.consecutiveSixes = 0;
    room.state.turnDeadline = null;
    room.state.winnerId = null;
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
    const next = Array.from({ length: players.length }, (_, step) =>
      players[(index + step + 1 + players.length) % players.length],
    ).find((player) => player?.connected);
    room.state.currentPlayerId = next?.id ?? null;
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


