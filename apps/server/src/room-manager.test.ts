import { describe, expect, it } from "vitest";
import { RoomManager } from "./room-manager";

describe("room manager", () => {
  it("requires the host to start after everyone is ready and grants a six an extra turn", () => {
    const manager = new RoomManager();
    const room = manager.create("a", "A", 20);
    manager.join("b", room.code, "B");
    manager.setReady(room, "a", true);
    manager.setReady(room, "b", true);
    expect(room.state.phase).toBe("lobby");
    expect(() => manager.start(room, "b")).toThrow("Only the host");
    manager.start(room, "a");
    expect(room.state.phase).toBe("playing");
    manager.roll(room, "a", 6);
    expect(room.state.currentPlayerId).toBe("a");
  });
  it("rejects starting until all players are ready", () => {
    const manager = new RoomManager();
    const room = manager.create("a", "A", 20);
    manager.join("b", room.code, "B");
    manager.setReady(room, "a", true);
    expect(() => manager.start(room, "a")).toThrow("Every connected player");
  });
  it("restores a disconnected player's seat and skips disconnected turns", () => {
    const manager = new RoomManager();
    const room = manager.create("a", "A", 20, "session-a");
    manager.join("b", room.code, "B", "session-b");
    manager.join("c", room.code, "C", "session-c");
    for (const id of ["a", "b", "c"]) manager.setReady(room, id, true);
    manager.start(room, "a");
    manager.disconnect("b");
    manager.roll(room, "a", 1);
    manager.timeout(room);
    expect(room.state.currentPlayerId).toBe("c");
    const resumed = manager.resume("b2", "session-b");
    expect(resumed).toBe(room);
    expect(room.state.players.find((player) => player.name === "B")?.connected).toBe(true);
    expect(manager.getBySocket("b2")).toBe(room);
    expect(manager.getSessionPlayerId("session-b")).toBe("b2");
  });
});

