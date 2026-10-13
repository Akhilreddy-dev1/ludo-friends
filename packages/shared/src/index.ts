import type { Color, GameState } from "@ludo/game-core";

export interface RoomSnapshot {
  code: string;
  hostId: string;
  turnSeconds: number;
  state: GameState;
}
export interface ClientToServerEvents {
  createRoom: (
    payload: { name: string; turnSeconds?: number },
    ack: Ack<{ code: string }>,
  ) => void;
  joinRoom: (
    payload: { code: string; name: string },
    ack: Ack<{ code: string }>,
  ) => void;
  selectColor: (payload: { color: Color }, ack: Ack<null>) => void;
  setReady: (payload: { ready: boolean }, ack: Ack<null>) => void;
  rollDice: (ack: Ack<null>) => void;
  moveToken: (payload: { tokenId: number }, ack: Ack<null>) => void;
  leaveRoom: (ack: Ack<null>) => void;
}
export interface ServerToClientEvents {
  snapshot: (snapshot: RoomSnapshot) => void;
  error: (error: { code: string; message: string }) => void;
}
export type Ack<T> = (
  result:
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } },
) => void;
