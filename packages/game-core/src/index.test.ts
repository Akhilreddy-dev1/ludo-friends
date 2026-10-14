import { describe, expect, it } from "vitest";
import {
  createGameState,
  createPlayer,
  isLegalMove,
  moveToken,
  publicCell,
} from "./index";

describe("ludo rules", () => {
  it("requires a six to leave the yard", () => {
    const player = createPlayer("p", "P", "red");
    expect(isLegalMove(player.tokens[0], 5)).toBe(false);
    expect(isLegalMove(player.tokens[0], 6)).toBe(true);
  });
  it("maps color progress to the shared track", () => {
    expect(publicCell("red", 1)).toBe(1);
    expect(publicCell("green", 1)).toBe(14);
    expect(publicCell("blue", 52)).toBe(39);
    expect(publicCell("red", 53)).toBeNull();
  });
  it("captures on a non-safe cell and sends the opponent home", () => {
    const state = createGameState();
    const red = createPlayer("r", "R", "red");
    const green = createPlayer("g", "G", "green");
    state.players.push(red, green);
    state.phase = "playing";
    red.tokens[0].position = 1;
    green.tokens[0].position = 41;
    expect(publicCell("red", 2)).toBe(publicCell("green", 41));
    const result = moveToken(state, "r", 0, 1);
    expect(result.captured).toBe(true);
    expect(green.tokens[0].position).toBe(0);
  });
  it("requires an exact roll to finish and rejects invalid dice values", () => {
    const token = createPlayer("r", "R", "red").tokens[0];
    token.position = 55;
    expect(isLegalMove(token, 2)).toBe(false);
    expect(isLegalMove(token, 1)).toBe(true);
    expect(isLegalMove(token, 0)).toBe(false);
    expect(isLegalMove(token, 7)).toBe(false);
  });
  it("does not capture a token on a safe square", () => {
    const state = createGameState();
    const red = createPlayer("r", "R", "red");
    const green = createPlayer("g", "G", "green");
    state.players.push(red, green);
    state.phase = "playing";
    red.tokens[0].position = 8;
    green.tokens[0].position = 48;
    expect(publicCell("red", 9)).toBe(9);
    expect(publicCell("green", 48)).toBe(9);
    const result = moveToken(state, "r", 0, 1);
    expect(result.captured).toBe(false);
    expect(green.tokens[0].position).toBe(48);
  });
  it("maps the four start squares to the safe-cell positions", () => {
    expect(publicCell("red", 1)).toBe(1);
    expect(publicCell("green", 1)).toBe(14);
    expect(publicCell("yellow", 1)).toBe(27);
    expect(publicCell("blue", 1)).toBe(40);
  });
});


