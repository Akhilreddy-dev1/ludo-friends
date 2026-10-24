import type { GameState } from "@ludo/game-core";

export const OFFLINE_SESSION_VERSION = 1;

export interface OfflineSession {
  version: typeof OFFLINE_SESSION_VERSION;
  humanId: string;
  state: GameState;
  savedAt: number;
}

export function createOfflineSession(
  state: GameState,
  humanId: string,
  savedAt = Date.now(),
): OfflineSession {
  return {
    version: OFFLINE_SESSION_VERSION,
    humanId,
    state: structuredClone(state),
    savedAt,
  };
}

export function encodeOfflineSession(session: OfflineSession): string {
  return JSON.stringify(session);
}

export function decodeOfflineSession(raw: string | null): OfflineSession | null {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<OfflineSession>;
    if (
      value.version !== OFFLINE_SESSION_VERSION ||
      typeof value.humanId !== "string" ||
      !value.humanId ||
      typeof value.savedAt !== "number" ||
      !value.state ||
      !Array.isArray(value.state.players) ||
      !["lobby", "playing", "finished"].includes(value.state.phase ?? "")
    ) {
      return null;
    }

    return value as OfflineSession;
  } catch {
    return null;
  }
}
