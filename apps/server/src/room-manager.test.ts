import { describe, expect, it } from "vitest";
import { RoomManager } from "./room-manager";

describe("room manager", () => {
  it("starts once two players are ready and grants a six an extra turn", () => {
    const manager = new RoomManager();
    const room = manager.create("a", "A", 20);
    manager.join("b", room.code, "B");
    manager.setReady(room, "a", true);
    manager.setReady(room, "b", true);
    expect(room.state.phase).toBe("playing");
    manager.roll(room, "a", 6);
    expect(room.state.currentPlayerId).toBe("a");
  });
});
