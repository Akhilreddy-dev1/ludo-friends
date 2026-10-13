export type Color = "red" | "green" | "yellow" | "blue";
export const COLORS: Color[] = ["red", "green", "yellow", "blue"];
export type Position =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32
  | 33
  | 34
  | 35
  | 36
  | 37
  | 38
  | 39
  | 40
  | 41
  | 42
  | 43
  | 44
  | 45
  | 46
  | 47
  | 48
  | 49
  | 50
  | 51
  | 52
  | 53
  | 54
  | 55
  | 56;
export interface Token {
  id: number;
  position: Position;
}
export interface Player {
  id: string;
  name: string;
  color: Color;
  ready: boolean;
  connected: boolean;
  tokens: Token[];
}
export interface GameState {
  players: Player[];
  currentPlayerId: string | null;
  phase: "lobby" | "playing" | "finished";
  dice: number | null;
  consecutiveSixes: number;
  turnDeadline: number | null;
  winnerId: string | null;
}
export interface MoveResult {
  moved: boolean;
  captured: boolean;
  winner: boolean;
}

export const START_OFFSETS: Record<Color, number> = {
  red: 1,
  green: 14,
  yellow: 27,
  blue: 40,
};
export const SAFE_CELLS = new Set([1, 9, 14, 22, 27, 35, 40, 48]);

export function createGameState(): GameState {
  return {
    players: [],
    currentPlayerId: null,
    phase: "lobby",
    dice: null,
    consecutiveSixes: 0,
    turnDeadline: null,
    winnerId: null,
  };
}

export function createPlayer(id: string, name: string, color: Color): Player {
  return {
    id,
    name: name.trim().slice(0, 24) || "Player",
    color,
    ready: false,
    connected: true,
    tokens: [0, 1, 2, 3].map((tokenId) => ({ id: tokenId, position: 0 })),
  };
}

export function publicCell(color: Color, position: Position): number | null {
  if (position < 1 || position > 52) return null;
  return ((START_OFFSETS[color] + position - 2) % 52) + 1;
}

export function isLegalMove(token: Token, roll: number): boolean {
  if (roll < 1 || roll > 6) return false;
  return token.position === 0 ? roll === 6 : token.position + roll <= 56;
}

export function legalTokenIds(player: Player, roll: number): number[] {
  return player.tokens
    .filter((token) => isLegalMove(token, roll))
    .map((token) => token.id);
}

export function moveToken(
  state: GameState,
  playerId: string,
  tokenId: number,
  roll: number,
): MoveResult {
  const player = state.players.find((candidate) => candidate.id === playerId);
  const token = player?.tokens.find((candidate) => candidate.id === tokenId);
  if (
    !player ||
    !token ||
    state.phase !== "playing" ||
    !isLegalMove(token, roll)
  )
    return { moved: false, captured: false, winner: false };

  token.position = (
    token.position === 0 ? 1 : token.position + roll
  ) as Position;
  let captured = false;
  const cell = publicCell(player.color, token.position);
  if (cell !== null && !SAFE_CELLS.has(cell)) {
    for (const opponent of state.players) {
      if (opponent.id === playerId) continue;
      for (const opponentToken of opponent.tokens) {
        if (publicCell(opponent.color, opponentToken.position) === cell) {
          opponentToken.position = 0;
          captured = true;
        }
      }
    }
  }
  const winner = player.tokens.every((candidate) => candidate.position === 56);
  if (winner) {
    state.phase = "finished";
    state.winnerId = playerId;
  }
  return { moved: true, captured, winner };
}
