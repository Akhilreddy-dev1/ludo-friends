import { describe, expect, it } from "vitest";
import { createGameState, createPlayer } from "@ludo/game-core";
import {
  createOfflineSession,
  decodeOfflineSession,
  encodeOfflineSession,
} from "./offline";

describe("offline session persistence", () => {
  it("round-trips a game state without sharing mutable state", () => {
    const state = createGameState();
    state.players.push(createPlayer("human", "You", "red"));

    const session = createOfflineSession(state, "human", 123);
    const restored = decodeOfflineSession(encodeOfflineSession(session));

    expect(restored?.humanId).toBe("human");
    expect(restored?.savedAt).toBe(123);
    expect(restored?.state.players[0]?.name).toBe("You");

    state.players[0].name = "Changed";
    expect(restored?.state.players[0]?.name).toBe("You");
  });

  it("rejects malformed or unsupported saved data", () => {
    expect(decodeOfflineSession(null)).toBeNull();
    expect(decodeOfflineSession("not-json")).toBeNull();
    expect(decodeOfflineSession(JSON.stringify({ version: 99 }))).toBeNull();
  });
});
