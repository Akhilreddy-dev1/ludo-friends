import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, User, Users, LogOut, Dice5, Crown, Info } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  COLORS,
  SAFE_CELLS,
  publicCell,
  legalTokenIds,
  moveToken as coreMove,
  createGameState,
  createPlayer,
  type Color,
  type Player,
  type GameState,
  type Token,
} from "@ludo/game-core";
import type {
  ClientToServerEvents,
  RoomSnapshot,
  ServerToClientEvents,
} from "@ludo/shared";
import {
  createOfflineSession,
  decodeOfflineSession,
  encodeOfflineSession,
  type OfflineSession,
} from "@ludo/shared";

// Utility for Tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function colorClasses(color: Color) {
  return {
    red: "bg-red-500 text-red-50",
    green: "bg-green-500 text-green-50",
    yellow: "bg-yellow-400 text-yellow-950",
    blue: "bg-blue-500 text-blue-50",
  }[color];
}

function PlayerCard({
  player,
  active,
  isYou = false,
  showReady = false,
  compact = false,
}: {
  player: Player;
  active: boolean;
  isYou?: boolean;
  showReady?: boolean;
  compact?: boolean;
}) {
  const homeCount = player.tokens.filter(
    (token) => token.position === 56,
  ).length;
  const progress = player.tokens.map((token) =>
    token.position === 56
      ? 100
      : Math.min(92, Math.round((token.position / 56) * 100)),
  );

  return (
    <div
      className={cn(
        "player-card",
        active && "player-card-active",
        compact && "player-card-compact",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn("player-avatar", colorClasses(player.color))}>
          {player.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-bold text-sm text-slate-800">{player.name}</span>
            {isYou && <span className="player-you">You</span>}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span
              className={cn(
                "player-status-dot",
                player.connected ? "bg-emerald-500" : "bg-amber-500",
              )}
            />
            <span>
              {player.connected
                ? active
                  ? "Playing now"
                  : `${homeCount}/4 home`
                : "Reconnecting…"}
            </span>
          </div>
        </div>
      </div>
      {showReady ? (
        <span
          className={cn(
            "player-ready",
            player.ready ? "player-ready-on" : "player-ready-off",
          )}
        >
          {player.ready ? "Ready" : "Waiting"}
        </span>
      ) : (
        <div
          className="player-progress"
          aria-label={`${homeCount} of 4 tokens home`}
        >
          {progress.map((value, index) => (
            <span key={index} className="player-progress-track">
              <span
                className={cn(
                  "player-progress-fill",
                  colorClasses(player.color),
                )}
                style={{ width: `${value}%` }}
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const SERVER_CONFIGURED =
  Boolean(import.meta.env.VITE_SERVER_URL) || import.meta.env.DEV;
const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Mode = "menu" | "bot" | "multiplayer";
const OFFLINE_STORAGE_KEY = "ludo-friends-offline-game";

// ─── Bot AI Logic ──────────────────────────────────────────────────────────────────
function scoreBotMove(
  state: GameState,
  botId: string,
  tokenId: number,
  roll: number,
): number {
  const bot = state.players.find((p) => p.id === botId)!;
  const token = bot.tokens.find((t) => t.id === tokenId)!;
  let score = 0;
  const newPos = token.position === 0 ? 1 : token.position + roll;
  if (newPos === 56) score += 200;
  if (token.position === 0) score += 50;
  const cell = publicCell(bot.color, newPos as never);
  if (cell !== null && !SAFE_CELLS.has(cell)) {
    for (const opp of state.players) {
      if (opp.id === botId) continue;
      for (const ot of opp.tokens) {
        if (publicCell(opp.color, ot.position) === cell) score += 100;
      }
    }
  }
  score += newPos;
  return score;
}

function pickBotToken(state: GameState, botId: string, roll: number): number {
  const bot = state.players.find((p) => p.id === botId)!;
  const legal = legalTokenIds(bot, roll);
  if (legal.length === 0) return -1;
  return legal.reduce((best, id) =>
    scoreBotMove(state, botId, id, roll) >
    scoreBotMove(state, botId, best, roll)
      ? id
      : best,
  );
}

interface BotState {
  gameState: GameState;
  phase: "playing" | "finished";
}

type BotAction =
  | { type: "ROLL"; result: number }
  | { type: "MOVE"; playerId: string; tokenId: number }
  | { type: "ADVANCE" };

const HUMAN_ID = "human";
const BOT_IDS = ["bot-1", "bot-2", "bot-3"];
const BOT_COLORS: Color[] = ["green", "yellow", "blue"];

function makeBotInitialState(saved?: OfflineSession | null): BotState {
  if (saved?.humanId === HUMAN_ID && saved.state.players.length === 4) {
    return {
      gameState: saved.state,
      phase: saved.state.phase === "finished" ? "finished" : "playing",
    };
  }
  const gs = createGameState();
  gs.players.push(createPlayer(HUMAN_ID, "You", "red"));
  BOT_IDS.forEach((id, i) =>
    gs.players.push(createPlayer(id, `Bot ${i + 1}`, BOT_COLORS[i])),
  );
  gs.phase = "playing";
  gs.currentPlayerId = HUMAN_ID;
  return { gameState: gs, phase: "playing" };
}

function loadOfflineState(): BotState {
  if (typeof window === "undefined") return makeBotInitialState();
  const saved = decodeOfflineSession(
    window.localStorage.getItem(OFFLINE_STORAGE_KEY),
  );
  return makeBotInitialState(saved);
}

function botReducer(state: BotState, action: BotAction): BotState {
  if (state.phase === "finished") return state;
  const gs = structuredClone(state.gameState) as GameState;

  switch (action.type) {
    case "ROLL": {
      if (gs.dice !== null) return state;
      gs.dice = action.result;
      gs.consecutiveSixes = action.result === 6 ? gs.consecutiveSixes + 1 : 0;
      if (gs.consecutiveSixes >= 3) {
        gs.dice = null;
        gs.consecutiveSixes = 0;
        const idx = gs.players.findIndex((p) => p.id === gs.currentPlayerId);
        gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
      }
      return { ...state, gameState: gs };
    }
    case "MOVE": {
      if (gs.dice === null) return state;
      const roll = gs.dice;
      const result = coreMove(gs, action.playerId, action.tokenId, roll);
      if (!result.moved) return state;
      gs.dice = null;
      if (result.winner) return { gameState: gs, phase: "finished" };
      if (roll === 6 || result.captured) return { ...state, gameState: gs };
      const idx = gs.players.findIndex((p) => p.id === gs.currentPlayerId);
      gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
      gs.consecutiveSixes = 0;
      return { ...state, gameState: gs };
    }
    case "ADVANCE": {
      gs.dice = null;
      const idx = gs.players.findIndex((p) => p.id === gs.currentPlayerId);
      gs.currentPlayerId = gs.players[(idx + 1) % gs.players.length].id;
      gs.consecutiveSixes = 0;
      return { ...state, gameState: gs };
    }
    default:
      return state;
  }
}

// ─── Components ──────────────────────────────────────────────────────────────────

function Dice3D({
  value,
  rolling,
  onClick,
  disabled,
}: {
  value: number | null;
  rolling: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const [display, setDisplay] = useState(value ?? 1);
  useEffect(() => {
    if (rolling) {
      const interval = setInterval(
        () => setDisplay(Math.floor(Math.random() * 6) + 1),
        80,
      );
      return () => clearInterval(interval);
    } else if (value !== null) {
      setDisplay(value);
    }
  }, [rolling, value]);

  return (
    <motion.button
      whileHover={!disabled ? { scale: 1.06 } : {}}
      whileTap={!disabled ? { scale: 0.94 } : {}}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "dice-cube relative w-20 h-20 bg-gradient-to-b from-white to-slate-50 text-slate-800 rounded-2xl border border-slate-200 shadow-[0_8px_20px_rgba(0,0,0,0.06),inset_0_-2px_4px_rgba(0,0,0,0.03)] flex items-center justify-center text-4xl font-black transition-all",
        rolling && "animate-bounce shadow-[0_12px_28px_rgba(0,0,0,0.12)] ring-4 ring-blue-500/20",
        disabled && "opacity-40 cursor-not-allowed grayscale",
      )}
    >
      {["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][display - 1]}
      {rolling && (
        <div className="absolute inset-0 rounded-2xl bg-blue-500/10 animate-pulse" />
      )}
    </motion.button>
  );
}

// Coordinates mapping for the board
const TRACK_COORDS: readonly [number, number][] = [
  [1, 6],
  [2, 6],
  [3, 6],
  [4, 6],
  [5, 6],
  [6, 5],
  [6, 4],
  [6, 3],
  [6, 2],
  [6, 1],
  [6, 0],
  [7, 0],
  [8, 0],
  [8, 1],
  [8, 2],
  [8, 3],
  [8, 4],
  [8, 5],
  [9, 6],
  [10, 6],
  [11, 6],
  [12, 6],
  [13, 6],
  [14, 6],
  [14, 7],
  [14, 8],
  [13, 8],
  [12, 8],
  [11, 8],
  [10, 8],
  [9, 8],
  [8, 9],
  [8, 10],
  [8, 11],
  [8, 12],
  [8, 13],
  [8, 14],
  [7, 14],
  [6, 14],
  [6, 13],
  [6, 12],
  [6, 11],
  [6, 10],
  [6, 9],
  [5, 8],
  [4, 8],
  [3, 8],
  [2, 8],
  [1, 8],
  [0, 8],
  [0, 7],
  [0, 6],
];
const HOME_LANE_COORDS: Record<Color, readonly [number, number][]> = {
  red: [
    [3, 7],
    [4, 7],
    [5, 7],
  ],
  green: [
    [7, 3],
    [7, 4],
    [7, 5],
  ],
  yellow: [
    [11, 7],
    [10, 7],
    [9, 7],
  ],
  blue: [
    [7, 11],
    [7, 10],
    [7, 9],
  ],
};

function Board({
  players,
  currentPlayerId,
  dice,
  legalIds,
  onMove,
}: {
  players: Player[];
  currentPlayerId: string | null;
  dice: number | null;
  legalIds: number[];
  onMove: (tokenId: number) => void;
}) {
  const cells = useMemo(() => {
    const map = new Map<number, { player: Player; token: Token }[]>();
    players.forEach((player) =>
      player.tokens.forEach((token) => {
        const cell = publicCell(player.color, token.position);
        if (cell !== null)
          map.set(cell, [...(map.get(cell) ?? []), { player, token }]);
      }),
    );
    return map;
  }, [players]);

  const yardTokens = useMemo(() => {
    const map = new Map<string, Token[]>();
    players.forEach((p) => {
      const yard = p.tokens.filter((t) => t.position === 0);
      if (yard.length) map.set(p.id, yard);
    });
    return map;
  }, [players]);

  const laneTokens = useMemo(() => {
    const map = new Map<string, { player: Player; token: Token }[]>();
    players.forEach((p) => {
      p.tokens.forEach((token) => {
        if (token.position >= 53 && token.position <= 55) {
          const key = `${p.color}-${token.position}`;
          map.set(key, [...(map.get(key) ?? []), { player: p, token }]);
        }
      });
    });
    return map;
  }, [players]);

  const homeTokens = useMemo(() => {
    const map = new Map<string, Token[]>();
    players.forEach((p) => {
      const home = p.tokens.filter((t) => t.position === 56);
      if (home.length) map.set(p.id, home);
    });
    return map;
  }, [players]);

  const getPlayerByColor = (color: Color) =>
    players.find((p) => p.color === color);

  return (
    <div className="board-stage">
      <div className="board-surface relative w-full h-full bg-[#FAFAFC] rounded-2xl overflow-hidden shadow-inner border border-slate-200/80">
        {/* Corner Home Bases (Yards) */}
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          const player = getPlayerByColor(color);
          const yardToks = player ? (yardTokens.get(player.id) ?? []) : [];
          const zoneConfig = {
            red: {
              pos: "top-0 left-0",
              bg: "bg-red-500/10 border-red-500/30",
              pocketBg: "bg-red-50 border-red-200",
              text: "text-red-600",
              dot: "bg-red-500",
              label: "RED BASE",
              rounded: "rounded-tl-2xl rounded-tr-lg rounded-bl-lg rounded-br-2xl",
              tokenGrad: "bg-gradient-to-br from-red-500 to-red-600 text-white",
              ring: "ring-red-400 shadow-[0_0_12px_rgba(239,68,68,0.7)]",
            },
            green: {
              pos: "top-0 right-0",
              bg: "bg-green-500/10 border-green-500/30",
              pocketBg: "bg-green-50 border-green-200",
              text: "text-green-600",
              dot: "bg-green-500",
              label: "GREEN BASE",
              rounded: "rounded-tl-lg rounded-tr-2xl rounded-bl-2xl rounded-br-lg",
              tokenGrad: "bg-gradient-to-br from-green-500 to-green-600 text-white",
              ring: "ring-green-400 shadow-[0_0_12px_rgba(34,197,94,0.7)]",
            },
            yellow: {
              pos: "bottom-0 right-0",
              bg: "bg-amber-500/15 border-amber-500/30",
              pocketBg: "bg-amber-50 border-amber-200",
              text: "text-amber-700",
              dot: "bg-amber-500",
              label: "YELLOW BASE",
              rounded: "rounded-tl-2xl rounded-tr-lg rounded-bl-lg rounded-br-2xl",
              tokenGrad: "bg-gradient-to-br from-amber-400 to-amber-500 text-amber-950",
              ring: "ring-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.7)]",
            },
            blue: {
              pos: "bottom-0 left-0",
              bg: "bg-blue-500/10 border-blue-500/30",
              pocketBg: "bg-blue-50 border-blue-200",
              text: "text-blue-600",
              dot: "bg-blue-500",
              label: "BLUE BASE",
              rounded: "rounded-tl-lg rounded-tr-2xl rounded-bl-2xl rounded-br-lg",
              tokenGrad: "bg-gradient-to-br from-blue-500 to-blue-600 text-white",
              ring: "ring-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.7)]",
            },
          }[color];

          return (
            <div
              key={color}
              className={cn("absolute w-[40%] h-[40%] p-1.5 md:p-2.5", zoneConfig.pos)}
            >
              <div
                className={cn(
                  "w-full h-full p-2 md:p-3 border-2 flex flex-col justify-between shadow-sm",
                  zoneConfig.bg,
                  zoneConfig.rounded,
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("w-2 h-2 rounded-full shadow-sm", zoneConfig.dot)} />
                    <span className={cn("text-[9px] md:text-[11px] font-black uppercase tracking-wider", zoneConfig.text)}>
                      {zoneConfig.label}
                    </span>
                  </div>
                  <span className="text-[9px] font-bold text-slate-400 uppercase">
                    {player?.id === HUMAN_ID ? "YOU" : player?.name ?? color}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1.5 md:gap-2.5 p-1 md:p-2 bg-white/80 backdrop-blur-sm rounded-xl border border-slate-100 shadow-[inset_0_1px_3px_rgba(0,0,0,0.03)] place-items-center">
                  {[0, 1, 2, 3].map((slot) => {
                    const tok = yardToks[slot];
                    const isLegal =
                      tok &&
                      player?.id === currentPlayerId &&
                      legalIds.includes(tok.id);
                    return (
                      <div
                        key={slot}
                        className={cn(
                          "w-8 h-8 sm:w-9 sm:h-9 md:w-11 md:h-11 rounded-full border shadow-[inset_0_2px_4px_rgba(0,0,0,0.06)] flex items-center justify-center transition-all",
                          zoneConfig.pocketBg,
                        )}
                      >
                        {tok && (
                          <motion.button
                            whileHover={isLegal ? { scale: 1.15 } : {}}
                            whileTap={isLegal ? { scale: 0.95 } : {}}
                            onClick={() => isLegal && onMove(tok.id)}
                            disabled={!isLegal}
                            className={cn(
                              "w-6 h-6 sm:w-7 sm:h-7 md:w-9 md:h-9 rounded-full font-bold text-[10px] md:text-xs shadow-md flex items-center justify-center transition-all",
                              zoneConfig.tokenGrad,
                              isLegal &&
                                cn(
                                  "ring-4 ring-offset-1 animate-pulse cursor-pointer scale-110",
                                  zoneConfig.ring,
                                ),
                              !isLegal && "cursor-default opacity-85",
                            )}
                          >
                            {tok.id + 1}
                          </motion.button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}

        {/* Center Finish (Apple 4-triangle converging finish) */}
        <div className="absolute inset-[40%] rounded-xl overflow-hidden shadow-inner border border-slate-200/80 bg-white">
          <svg viewBox="0 0 100 100" className="w-full h-full">
            {/* Top Green triangle */}
            <polygon points="0,0 100,0 50,50" fill="#34C759" fillOpacity="0.85" />
            {/* Right Yellow triangle */}
            <polygon points="100,0 100,100 50,50" fill="#FFCC00" fillOpacity="0.9" />
            {/* Bottom Blue triangle */}
            <polygon points="100,100 0,100 50,50" fill="#007AFF" fillOpacity="0.85" />
            {/* Left Red triangle */}
            <polygon points="0,100 0,0 50,50" fill="#FF3B30" fillOpacity="0.85" />
            {/* Central circle */}
            <circle cx="50" cy="50" r="22" fill="#FFFFFF" stroke="#E2E8F0" strokeWidth="2" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-lg md:text-2xl leading-none">🏆</span>
            <span className="text-[8px] md:text-[9px] font-black tracking-widest text-slate-700 mt-0.5">
              HOME
            </span>
          </div>
        </div>

        {/* Decorative Runway Guides */}
        {[
          { color: "red", coords: [[1, 7], [2, 7]], bg: "bg-red-50 border-red-200 text-red-300", arrow: "→" },
          { color: "green", coords: [[7, 1], [7, 2]], bg: "bg-green-50 border-green-200 text-green-300", arrow: "↓" },
          { color: "yellow", coords: [[13, 7], [12, 7]], bg: "bg-amber-50 border-amber-200 text-amber-300", arrow: "←" },
          { color: "blue", coords: [[7, 13], [7, 12]], bg: "bg-blue-50 border-blue-200 text-blue-300", arrow: "↑" },
        ].flatMap(({ coords, bg, arrow }) =>
          coords.map(([x, y]) => (
            <div
              key={`guide-${x}-${y}`}
              className={cn(
                "absolute w-[6.6667%] h-[6.6667%] border rounded-md flex items-center justify-center font-bold text-xs select-none",
                bg,
              )}
              style={{
                left: `${(x * 100) / 15}%`,
                top: `${(y * 100) / 15}%`,
              }}
            >
              {arrow}
            </div>
          )),
        )}

        {/* Home Runway Active Cells (53, 54, 55) */}
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          const laneStyle = {
            red: "bg-red-500 text-white border-red-600 shadow-sm",
            green: "bg-green-500 text-white border-green-600 shadow-sm",
            yellow: "bg-amber-400 text-amber-950 border-amber-500 shadow-sm",
            blue: "bg-blue-500 text-white border-blue-600 shadow-sm",
          }[color];

          return [53, 54, 55].map((pos) => {
            const list = laneTokens.get(`${color}-${pos}`) ?? [];
            return (
              <div
                key={`${color}-${pos}`}
                className={cn(
                  "absolute w-[6.6667%] h-[6.6667%] border rounded-md flex items-center justify-center transition-all",
                  laneStyle,
                )}
                style={{
                  left: `${(HOME_LANE_COORDS[color][pos - 53][0] * 100) / 15}%`,
                  top: `${(HOME_LANE_COORDS[color][pos - 53][1] * 100) / 15}%`,
                }}
              >
                <div className="flex flex-wrap gap-0.5 justify-center items-center w-full h-full p-0.5">
                  {list.map(({ player, token }) => {
                    const isLegal =
                      player.id === currentPlayerId &&
                      legalIds.includes(token.id);
                    return (
                      <motion.button
                        key={`${player.id}-${token.id}`}
                        whileHover={isLegal ? { scale: 1.25 } : {}}
                        onClick={() => isLegal && onMove(token.id)}
                        disabled={!isLegal}
                        className={cn(
                          "w-4 h-4 sm:w-5 sm:h-5 md:w-6 md:h-6 rounded-full font-bold text-[9px] md:text-xs shadow-md flex items-center justify-center transition-all",
                          player.color === "red"
                            ? "bg-red-600 text-white border border-white/60"
                            : player.color === "green"
                              ? "bg-green-600 text-white border border-white/60"
                              : player.color === "yellow"
                                ? "bg-amber-300 text-amber-950 border border-white/60"
                                : "bg-blue-600 text-white border border-white/60",
                          isLegal &&
                            "ring-4 ring-offset-1 ring-white shadow-[0_0_12px_rgba(255,255,255,0.9)] animate-bounce z-20 cursor-pointer",
                          !isLegal && "cursor-default",
                        )}
                      >
                        {token.id + 1}
                      </motion.button>
                    );
                  })}
                </div>
              </div>
            );
          });
        })}

        {/* Track Cells (1 to 52) */}
        {TRACK_COORDS.map((coord, i) => {
          const cellId = i + 1;
          const tokensOnCell = cells.get(cellId) ?? [];
          const isSafe = SAFE_CELLS.has(cellId);

          const isStartRed = cellId === 1;
          const isStartGreen = cellId === 14;
          const isStartYellow = cellId === 27;
          const isStartBlue = cellId === 40;
          const isStart = isStartRed || isStartGreen || isStartYellow || isStartBlue;

          const cellBg = isStartRed
            ? "bg-red-500 text-white font-bold border-red-600"
            : isStartGreen
              ? "bg-green-500 text-white font-bold border-green-600"
              : isStartYellow
                ? "bg-amber-400 text-amber-950 font-bold border-amber-500"
                : isStartBlue
                  ? "bg-blue-500 text-white font-bold border-blue-600"
                  : isSafe
                    ? "bg-amber-50/90 border-amber-200"
                    : "bg-white border-slate-200/90 shadow-[0_1px_2px_rgba(0,0,0,0.04)]";

          return (
            <div
              key={cellId}
              className={cn(
                "absolute w-[6.6667%] h-[6.6667%] border rounded-md flex items-center justify-center transition-all",
                cellBg,
              )}
              style={{
                left: `${(coord[0] * 100) / 15}%`,
                top: `${(coord[1] * 100) / 15}%`,
              }}
            >
              {isSafe && !isStart && tokensOnCell.length === 0 && (
                <div className="text-[10px] md:text-xs text-amber-500 select-none">
                  ⭐
                </div>
              )}
              {isStart && tokensOnCell.length === 0 && (
                <div className="text-[9px] md:text-[11px] font-black leading-none opacity-80 select-none">
                  ➔
                </div>
              )}
              <div className="flex flex-wrap gap-0.5 justify-center items-center w-full h-full p-0.5">
                {tokensOnCell.map(({ player, token }) => {
                  const isLegal =
                    player.id === currentPlayerId &&
                    legalIds.includes(token.id);

                  const colorBg = {
                    red: "bg-gradient-to-br from-red-500 to-red-600 text-white",
                    green: "bg-gradient-to-br from-green-500 to-green-600 text-white",
                    yellow: "bg-gradient-to-br from-amber-400 to-amber-500 text-amber-950",
                    blue: "bg-gradient-to-br from-blue-500 to-blue-600 text-white",
                  }[player.color];

                  const sizeClass =
                    tokensOnCell.length === 1
                      ? "w-4 h-4 sm:w-5 sm:h-5 md:w-6 md:h-6 text-[9px] md:text-[11px]"
                      : "w-3 h-3 sm:w-3.5 sm:h-3.5 md:w-4 md:h-4 text-[7px] md:text-[8px]";

                  return (
                    <motion.button
                      key={`${player.id}-${token.id}`}
                      whileHover={isLegal ? { scale: 1.25 } : {}}
                      onClick={() => isLegal && onMove(token.id)}
                      disabled={!isLegal}
                      className={cn(
                        "rounded-full font-bold shadow-md flex items-center justify-center transition-all",
                        colorBg,
                        sizeClass,
                        isLegal &&
                          "ring-4 ring-offset-1 ring-blue-500 shadow-[0_0_12px_rgba(0,122,255,0.9)] animate-bounce z-20 cursor-pointer",
                        !isLegal && "cursor-default",
                      )}
                    >
                      {token.id + 1}
                    </motion.button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BotGame({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(botReducer, null, loadOfflineState);
  const [rolling, setRolling] = useState(false);
  const { gameState: gs, phase } = state;
  const isMyTurn = gs.currentPlayerId === HUMAN_ID;
  const isBot = BOT_IDS.includes(gs.currentPlayerId ?? "");
  const me = gs.players.find((p) => p.id === HUMAN_ID)!;
  const legal = useMemo(
    () => (isMyTurn && gs.dice ? legalTokenIds(me, gs.dice) : []),
    [isMyTurn, me, gs.dice],
  );

  useEffect(() => {
    window.localStorage.setItem(
      OFFLINE_STORAGE_KEY,
      encodeOfflineSession(createOfflineSession(gs, HUMAN_ID)),
    );
  }, [gs]);

  const rollDice = useCallback(() => {
    if (!isMyTurn || gs.dice !== null || rolling) return;
    setRolling(true);
    setTimeout(() => {
      const result = Math.floor(Math.random() * 6) + 1;
      setRolling(false);
      dispatch({ type: "ROLL", result });
    }, 700);
  }, [isMyTurn, gs.dice, rolling]);

  // Human auto-advance when no legal moves available
  useEffect(() => {
    if (
      !isMyTurn ||
      gs.dice === null ||
      legal.length > 0 ||
      phase === "finished"
    )
      return;
    const t = setTimeout(() => {
      dispatch({ type: "ADVANCE" });
    }, 1100);
    return () => clearTimeout(t);
  }, [isMyTurn, gs.dice, legal.length, phase]);

  useEffect(() => {
    if (!isBot || phase === "finished") return;
    if (gs.dice === null) {
      let rollTimeout: NodeJS.Timeout;
      const thinkTimeout = setTimeout(
        () => {
          setRolling(true);
          rollTimeout = setTimeout(() => {
            setRolling(false);
            const result = Math.floor(Math.random() * 6) + 1;
            dispatch({ type: "ROLL", result });
          }, 450);
        },
        700 + Math.random() * 300,
      );
      return () => {
        clearTimeout(thinkTimeout);
        if (rollTimeout) clearTimeout(rollTimeout);
      };
    } else {
      const delay = 850 + Math.random() * 350;
      const t = setTimeout(() => {
        const tokenId = pickBotToken(gs, gs.currentPlayerId!, gs.dice!);
        if (tokenId === -1) dispatch({ type: "ADVANCE" });
        else dispatch({ type: "MOVE", playerId: gs.currentPlayerId!, tokenId });
      }, delay);
      return () => clearTimeout(t);
    }
  }, [isBot, gs.currentPlayerId, gs.dice, phase]);

  const currentPlayer = gs.players.find((p) => p.id === gs.currentPlayerId);
  const winner =
    phase === "finished" ? gs.players.find((p) => p.id === gs.winnerId) : null;

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-slate-900 p-4 md:p-8 flex flex-col items-center">
      <header className="w-full max-w-6xl flex justify-between items-center mb-8 px-6 py-3.5 bg-white/80 backdrop-blur-xl border border-slate-200/80 rounded-2xl shadow-sm">
        <button
          onClick={onExit}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition-all"
        >
          <LogOut size={15} /> Exit Game
        </button>
        <div className="flex items-center gap-2.5 text-xl font-bold tracking-tight text-slate-900">
          <span className="text-2xl">🎲</span> Ludo
          <span className="text-blue-600">Friends</span>
        </div>
        <div className="flex items-center gap-2.5 bg-slate-100/90 px-4 py-2 rounded-xl border border-slate-200/80">
          <div
            className={cn(
              "w-2.5 h-2.5 rounded-full animate-pulse",
              currentPlayer?.color === "red"
                ? "bg-red-500"
                : currentPlayer?.color === "green"
                  ? "bg-green-500"
                  : currentPlayer?.color === "yellow"
                    ? "bg-yellow-500"
                    : "bg-blue-500",
            )}
          />
          <span className="text-xs font-semibold text-slate-700">
            {isMyTurn ? "Your Turn" : `${currentPlayer?.name}'s Turn`}
          </span>
        </div>
      </header>

      <AnimatePresence>
        {winner && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-4"
          >
            <div className="bg-white p-10 rounded-3xl border border-slate-200 shadow-2xl text-center max-w-sm w-full">
              <Trophy
                size={64}
                className="mx-auto text-amber-500 mb-4 animate-bounce"
              />
              <h2 className="text-3xl font-black text-slate-900 mb-2">
                {winner?.id === HUMAN_ID ? "YOU WIN!" : `${winner?.name} WINS!`}
              </h2>
              <p className="text-slate-500 mb-6 text-sm">
                A legendary victory! 🎲
              </p>
              <button
                onClick={() => {
                  window.localStorage.removeItem(OFFLINE_STORAGE_KEY);
                  onExit();
                }}
                className="w-full py-3.5 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl transition-all shadow-md"
              >
                New Game
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 flex justify-center">
          <Board
            players={gs.players}
            currentPlayerId={gs.currentPlayerId}
            dice={gs.dice}
            legalIds={legal}
            onMove={(id) =>
              dispatch({ type: "MOVE", playerId: HUMAN_ID, tokenId: id })
            }
          />
        </div>

        <aside className="lg:col-span-5 space-y-6">
          <div className="bg-white/85 backdrop-blur-xl p-6 rounded-3xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center gap-2 mb-6 text-slate-400 uppercase text-[11px] font-bold tracking-wider">
              <Dice5 size={14} /> Game Controls
            </div>
            <div className="flex flex-col items-center gap-5">
              <Dice3D
                value={gs.dice}
                rolling={rolling}
                onClick={rollDice}
                disabled={!isMyTurn || gs.dice !== null || rolling}
              />
              <p className="text-center text-sm font-medium text-slate-600 bg-slate-50 border border-slate-200/60 p-3 rounded-xl w-full">
                {isMyTurn
                  ? gs.dice
                    ? legal.length > 0
                      ? "Select a pulsing token to move!"
                      : "No legal moves, skipping..."
                    : rolling
                      ? "Rolling..."
                      : "Roll the dice to start!"
                  : rolling
                    ? `${currentPlayer?.name} is rolling...`
                    : gs.dice
                      ? `${currentPlayer?.name} rolled ${gs.dice}! ${
                          legalTokenIds(currentPlayer!, gs.dice).length === 0
                            ? "No moves, skipping..."
                            : "Moving..."
                        }`
                      : `${currentPlayer?.name} is thinking...`}
              </p>
            </div>
          </div>

          <div className="bg-white/85 backdrop-blur-xl p-6 rounded-3xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center gap-2 mb-5 text-slate-400 uppercase text-[11px] font-bold tracking-wider">
              <Users size={14} /> Players
            </div>
            <div className="space-y-2.5">
              {gs.players.map((p) => (
                <PlayerCard
                  key={p.id}
                  player={p}
                  active={p.id === gs.currentPlayerId}
                  isYou={p.id === HUMAN_ID}
                />
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function MultiplayerEntry({ onExit }: { onExit: () => void }) {
  const [socket] = useState<AppSocket>(() =>
    io(SERVER, { autoConnect: false }),
  );
  const [sessionId] = useState(() => {
    const key = "ludo-friends-session";
    let saved = window.localStorage.getItem(key);
    if (!saved) {
      saved = crypto.randomUUID();
      window.localStorage.setItem(key, saved);
    }
    return saved;
  });
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [rolling, setRolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState("Connecting…");
  const [toast, setToast] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const previousSnapshot = useRef<RoomSnapshot | null>(null);
  const me = snapshot?.state.players.find((p) => p.id === socket.id);

  useEffect(() => {
    if (!SERVER_CONFIGURED) {
      setConnection("Server not configured. Check VITE_SERVER_URL.");
      return () => socket.disconnect();
    }
    socket.on("snapshot", setSnapshot);
    const onConnect = () => {
      setConnection("Connected. Restoring your room…");
      setError("");
      socket.emit("resumeSession", { sessionId }, (result) => {
        setConnection(
          result.ok ? "Room restored." : "Connected. Create or join a room.",
        );
      });
    };
    const onConnectError = () =>
      setConnection("Server unavailable. Check backend.");
    const onDisconnect = () => setConnection("Connection lost. Reconnecting…");
    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);
    socket.connect();
    return () => {
      socket.off("snapshot", setSnapshot);
      socket.off("disconnect", onDisconnect);
      socket.disconnect();
    };
  }, [socket, sessionId]);

  useEffect(() => {
    if (!snapshot?.state.turnDeadline) return;
    const update = () =>
      setSeconds(
        Math.max(
          0,
          Math.ceil((snapshot.state.turnDeadline! - Date.now()) / 1000),
        ),
      );
    update();
    const t = window.setInterval(update, 250);
    return () => clearInterval(t);
  }, [snapshot?.state.turnDeadline]);

  const create = () => {
    if (busy || !socket.connected) return;
    setBusy(true);
    socket.emit("createRoom", { name, sessionId, turnSeconds: 20 }, (r) => {
      setBusy(false);
      if (!r.ok) setError(r.error.message);
    });
  };
  const join = () => {
    if (busy || !socket.connected) return;
    setBusy(true);
    socket.emit("joinRoom", { code, name, sessionId }, (r) => {
      setBusy(false);
      if (!r.ok) setError(r.error.message);
    });
  };

  const legal = useMemo(() => {
    const roll = snapshot?.state.dice;
    return me && roll ? legalTokenIds(me, roll) : [];
  }, [me, snapshot?.state.dice]);

  if (!snapshot) {
    return (
      <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white border border-slate-200/80 p-8 rounded-3xl shadow-xl relative">
          <button
            onClick={onExit}
            className="absolute -top-10 left-0 text-slate-500 hover:text-slate-800 flex items-center gap-2 text-sm font-medium"
          >
            <LogOut size={14} /> Back to Menu
          </button>
          <div className="text-center mb-8">
            <p className="text-blue-600 font-bold text-xs uppercase tracking-widest mb-2">
              Multiplayer
            </p>
            <h2 className="text-3xl font-black text-slate-900">Join the Race</h2>
          </div>
          <div className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-500 uppercase ml-1">
                Your Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Maya"
                className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl focus:ring-2 ring-blue-500 outline-none text-slate-900 font-medium transition-all"
              />
            </div>
            <button
              disabled={!name.trim() || busy || !socket.connected}
              onClick={create}
              className="w-full py-3.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold rounded-xl transition-all shadow-md transform hover:scale-[1.01]"
            >
              🏠 Create a Room
            </button>
            <div className="flex items-center gap-4 py-1">
              <div className="h-px bg-slate-200 flex-1" />
              <span className="text-xs text-slate-400 font-bold uppercase">
                or join
              </span>
              <div className="h-px bg-slate-200 flex-1" />
            </div>
            <div className="flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                className="flex-1 bg-slate-50 border border-slate-200 p-3 rounded-xl uppercase font-mono tracking-widest text-slate-900 outline-none font-bold"
              />
              <button
                disabled={
                  !name.trim() || code.length !== 6 || busy || !socket.connected
                }
                onClick={join}
                className="px-6 py-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold rounded-xl transition-all"
              >
                Join
              </button>
            </div>
            {error && (
              <p className="text-red-500 text-center text-sm font-medium">{error}</p>
            )}
            {connection && (
              <p className="text-slate-400 text-center text-xs italic">
                {connection}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (snapshot.state.phase === "lobby") {
    const choose = (color: Color) =>
      socket.emit("selectColor", { color }, (r) => {
        if (!r.ok) setError(r.error.message);
      });
    return (
      <div className="min-h-screen bg-[#F5F5F7] p-4 md:p-8 flex flex-col items-center">
        <header className="w-full max-w-6xl flex justify-between items-center mb-8 px-6 py-3.5 bg-white/80 backdrop-blur-xl border border-slate-200/80 rounded-2xl shadow-sm">
          <button
            onClick={onExit}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors font-semibold text-xs"
          >
            <LogOut size={15} /> Exit Lobby
          </button>
          <div className="text-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase block tracking-wider">
              Room Code
            </span>
            <strong className="text-2xl font-black tracking-widest text-blue-600">
              {snapshot.code}
            </strong>
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(snapshot.code)}
            className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors font-semibold text-xs"
          >
            📋 Copy Code
          </button>
        </header>
        <div className="w-full max-w-md bg-white border border-slate-200/80 p-8 rounded-3xl shadow-xl">
          <div className="text-center mb-6">
            <p className="text-xs font-bold text-slate-400 uppercase mb-1">
              Lobby • {snapshot.state.players.length}/4 Players
            </p>
            <h2 className="text-2xl font-black text-slate-900">Choose Color</h2>
          </div>
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-2.5">
              {snapshot.state.players.map((p) => (
                <PlayerCard
                  key={p.id}
                  player={p}
                  active={false}
                  isYou={p.id === me?.id}
                  showReady
                  compact
                />
              ))}
            </div>
            <div className="grid grid-cols-4 gap-3">
              {COLORS.map((color) => (
                <button
                  key={color}
                  disabled={snapshot.state.players.some(
                    (p) => p.color === color && p.id !== me?.id,
                  )}
                  onClick={() => choose(color)}
                  className={cn(
                    "h-12 rounded-xl transition-all transform hover:scale-105 shadow-sm",
                    color === "red"
                      ? "bg-red-500"
                      : color === "green"
                        ? "bg-green-500"
                        : color === "yellow"
                          ? "bg-amber-400"
                          : "bg-blue-500",
                    me?.color === color
                      ? "ring-4 ring-offset-2 ring-blue-500 scale-105"
                      : "opacity-60",
                    "disabled:opacity-20 disabled:cursor-not-allowed",
                  )}
                />
              ))}
            </div>
            <button
              onClick={() =>
                socket.emit("setReady", { ready: !me?.ready }, (r) => {
                  if (!r.ok) setError(r.error.message);
                })
              }
              className={cn(
                "w-full py-3.5 font-bold rounded-xl transition-all shadow-md",
                me?.ready
                  ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                  : "bg-blue-600 hover:bg-blue-500 text-white",
              )}
            >
              {me?.ready ? "✓ Ready!" : "Ready Up"}
            </button>
            {me?.id === snapshot.hostId && (
              <button
                disabled={
                  snapshot.state.players.length < 2 ||
                  snapshot.state.players.some((p) => !p.ready || !p.connected)
                }
                onClick={() =>
                  socket.emit("startGame", (r) => {
                    if (!r.ok) setError(r.error.message);
                  })
                }
                className="w-full py-3.5 bg-amber-500 hover:bg-amber-400 text-amber-950 font-bold rounded-xl disabled:opacity-40 transition-all shadow-md"
              >
                Start Game
              </button>
            )}
            <button
              onClick={() => socket.emit("leaveRoom", () => onExit())}
              className="w-full py-2 text-slate-400 text-xs font-semibold hover:text-slate-700 transition-colors"
            >
              Leave Room
            </button>
            {error && (
              <p className="text-red-500 text-center text-sm font-medium">{error}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const current = snapshot.state.currentPlayerId === me?.id;
  const doRoll = () => {
    if (!current || snapshot.state.dice !== null || rolling) return;
    setRolling(true);
    setTimeout(() => {
      setRolling(false);
      socket.emit("rollDice", (r) => {
        if (!r.ok) setError(r.error.message);
      });
    }, 700);
  };

  const currentPlayer = snapshot.state.players.find(
    (p) => p.id === snapshot.state.currentPlayerId,
  );

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-slate-900 p-4 md:p-8 flex flex-col items-center">
      <header className="w-full max-w-6xl flex justify-between items-center mb-8 px-6 py-3.5 bg-white/80 backdrop-blur-xl border border-slate-200/80 rounded-2xl shadow-sm">
        <button
          onClick={onExit}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors font-semibold text-xs"
        >
          <LogOut size={15} /> Exit
        </button>
        <div className="flex items-center gap-2.5 text-xl font-bold tracking-tight text-slate-900">
          <span className="text-2xl">🎲</span> Ludo
          <span className="text-blue-600">Friends</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="bg-slate-100/90 px-4 py-2 rounded-xl border border-slate-200/80 flex items-center gap-2.5">
            <span className="text-[10px] font-bold text-slate-400 uppercase">
              Timer
            </span>
            <strong className="text-lg font-mono text-slate-800">{seconds}s</strong>
          </div>
          <button
            onClick={() => setSoundOn(!soundOn)}
            className="p-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors text-sm"
          >
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </header>

      <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-blue-600 text-white px-6 py-2 rounded-full font-bold shadow-xl text-sm"
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {snapshot.state.winnerId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-4">
          <div className="bg-white p-10 rounded-3xl border border-slate-200 shadow-2xl text-center max-w-sm w-full">
            <Trophy
              size={64}
              className="mx-auto text-amber-500 mb-4 animate-bounce"
            />
            <h2 className="text-3xl font-black text-slate-900 mb-3">
              {snapshot.state.winnerId === me?.id
                ? "You Win!"
                : `${snapshot.state.players.find((p) => p.id === snapshot.state.winnerId)?.name} Wins!`}
            </h2>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => socket.emit("leaveRoom", () => onExit())}
                className="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold transition-all text-sm"
              >
                Leave
              </button>
              {me?.id === snapshot.hostId && (
                <button
                  onClick={() =>
                    socket.emit("playAgain", (r) => {
                      if (!r.ok) setError(r.error.message);
                    })
                  }
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl transition-all text-sm shadow-md"
                >
                  Play Again
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-7 flex justify-center">
          <Board
            players={snapshot.state.players}
            currentPlayerId={snapshot.state.currentPlayerId}
            dice={snapshot.state.dice}
            legalIds={legal}
            onMove={(tokenId) =>
              socket.emit("moveToken", { tokenId }, (r) => {
                if (!r.ok) setError(r.error.message);
              })
            }
          />
        </div>
        <aside className="lg:col-span-5 space-y-6">
          <div className="bg-white/85 backdrop-blur-xl p-6 rounded-3xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center gap-2 mb-6 text-slate-400 uppercase text-[11px] font-bold tracking-wider">
              <Dice5 size={14} /> Game Control
            </div>
            <div className="flex flex-col items-center gap-5">
              <Dice3D
                value={snapshot.state.dice}
                rolling={rolling}
                onClick={doRoll}
                disabled={!current || snapshot.state.dice !== null || rolling}
              />
              <p className="text-center text-sm font-medium text-slate-600 bg-slate-50 border border-slate-200/60 p-3 rounded-xl w-full">
                {current
                  ? snapshot.state.dice
                    ? "Select a pulsing token!"
                    : "Roll the dice to start!"
                  : `${currentPlayer?.name} is rolling...`}
              </p>
            </div>
          </div>
          <div className="bg-white/85 backdrop-blur-xl p-6 rounded-3xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center gap-2 mb-5 text-slate-400 uppercase text-[11px] font-bold tracking-wider">
              <Users size={14} /> Online Players
            </div>
            <div className="space-y-2.5">
              {snapshot.state.players.map((p) => (
                <PlayerCard
                  key={p.id}
                  player={p}
                  active={p.id === snapshot.state.currentPlayerId}
                  isYou={p.id === me?.id}
                />
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function Menu({ onSelect }: { onSelect: (mode: Mode) => void }) {
  const hasSavedOfflineGame =
    typeof window !== "undefined" &&
    Boolean(
      decodeOfflineSession(window.localStorage.getItem(OFFLINE_STORAGE_KEY)),
    );

  return (
    <div className="landing-page">
      <div className="landing-glow landing-glow-one" />
      <div className="landing-glow landing-glow-two" />
      <div className="landing-shell">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="landing-hero"
        >
          <div className="landing-kicker">
            <span className="landing-mark">LF</span>
            <span>Ludo Friends</span>
            <span className="landing-live">
              <span /> Live rooms
            </span>
          </div>
          <h1>
            A small board.
            <br />
            <span>A lot of rivalry.</span>
          </h1>
          <p className="landing-lede">
            A tactile Ludo room for quick matches with friends — or a reliable
            game when the Wi‑Fi disappears.
          </p>
          <div className="landing-stats">
            <span>
              <strong>4</strong> players
            </span>
            <span>
              <strong>1</strong> shared board
            </span>
            <span>
              <strong>0</strong> accounts
            </span>
          </div>
        </motion.div>

        <div className="landing-options">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => onSelect("bot")}
            className="landing-card landing-card-light group"
          >
            <div className="landing-card-top">
              <span className="landing-icon">♟</span>
              <span className="landing-pill">
                {hasSavedOfflineGame ? "Saved locally" : "No account needed"}
              </span>
            </div>
            <div>
              <h2>
                {hasSavedOfflineGame ? "Resume offline game" : "Play offline"}
              </h2>
              <p>
                Three thoughtful opponents, deterministic rules, and a match
                that stays on this device.
              </p>
            </div>
            <span className="landing-action">
              {hasSavedOfflineGame ? "Continue match" : "Start solo"}{" "}
              <span>→</span>
            </span>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => onSelect("multiplayer")}
            className="landing-card landing-card-dark group"
          >
            <div className="landing-card-top">
              <span className="landing-icon">◎</span>
              <span className="landing-pill">2–4 players</span>
            </div>
            <div>
              <h2>Make a room</h2>
              <p>
                Share a short code, choose your colors, and play with the server
                keeping every move fair.
              </p>
            </div>
            <span className="landing-action">
              Create or join <span>→</span>
            </span>
          </motion.button>
        </div>

        <div className="landing-rules">
          <span>4 tokens to finish</span>
          <span>Six to leave yard</span>
          <span>Capture to reset</span>
        </div>
        {hasSavedOfflineGame && (
          <button
            onClick={() => {
              window.localStorage.removeItem(OFFLINE_STORAGE_KEY);
              window.location.reload();
            }}
            className="landing-forget"
          >
            Forget saved offline game
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>("menu");
  if (mode === "bot") return <BotGame onExit={() => setMode("menu")} />;
  if (mode === "multiplayer")
    return <MultiplayerEntry onExit={() => setMode("menu")} />;
  return <Menu onSelect={setMode} />;
}
