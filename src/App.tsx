import React, { useEffect, useMemo, useState } from 'react';
import {
  Satellite,
  Rocket,
  Crosshair,
  ShieldAlert,
  Users,
  Bot,
  BookOpen,
  ArrowLeft,
  EyeOff,
} from 'lucide-react';
import { motion } from 'motion/react'; // If this fails, use: import { motion } from 'framer-motion';

// --- Core game configuration ---
const GRID_W = 12; // total columns (0-11)
const GRID_H = 5; // total orbital lanes (0-4)
const A_MIN_X = 5; // Evader min boundary (column 6)
const A_MAX_X = 9; // Evader max boundary (column 10)
const WIN_TIME = 2;
const MAX_TURNS = 20;

type Player = 'A' | 'B'; // A = Evader (Blue), B = Pursuer (Red)
type Screen = 'home' | 'instructions' | 'aiRoleSelect' | 'match';
type MatchPhase = 'playing' | 'gameover';
type Mode = 'hotseat' | 'ai';

type Pos = { x: number; y: number };

// --- Curved board layout helper ---
const getCurvedPos = (x: number, y: number) => {
  const dx = x - 5.5; // center axis
  const curveY = Math.pow(dx, 2) * 1.5;
  const rotate = dx * 2.5;

  return {
    x: x * 52 + 70,
    y: y * 52 + curveY + 50,
    rotate,
  };
};

const chebyshevDist = (p1: Pos, p2: Pos) =>
  Math.max(Math.abs(p1.x - p2.x), Math.abs(p1.y - p2.y));

const moveDxFromOrb = (selectedY: number) => selectedY - 2;

const RULES_TEXT = [
  'Blind planning: the Evader plans first, then the Pursuer plans, and both moves resolve simultaneously.',
  'The Evader (Blue) can only move within the central 5 columns (columns 6-10).',
  'The Pursuer (Red) can move across the full map and has a 3x3 lock zone.',
  `If the Pursuer keeps the Evader inside the lock zone for ${WIN_TIME} consecutive turns, the Pursuer wins.`,
  `If the Evader survives until Turn ${MAX_TURNS}, the Evader wins.`,
];

const BACKGROUND_TEXT = [
  'This game is inspired by the orbital pursuit-evasion problem, where a pursuing satellite attempts to lock onto a target satellite while the target performs evasive maneuvers.',
  'Here, discrete orbital lanes (Orb 1-5) and lateral drift (left2/left1/stay/right1/right2) are used to model maneuver decisions.',
  "The Pursuer's 3x3 lock zone represents a sensing/engagement/capture window, while the Evader aims to survive under constrained mobility.",
  'This abstraction is suitable for extensions into game theory, reinforcement learning, risk-aware control, and strategy search.',
];

const INITIAL_A_POS: Pos = { x: 7, y: 2 };
const INITIAL_B_POS: Pos = { x: 1, y: 2 };

export default function App() {
  // Screen flow
  const [screen, setScreen] = useState<Screen>('home');

  // Match mode
  const [mode, setMode] = useState<Mode | null>(null);
  const [humanRole, setHumanRole] = useState<Player | null>(null); // In AI mode: which side the human plays

  // Match runtime state
  const [matchPhase, setMatchPhase] = useState<MatchPhase>('playing');
  const [currentPlayer, setCurrentPlayer] = useState<Player>('A');

  const [aPos, setAPos] = useState<Pos>(INITIAL_A_POS);
  const [bPos, setBPos] = useState<Pos>(INITIAL_B_POS);

  const [pendingAMove, setPendingAMove] = useState<Pos | null>(null);
  const [turn, setTurn] = useState(1);
  const [bTimeInRange, setBTimeInRange] = useState(0);
  const [winner, setWinner] = useState<Player | null>(null);

  const isAIMode = mode === 'ai';

  // Precompute board positions
  const gridPosMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getCurvedPos>>();
    for (let y = -1; y < GRID_H; y++) {
      for (let x = -1; x < GRID_W; x++) {
        map.set(`${x},${y}`, getCurvedPos(x, y));
      }
    }
    return map;
  }, []);

  const posOf = (x: number, y: number) => gridPosMap.get(`${x},${y}`) ?? getCurvedPos(x, y);

  const isValidMove = (player: Player, fromX: number, selectedY: number) => {
    if (selectedY < 0 || selectedY >= GRID_H) return false;
    const dx = moveDxFromOrb(selectedY);
    const nextX = fromX + dx;

    if (player === 'A') return nextX >= A_MIN_X && nextX <= A_MAX_X;
    return nextX >= 0 && nextX < GRID_W;
  };

  const getValidOrbs = (player: Player, fromX: number) =>
    [0, 1, 2, 3, 4].filter((y) => isValidMove(player, fromX, y));

  const calcNextPos = (from: Pos, selectedY: number): Pos => ({
    x: from.x + moveDxFromOrb(selectedY),
    y: selectedY,
  });

  const resetMatchCore = () => {
    setAPos(INITIAL_A_POS);
    setBPos(INITIAL_B_POS);
    setTurn(1);
    setBTimeInRange(0);
    setWinner(null);
    setCurrentPlayer('A');
    setPendingAMove(null);
    setMatchPhase('playing');
  };

  const startHotseat = () => {
    setMode('hotseat');
    setHumanRole(null);
    resetMatchCore();
    setScreen('match');
  };

  const startAIMatch = (role: Player) => {
    setMode('ai');
    setHumanRole(role);
    resetMatchCore();
    setScreen('match');
  };

  const backToHome = () => {
    setScreen('home');
  };

  const backToMenuFromMatch = () => {
    setScreen('home');
  };

  const resolveTurn = (finalA: Pos, nextB: Pos) => {
    setAPos(finalA);
    setBPos(nextB);

    const dist = chebyshevDist(finalA, nextB);
    const newTimeInRange = dist <= 1 ? bTimeInRange + 1 : 0;
    setBTimeInRange(newTimeInRange);

    // Win condition: Pursuer priority if both happen on the same turn
    if (newTimeInRange >= WIN_TIME) {
      setMatchPhase('gameover');
      setWinner('B');
      return;
    }

    if (turn >= MAX_TURNS) {
      setMatchPhase('gameover');
      setWinner('A');
      return;
    }

    setTurn((t) => t + 1);
    setCurrentPlayer('A');
    setPendingAMove(null);
  };

  const handlePlayerMove = (selectedY: number) => {
    if (screen !== 'match' || matchPhase !== 'playing') return;

    if (currentPlayer === 'A') {
      if (!isValidMove('A', aPos.x, selectedY)) return;

      const nextA = calcNextPos(aPos, selectedY);
      setPendingAMove(nextA);
      setCurrentPlayer('B');
      return;
    }

    // currentPlayer === 'B'
    if (!isValidMove('B', bPos.x, selectedY)) return;

    const nextB = calcNextPos(bPos, selectedY);
    const finalA = pendingAMove || aPos;
    resolveTurn(finalA, nextB);
  };

  // --- Simple AI policy ---
  const pickAIMove = (player: Player): number => {
    const validMoves =
      player === 'A' ? getValidOrbs('A', aPos.x) : getValidOrbs('B', bPos.x);

    if (validMoves.length === 0) return 2;

    if (player === 'A') {
      // Evader: maximize distance, slight preference for center
      let bestScore = -Infinity;
      let best: number[] = [];

      for (const y of validMoves) {
        const nextA = calcNextPos(aPos, y);
        const dist = chebyshevDist(nextA, bPos);
        const centerBias = -Math.abs(nextA.x - 7);
        const score = dist * 10 + centerBias;

        if (score > bestScore) {
          bestScore = score;
          best = [y];
        } else if (score === bestScore) {
          best.push(y);
        }
      }

      return best[Math.floor(Math.random() * best.length)];
    }

    // Pursuer: minimize distance (target pending Evader move if available)
    const targetA = pendingAMove || aPos;

    let bestScore = -Infinity;
    let best: number[] = [];

    for (const y of validMoves) {
      const nextB = calcNextPos(bPos, y);
      const dist = chebyshevDist(targetA, nextB);

      let score = -dist * 10;

      if (dist <= 1) {
        score += 120;
        if (bTimeInRange + 1 >= WIN_TIME) score += 100;
      }

      score += -Math.abs(nextB.x - targetA.x);

      if (score > bestScore) {
        bestScore = score;
        best = [y];
      } else if (score === bestScore) {
        best.push(y);
      }
    }

    return best[Math.floor(Math.random() * best.length)];
  };

  // --- AI auto-action ---
  useEffect(() => {
    if (screen !== 'match') return;
    if (matchPhase !== 'playing') return;
    if (!isAIMode) return;
    if (!humanRole) return;

    const aiRole: Player = humanRole === 'A' ? 'B' : 'A';
    if (currentPlayer !== aiRole) return;

    const timer = window.setTimeout(() => {
      const aiMove = pickAIMove(aiRole);
      handlePlayerMove(aiMove);
    }, 600);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    screen,
    matchPhase,
    isAIMode,
    humanRole,
    currentPlayer,
    aPos,
    bPos,
    pendingAMove,
    bTimeInRange,
    turn,
  ]);

  const isHumanTurn = (() => {
    if (screen !== 'match' || matchPhase !== 'playing') return false;
    if (mode === 'hotseat') return true;
    if (mode === 'ai') return humanRole === currentPlayer;
    return false;
  })();

  const currentModeLabel =
    mode === 'hotseat'
      ? 'Hotseat Mode'
      : mode === 'ai'
      ? 'AI Match'
      : 'No Mode Selected';

  // ---------------------------
  // Screen 1: Home (title + three options)
  // ---------------------------
  if (screen === 'home') {
    return (
      <div className="min-h-screen bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="relative w-full max-w-3xl rounded-3xl border border-slate-700/70 bg-slate-900/70 backdrop-blur-xl shadow-[0_0_60px_rgba(30,58,138,0.25)] p-8 md:p-10 overflow-hidden"
        >
          <div className="absolute -bottom-24 left-1/2 -translate-x-1/2 w-[700px] h-[260px] bg-blue-500/15 blur-[70px] rounded-[100%] pointer-events-none" />
          <div className="absolute top-8 right-8 w-40 h-40 bg-red-500/10 blur-3xl rounded-full pointer-events-none" />

          <div className="relative z-10 text-center mb-8">
            <div className="flex justify-center items-center gap-5 mb-4">
              <Satellite size={44} className="text-blue-400" />
              <Rocket size={44} className="text-red-400" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white drop-shadow-lg">
              Orbital Pursuit
            </h1>
            <p className="text-slate-400 mt-2 text-sm md:text-base">
              Satellite Pursuit-Evasion · Blind Turn-Based Strategy Game
            </p>
          </div>

          <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              onClick={startHotseat}
              className="group rounded-2xl border border-slate-700 bg-slate-900/60 hover:bg-slate-800/80 p-5 text-left transition-all hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(255,255,255,0.06)]"
            >
              <div className="flex items-center gap-3 mb-3">
                <Users className="text-cyan-300" size={22} />
                <span className="text-white font-bold text-lg">Hotseat Mode</span>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                Two local players take turns planning moves, then resolve simultaneously.
              </p>
            </button>

            <button
              onClick={() => setScreen('aiRoleSelect')}
              className="group rounded-2xl border border-slate-700 bg-slate-900/60 hover:bg-slate-800/80 p-5 text-left transition-all hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(59,130,246,0.15)]"
            >
              <div className="flex items-center gap-3 mb-3">
                <Bot className="text-violet-300" size={22} />
                <span className="text-white font-bold text-lg">AI Match</span>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                Choose to play as the Pursuer or Evader and compete against an AI opponent.
              </p>
            </button>

            <button
              onClick={() => setScreen('instructions')}
              className="group rounded-2xl border border-slate-700 bg-slate-900/60 hover:bg-slate-800/80 p-5 text-left transition-all hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(239,68,68,0.08)]"
            >
              <div className="flex items-center gap-3 mb-3">
                <BookOpen className="text-amber-300" size={22} />
                <span className="text-white font-bold text-lg">Instructions</span>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                View game rules, win conditions, and the orbital pursuit-evasion background.
              </p>
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // ---------------------------
  // Screen 2: Instructions
  // ---------------------------
  if (screen === 'instructions') {
    return (
      <div className="min-h-screen bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black text-slate-200 p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={backToHome}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-700 bg-slate-900/70 hover:bg-slate-800/80 transition"
            >
              <ArrowLeft size={18} />
              Back to Home
            </button>

            <div className="text-right">
              <h2 className="text-2xl md:text-3xl font-bold text-white">Instructions</h2>
              <p className="text-slate-400 text-sm">Rules & Background</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <motion.div
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              className="rounded-2xl border border-slate-700/70 bg-slate-900/70 backdrop-blur-xl p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <BookOpen className="text-cyan-300" size={22} />
                <h3 className="text-xl font-bold text-white">Game Rules</h3>
              </div>

              <div className="space-y-3 text-slate-300 text-sm leading-7">
                {RULES_TEXT.map((item, idx) => (
                  <p key={idx}>
                    <span className="text-cyan-300 font-mono mr-2">{idx + 1}.</span>
                    {item}
                  </p>
                ))}
              </div>

              <div className="mt-5 p-4 rounded-xl border border-slate-800 bg-slate-950/50 text-sm text-slate-400 leading-6">
                <p className="mb-1 text-slate-300 font-semibold">Move Mapping</p>
                <p>
                  Choosing <span className="font-mono text-slate-200">Orb y</span> sets the next lane,
                  and the lateral shift is{' '}
                  <span className="font-mono text-slate-200">dx = y - 2</span>:{" "}
                  <span className="font-mono">←2, ←1, Stay, →1, →2</span>.
                </p>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              className="rounded-2xl border border-slate-700/70 bg-slate-900/70 backdrop-blur-xl p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <Satellite className="text-blue-300" size={22} />
                <h3 className="text-xl font-bold text-white">Background: Orbital Pursuit-Evasion</h3>
              </div>

              <div className="space-y-3 text-slate-300 text-sm leading-7">
                {BACKGROUND_TEXT.map((item, idx) => (
                  <p key={idx}>
                    <span className="text-blue-300 font-mono mr-2">•</span>
                    {item}
                  </p>
                ))}
              </div>

              <div className="mt-5 p-4 rounded-xl border border-slate-800 bg-slate-950/50 text-sm text-slate-400 leading-6">
                <p className="text-slate-300 font-semibold mb-1">Why this problem is interesting</p>
                <p>
                  It naturally involves{' '}
                  <span className="text-slate-200">
                    adversarial planning, incomplete information, risk management, prediction, and deception
                  </span>
                  , making it a strong testbed for strategy and AI experiments.
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------
  // Screen 3: AI role selection
  // ---------------------------
  if (screen === 'aiRoleSelect') {
    return (
      <div className="min-h-screen bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black text-slate-200 p-4 flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="w-full max-w-4xl rounded-3xl border border-slate-700/70 bg-slate-900/75 backdrop-blur-xl p-6 md:p-8"
        >
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={backToHome}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-700 bg-slate-900/70 hover:bg-slate-800/80 transition"
            >
              <ArrowLeft size={18} />
              Back to Home
            </button>

            <div className="text-right">
              <h2 className="text-2xl font-bold text-white">AI Match</h2>
              <p className="text-slate-400 text-sm">Choose your side</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Pursuer */}
            <button
              onClick={() => startAIMatch('B')}
              className="group text-left rounded-2xl border border-red-900/40 bg-red-950/20 hover:bg-red-950/35 p-6 transition-all hover:-translate-y-1"
            >
              <div className="flex items-center gap-4 mb-4">
                <div className="w-14 h-14 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                  <Rocket className="text-red-400" size={28} />
                </div>
                <div>
                  <div className="text-white font-bold text-xl">Pursuer (Red)</div>
                  <div className="text-red-200/80 text-sm">Lock and intercept</div>
                </div>
              </div>

              <p className="text-slate-300 text-sm leading-6">
                Keep the Evader inside your 3x3 lock zone for{' '}
                <span className="font-mono text-white">{WIN_TIME}</span> consecutive turns to win.
              </p>

              <div className="mt-4 text-xs text-red-200/80 font-mono">
                Aggressive / predictive playstyle
              </div>
            </button>

            {/* Evader */}
            <button
              onClick={() => startAIMatch('A')}
              className="group text-left rounded-2xl border border-blue-900/40 bg-blue-950/20 hover:bg-blue-950/35 p-6 transition-all hover:-translate-y-1"
            >
              <div className="flex items-center gap-4 mb-4">
                <div className="w-14 h-14 rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
                  <Satellite className="text-blue-400" size={28} />
                </div>
                <div>
                  <div className="text-white font-bold text-xl">Evader (Blue)</div>
                  <div className="text-blue-200/80 text-sm">Survive and evade</div>
                </div>
              </div>

              <p className="text-slate-300 text-sm leading-6">
                Survive within the restricted central zone until{' '}
                <span className="font-mono text-white">Turn {MAX_TURNS}</span> to win.
              </p>

              <div className="mt-4 text-xs text-blue-200/80 font-mono">
                Evasion / spacing management playstyle
              </div>
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // ---------------------------
  // Screen 4: Match view (left rules / center board / right background)
  // ---------------------------
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black text-slate-200 font-sans py-6 px-3 md:px-4 overflow-x-hidden">
      <div className="max-w-[1600px] mx-auto">
        {/* Top bar */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white drop-shadow-lg">
              Orbital Pursuit
            </h1>
            <p className="text-slate-400 text-sm mt-1">{currentModeLabel}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={backToMenuFromMatch}
              className="px-4 py-2 rounded-xl border border-slate-700 bg-slate-900/70 hover:bg-slate-800 transition text-sm"
            >
              Back to Home
            </button>
          </div>
        </div>

        {/* Main layout */}
        <div className="flex flex-col xl:flex-row gap-5 items-start justify-center">
          {/* Left panel: Rules */}
          <aside className="w-full xl:w-[280px] order-2 xl:order-1">
            <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 backdrop-blur-xl p-5 sticky top-4">
              <div className="flex items-center gap-2 mb-3">
                <BookOpen size={18} className="text-cyan-300" />
                <h3 className="font-bold text-white">Game Rules</h3>
              </div>

              <div className="space-y-2 text-sm text-slate-300 leading-6">
                {RULES_TEXT.map((r, i) => (
                  <p key={i}>
                    <span className="text-cyan-300 font-mono mr-2">{i + 1}.</span>
                    {r}
                  </p>
                ))}
              </div>

              <div className="mt-4 p-3 rounded-xl border border-slate-800 bg-slate-950/50 text-xs text-slate-400 leading-5">
                <p className="text-slate-300 font-semibold mb-1">Controls</p>
                <p>Select Orb 1-5 to choose the next lane and lateral drift (dx = y - 2).</p>
              </div>
            </div>
          </aside>

          {/* Center: Game */}
          <main className="w-full xl:w-auto order-1 xl:order-2 flex flex-col items-center">
            {/* Status Dashboard */}
            <div className="flex flex-wrap justify-center gap-4 md:gap-8 mb-5 bg-slate-900/60 backdrop-blur-md p-4 rounded-2xl border border-slate-800/60 shadow-xl z-20">
              <div className="flex flex-col items-center px-4">
                <span className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-1">
                  Turn
                </span>
                <span className="text-3xl font-mono text-white">
                  {turn} <span className="text-slate-600 text-lg">/ {MAX_TURNS}</span>
                </span>
              </div>

              <div className="hidden md:block w-px bg-slate-800"></div>

              <div className="flex flex-col items-center px-4">
                <span className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-2">
                  Target Lock
                </span>
                <div className="flex gap-2 mt-1">
                  <div
                    className={`w-10 h-3 rounded-full transition-colors duration-300 ${
                      bTimeInRange >= 1
                        ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]'
                        : 'bg-slate-800'
                    }`}
                  />
                  <div
                    className={`w-10 h-3 rounded-full transition-colors duration-300 ${
                      bTimeInRange >= 2
                        ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]'
                        : 'bg-slate-800'
                    }`}
                  />
                </div>
              </div>

              <div className="hidden md:block w-px bg-slate-800"></div>

              <div className="flex flex-col items-center px-4">
                <span className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-1">
                  Current
                </span>
                <span
                  className={`text-sm font-semibold ${
                    currentPlayer === 'A' ? 'text-blue-300' : 'text-red-300'
                  }`}
                >
                  {currentPlayer === 'A' ? 'Evader Planning' : 'Pursuer Planning'}
                </span>
              </div>
            </div>

            {/* Curved board */}
            <div className="w-full overflow-x-auto pb-1">
              <div className="relative w-[760px] h-[460px] bg-slate-900/30 backdrop-blur-xl rounded-[2.5rem] border border-slate-700/50 shadow-2xl overflow-hidden shrink-0 mx-auto">
                <div className="absolute bottom-[-100px] left-1/2 -translate-x-1/2 w-[800px] h-[250px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-600/20 via-blue-900/10 to-transparent blur-2xl rounded-t-[100%] pointer-events-none z-0" />

                {/* Column labels */}
                {Array.from({ length: GRID_W }).map((_, x) => {
                  const pos = posOf(x, -0.8);
                  return (
                    <div
                      key={`col-${x}`}
                      className="absolute w-12 text-center text-slate-500 font-mono text-sm font-bold z-10"
                      style={{ left: pos.x, top: pos.y, transform: `rotate(${pos.rotate}deg)` }}
                    >
                      {x + 1}
                    </div>
                  );
                })}

                {/* Lane labels */}
                {Array.from({ length: GRID_H }).map((_, y) => {
                  const pos = posOf(-1, y);
                  return (
                    <div
                      key={`row-${y}`}
                      className="absolute text-slate-400 font-mono text-xs whitespace-nowrap z-10"
                      style={{
                        left: pos.x - 10,
                        top: pos.y + 16,
                        transform: `rotate(${pos.rotate}deg)`,
                      }}
                    >
                      Orb {y + 1}
                    </div>
                  );
                })}

                {/* Grid cells */}
                {Array.from({ length: GRID_H }).map((_, y) =>
                  Array.from({ length: GRID_W }).map((_, x) => {
                    const pos = posOf(x, y);
                    const isAArea = x >= A_MIN_X && x <= A_MAX_X;
                    const isTargetLock = chebyshevDist({ x, y }, bPos) <= 1;

                    return (
                      <div
                        key={`cell-${x}-${y}`}
                        className={`absolute w-11 h-11 rounded-lg transition-colors duration-500 backdrop-blur-sm z-10
                          ${
                            isAArea
                              ? 'bg-blue-500/10 border border-blue-400/20 shadow-[inset_0_0_10px_rgba(59,130,246,0.05)]'
                              : 'bg-slate-800/20 border border-slate-700/40'
                          }`}
                        style={{ left: pos.x, top: pos.y, transform: `rotate(${pos.rotate}deg)` }}
                      >
                        {isTargetLock && matchPhase !== 'gameover' && (
                          <div className="absolute inset-[-2px] border-2 border-red-500/50 bg-red-500/10 rounded-lg shadow-[0_0_15px_rgba(239,68,68,0.3)] pointer-events-none" />
                        )}
                      </div>
                    );
                  })
                )}

                {/* Evader A */}
                <motion.div
                  className="absolute w-11 h-11 flex items-center justify-center text-blue-400 z-30 drop-shadow-[0_0_10px_rgba(96,165,250,1)]"
                  initial={false}
                  animate={{
                    left: posOf(aPos.x, aPos.y).x,
                    top: posOf(aPos.x, aPos.y).y,
                    rotate: posOf(aPos.x, aPos.y).rotate,
                  }}
                  transition={{ type: 'spring', stiffness: 100, damping: 14 }}
                >
                  <Satellite size={26} strokeWidth={1.5} />
                </motion.div>

                {/* Pursuer B */}
                <motion.div
                  className="absolute w-11 h-11 flex items-center justify-center text-red-400 z-40 drop-shadow-[0_0_10px_rgba(248,113,113,1)]"
                  initial={false}
                  animate={{
                    left: posOf(bPos.x, bPos.y).x,
                    top: posOf(bPos.x, bPos.y).y,
                    rotate: posOf(bPos.x, bPos.y).rotate,
                  }}
                  transition={{ type: 'spring', stiffness: 100, damping: 14 }}
                >
                  <Rocket size={26} strokeWidth={1.5} />
                </motion.div>
              </div>
            </div>

            {/* Controls / Waiting / Game Over */}
            {matchPhase === 'playing' ? (
              isHumanTurn ? (
                <div
                  className={`mt-5 flex flex-col items-center gap-4 p-6 rounded-2xl border w-full max-w-2xl transition-colors duration-500 backdrop-blur-xl shadow-2xl relative z-20 ${
                    currentPlayer === 'A'
                      ? 'bg-blue-950/60 border-blue-900/50'
                      : 'bg-red-950/60 border-red-900/50'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2 flex-wrap justify-center text-center">
                    {currentPlayer === 'A' ? (
                      <>
                        <Satellite size={24} className="text-blue-400" />
                        <h3 className="text-xl font-bold text-blue-400 flex items-center gap-2 flex-wrap justify-center">
                          Evader (Blue) - Plan Move
                          {mode === 'hotseat' && (
                            <span className="text-sm font-normal text-blue-300/60 ml-1 border border-blue-800/50 bg-blue-950 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <EyeOff size={14} />
                              Red player look away
                            </span>
                          )}
                        </h3>
                      </>
                    ) : (
                      <>
                        <Rocket size={24} className="text-red-400" />
                        <h3 className="text-xl font-bold text-red-400 flex items-center gap-2 flex-wrap justify-center">
                          Pursuer (Red) - Plan Move
                          {mode === 'hotseat' && (
                            <span className="text-sm font-normal text-red-300/60 ml-1 border border-red-800/50 bg-red-950 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <EyeOff size={14} />
                              Blue move locked
                            </span>
                          )}
                        </h3>
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap justify-center gap-3">
                    {[0, 1, 2, 3, 4].map((y) => {
                      const dx = y - 2;
                      const fromX = currentPlayer === 'A' ? aPos.x : bPos.x;
                      const valid = isValidMove(currentPlayer, fromX, y);

                      return (
                        <button
                          key={y}
                          disabled={!valid}
                          onClick={() => handlePlayerMove(y)}
                          className={`relative px-5 py-3 rounded-xl font-mono text-sm transition-all duration-200 overflow-hidden group border ${
                            valid
                              ? 'bg-slate-800/80 hover:bg-slate-700 text-white border-slate-600/80 shadow-lg hover:-translate-y-0.5'
                              : 'bg-slate-900/50 text-slate-600 border-slate-800/50 cursor-not-allowed opacity-50'
                          }`}
                        >
                          <div className="relative z-10 flex flex-col items-center gap-1">
                            <span className="font-bold">Orb {y + 1}</span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded bg-slate-950/50 ${
                                valid
                                  ? currentPlayer === 'A'
                                    ? 'text-blue-300'
                                    : 'text-red-300'
                                  : 'text-slate-500'
                              }`}
                            >
                              {dx < 0 ? `← ${Math.abs(dx)}` : dx > 0 ? `→ ${dx}` : 'Stay'}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`mt-5 w-full max-w-2xl rounded-2xl border p-5 backdrop-blur-xl shadow-2xl ${
                    currentPlayer === 'A'
                      ? 'bg-blue-950/50 border-blue-900/50'
                      : 'bg-red-950/50 border-red-900/50'
                  }`}
                >
                  <div className="flex items-center justify-center gap-3">
                    {currentPlayer === 'A' ? (
                      <Satellite className="text-blue-400" />
                    ) : (
                      <Rocket className="text-red-400" />
                    )}
                    <div className="text-center">
                      <p className="text-white font-semibold">Opponent is planning...</p>
                      <p className="text-slate-400 text-sm mt-1">
                        Please wait for the move to resolve.
                      </p>
                    </div>
                  </div>
                </motion.div>
              )
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-5 p-8 bg-slate-900/80 backdrop-blur-xl border border-slate-700 rounded-2xl text-center max-w-md w-full shadow-2xl relative overflow-hidden z-20"
              >
                <div
                  className={`absolute top-0 left-0 w-full h-1 ${
                    winner === 'B' ? 'bg-red-500' : 'bg-blue-500'
                  }`}
                />
                <div className="absolute bottom-0 left-0 right-0 h-24 bg-blue-600/10 blur-3xl -z-10 translate-y-1/2" />

                <div className="flex justify-center mb-4">
                  {winner === 'B' ? (
                    <Crosshair size={48} className="text-red-400" />
                  ) : (
                    <ShieldAlert size={48} className="text-blue-400" />
                  )}
                </div>

                <h2
                  className={`text-3xl font-bold mb-3 drop-shadow-lg ${
                    winner === 'B' ? 'text-red-400' : 'text-blue-400'
                  }`}
                >
                  {winner === 'B'
                    ? 'TARGET LOCKED (Pursuer Wins)'
                    : 'EVADER ESCAPED (Evader Wins)'}
                </h2>

                <p className="text-slate-400 text-sm">
                  {winner === 'B'
                    ? 'The Pursuer achieved a sustained lock.'
                    : `The Evader survived until Turn ${MAX_TURNS}.`}
                </p>

                <div className="mt-6 flex flex-col sm:flex-row justify-center gap-3">
                  <button
                    onClick={() => {
                      if (mode === 'hotseat') {
                        startHotseat();
                      } else if (mode === 'ai' && humanRole) {
                        startAIMatch(humanRole);
                      }
                    }}
                    className="px-6 py-3 bg-white text-slate-900 font-bold rounded-xl hover:bg-blue-100 transition-all active:scale-95"
                  >
                    Play Again
                  </button>

                  <button
                    onClick={backToMenuFromMatch}
                    className="px-6 py-3 border border-slate-700 bg-slate-900/70 text-white font-semibold rounded-xl hover:bg-slate-800 transition-all"
                  >
                    Back to Home
                  </button>
                </div>
              </motion.div>
            )}
          </main>

          {/* Right panel: Background */}
          <aside className="w-full xl:w-[280px] order-3">
            <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 backdrop-blur-xl p-5 sticky top-4">
              <div className="flex items-center gap-2 mb-3">
                <Satellite size={18} className="text-blue-300" />
                <h3 className="font-bold text-white">Background</h3>
              </div>

              <div className="space-y-2 text-sm text-slate-300 leading-6">
                {BACKGROUND_TEXT.map((t, i) => (
                  <p key={i}>{t}</p>
                ))}
              </div>

              <div className="mt-4 p-3 rounded-xl border border-slate-800 bg-slate-950/50 text-xs text-slate-400 leading-5">
                <p className="text-slate-300 font-semibold mb-1">Possible Extensions</p>
                <p>
                  Stronger AI, turn logs, replay, difficulty levels, stochastic disturbances, RL mode, etc.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}