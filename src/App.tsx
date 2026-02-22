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
  Radar,
  AlertTriangle,
  Eye,
  EyeOff as EyeOffIcon,
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
type BluePolicyMap = Record<string, number>; // key: "ax,ay,bx,by,lock,turn" -> actionY (0..4)

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

// Displayed orbit label (top -> bottom: 2, 1, 0, -1, -2)
const orbitValueFromY = (y: number) => 2 - y;

// IMPORTANT: must match Python export key order exactly: ax,ay,bx,by,lock,turn
const makeBluePolicyKey = (a: Pos, b: Pos, lockStreak: number, currentTurn: number) =>
  `${a.x},${a.y},${b.x},${b.y},${lockStreak},${currentTurn}`;

// Observation rule: every 4 turns -> first 2 visible, next 2 hidden
// Turn 1,2 visible; 3,4 hidden; 5,6 visible; 7,8 hidden; ...
const redHasVisionThisTurn = (turn: number) => ((turn - 1) % 4) < 2;

const RULES_TEXT = [
  'Blind planning: the Evader plans first, then the Pursuer plans, and both moves resolve simultaneously.',
  'The Evader (Blue) can only move within the central 5 columns (columns 6-10).',
  'The Pursuer (Red) can move across the full map and has a 3x3 lock zone.',
  'Sensor cycle (repeats every 4 turns): the Pursuer can directly observe the Evader on the first 2 turns, then loses direct observation for the next 2 turns.',
  'During hidden turns, if the Evader is inside the Pursuer’s lock zone, the Pursuer only receives a contact alert (position remains unknown).',
  `If the Pursuer keeps the Evader inside the lock zone for ${WIN_TIME} consecutive turns, the Pursuer wins.`,
  `If the Evader survives until Turn ${MAX_TURNS}, the Evader wins.`,
];

const BACKGROUND_TEXT = [
  'This game is inspired by the orbital pursuit-evasion problem, where a pursuing satellite attempts to lock onto a target satellite while the target performs evasive maneuvers.',
  'Here, discrete orbital lanes (2, 1, 0, -1, -2 from top to bottom) and lateral drift (left2/left1/stay/right1/right2) are used to model maneuver decisions.',
  "The Pursuer's 3x3 lock zone represents a sensing/engagement/capture window, while the Evader aims to survive under constrained mobility.",
  'A periodic observation window models ground-based sensing + communication delay: tracking is sometimes accurate, sometimes memory-based.',
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

  // Loaded Q-learning policy for BLUE (Evader)
  const [bluePolicy, setBluePolicy] = useState<BluePolicyMap | null>(null);

  // Match runtime state
  const [matchPhase, setMatchPhase] = useState<MatchPhase>('playing');
  const [currentPlayer, setCurrentPlayer] = useState<Player>('A');

  const [aPos, setAPos] = useState<Pos>(INITIAL_A_POS);
  const [bPos, setBPos] = useState<Pos>(INITIAL_B_POS);

  // Red's last observed exact position of Blue (used during hidden turns)
  const [redObservedA, setRedObservedA] = useState<Pos>(INITIAL_A_POS);

  const [pendingAMove, setPendingAMove] = useState<Pos | null>(null);
  const [turn, setTurn] = useState(1);
  const [bTimeInRange, setBTimeInRange] = useState(0);
  const [winner, setWinner] = useState<Player | null>(null);

  // Hotseat screen-protector gate (prevents next player from seeing a flash)
  const [hotseatHandoff, setHotseatHandoff] = useState<{ nextPlayer: Player; nextTurn: number } | null>(null);

  const isAIMode = mode === 'ai';

  // Load blue Q-learning policy from public/
  // Put file at: public/blue_policy_qlearning_fair_red.json
  useEffect(() => {
    let cancelled = false;

    fetch('/blue_policy_qlearning_fair_red.json')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load policy JSON (status ${res.status})`);
        }
        return res.json();
      })
      .then((data: BluePolicyMap) => {
        if (cancelled) return;
        setBluePolicy(data);
        console.log('[Blue Policy] Loaded states:', Object.keys(data).length);
      })
      .catch((err) => {
        if (cancelled) return;
        setBluePolicy(null);
        console.warn('[Blue Policy] Load failed. Using heuristic fallback only.', err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
    setRedObservedA(INITIAL_A_POS);
    setTurn(1);
    setBTimeInRange(0);
    setWinner(null);
    setCurrentPlayer('A');
    setPendingAMove(null);
    setMatchPhase('playing');
    setHotseatHandoff(null);
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
    setHotseatHandoff(null);
  };

  const backToMenuFromMatch = () => {
    setScreen('home');
    setHotseatHandoff(null);
  };

  // Derived sensor / observation state for the current turn
  const redVisionNow = redHasVisionThisTurn(turn);
  const hiddenContactSignal = !redVisionNow && chebyshevDist(aPos, bPos) <= 1;

  // Update red's observed Blue position whenever the sensor window is visible
  useEffect(() => {
    if (screen !== 'match') return;
    if (matchPhase !== 'playing') return;
    if (!redVisionNow) return;
    setRedObservedA(aPos);
  }, [screen, matchPhase, redVisionNow, aPos]);

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
      setHotseatHandoff(null);
      return;
    }

    if (turn >= MAX_TURNS) {
      setMatchPhase('gameover');
      setWinner('A');
      setHotseatHandoff(null);
      return;
    }

const nextTurn = turn + 1;
const finishedTurnWasHidden = !redHasVisionThisTurn(turn);

setTurn(nextTurn);
setCurrentPlayer('A');
setPendingAMove(null);

// Hotseat screen protector is needed when the JUST-FINISHED turn was hidden.
// This prevents revealing the result of a hidden-turn move during the handoff.
if (mode === 'hotseat' && finishedTurnWasHidden) {
  setHotseatHandoff({ nextPlayer: 'A', nextTurn });
} else {
  setHotseatHandoff(null);
}
  };

  const handlePlayerMove = (selectedY: number) => {
    if (screen !== 'match' || matchPhase !== 'playing') return;

    // Prevent actions while hotseat handoff overlay is active
    if (mode === 'hotseat' && hotseatHandoff) return;

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

  // --- Simple AI policy (with Blue Q-learning lookup + Red partial observability) ---
  const pickAIMove = (player: Player): number => {
    const validMoves =
      player === 'A' ? getValidOrbs('A', aPos.x) : getValidOrbs('B', bPos.x);

    if (validMoves.length === 0) return 2;

    if (player === 'A') {
      // 1) Try Q-learning policy lookup first (Blue / Evader)
      if (bluePolicy) {
        const key = makeBluePolicyKey(aPos, bPos, bTimeInRange, turn);
        const actionFromPolicy = bluePolicy[key];

        if (
          actionFromPolicy !== undefined &&
          isValidMove('A', aPos.x, actionFromPolicy)
        ) {
          return actionFromPolicy;
        }
      }

      // 2) Fallback heuristic: maximize distance + slight center preference
      let bestScore = -Infinity;
      let best: number[] = [];

      for (const y of validMoves) {
        const nextA = calcNextPos(aPos, y);
        const dist = chebyshevDist(nextA, bPos);
        const centerBias = -Math.abs(nextA.x - 7); // mild preference for center
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

    // Pursuer (Red): partial observability
    const targetA = redVisionNow ? aPos : redObservedA;

    let bestScore = -Infinity;
    let best: number[] = [];

    for (const y of validMoves) {
      const nextB = calcNextPos(bPos, y);
      const distToTarget = chebyshevDist(targetA, nextB);

      let score = -distToTarget * 10;
      score += -Math.abs(nextB.x - targetA.x);

      if (distToTarget <= 1) {
        score += 120;
        if (bTimeInRange + 1 >= WIN_TIME) score += 100;
      }

      // Hidden-turn contact alert: Red knows "target is close now" but not exact location.
      if (!redVisionNow && hiddenContactSignal) {
        const localContainment = -chebyshevDist(nextB, bPos);
        score += 25 + localContainment * 4;
      }

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
    if (hotseatHandoff) return;

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
    redObservedA,
    pendingAMove,
    bTimeInRange,
    turn,
    bluePolicy,
    redVisionNow,
    hiddenContactSignal,
    hotseatHandoff,
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

  // Viewer-perspective visibility control for the Blue piece
  // Goal:
  // - Hotseat: hide Blue only when it is Red player's planning turn in a hidden window
  // - AI mode (human plays Red): hide Blue during the entire hidden window
  //   (including Blue move animation / resolution) to avoid information leakage
  const shouldHideBlueFromViewer =
    matchPhase === 'playing' &&
    !redVisionNow &&
    ((mode === 'hotseat' && currentPlayer === 'B') ||
      (mode === 'ai' && humanRole === 'B'));

  const showActualBluePiece = !shouldHideBlueFromViewer;

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
                View rules, sensor window behavior, and the orbital pursuit-evasion background.
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
              <p className="text-slate-400 text-sm">Rules, Sensor Cycle & Background</p>
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
                  Choose an orbit lane from{' '}
                  <span className="font-mono text-slate-200">2, 1, 0, -1, -2</span> (top to bottom).
                  The lateral shift still uses{' '}
                  <span className="font-mono text-slate-200">dx = y - 2</span>:{' '}
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
                    adversarial planning, incomplete information, sensor scheduling, risk management, prediction, and deception
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
                Track the Evader across alternating visibility windows and maintain lock for{' '}
                <span className="font-mono text-white">{WIN_TIME}</span> consecutive turns.
              </p>

              <div className="mt-4 text-xs text-red-200/80 font-mono">
                Sensor-limited / predictive playstyle
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
                Exploit the hidden observation window (2 visible / 2 hidden) and survive until{' '}
                <span className="font-mono text-white">Turn {MAX_TURNS}</span>.
              </p>

              <div className="mt-4 text-xs text-blue-200/80 font-mono">
                Deception / spacing management playstyle
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
                <p>Choose one lane value (2, 1, 0, -1, -2) to set the next orbit row and drift.</p>
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
                  Red Sensor
                </span>
                <span
                  className={`text-sm font-semibold flex items-center gap-1 ${
                    redVisionNow ? 'text-emerald-300' : 'text-amber-300'
                  }`}
                >
                  {redVisionNow ? <Eye size={14} /> : <EyeOffIcon size={14} />}
                  {redVisionNow ? 'Visible Window' : 'Hidden Window'}
                </span>
                <span className="text-[11px] text-slate-500 mt-1 font-mono">
                  Cycle {((turn - 1) % 4) + 1}/4
                </span>
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

            {/* Contact alert banner (only when red-view hidden phase is actually active to avoid leaking info) */}
            {shouldHideBlueFromViewer && hiddenContactSignal && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 w-full max-w-2xl rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-100 shadow-lg"
              >
                <div className="flex items-center gap-2 text-sm">
                  <AlertTriangle size={16} className="text-amber-300" />
                  <span className="font-semibold">Contact Alert:</span>
                  <span>
                    Target is inside the lock zone (position unknown during hidden window).
                  </span>
                </div>
              </motion.div>
            )}

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

                {/* Lane labels: top -> bottom = 2,1,0,-1,-2 */}
                {Array.from({ length: GRID_H }).map((_, y) => {
                  const pos = posOf(-1, y);
                  return (
                    <div
                      key={`row-${y}`}
                      className="absolute text-slate-400 font-mono text-xs whitespace-nowrap z-10"
                      style={{
                        left: pos.x - 18,
                        top: pos.y + 16,
                        transform: `rotate(${pos.rotate}deg)`,
                      }}
                    >
                      {orbitValueFromY(y)}
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

                {/* Evader A: actual visible piece */}
                {showActualBluePiece && (
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
                )}

                {/* Hidden-window marker for hidden-red view (shows only last observed location, not current) */}
                {!showActualBluePiece && (
                  <motion.div
                    className="absolute w-11 h-11 flex items-center justify-center text-blue-300/40 z-[35]"
                    initial={false}
                    animate={{
                      left: posOf(redObservedA.x, redObservedA.y).x,
                      top: posOf(redObservedA.x, redObservedA.y).y,
                      rotate: posOf(redObservedA.x, redObservedA.y).rotate,
                    }}
                    transition={{ type: 'spring', stiffness: 100, damping: 14 }}
                  >
                    <div className="absolute inset-0 rounded-full border border-dashed border-blue-300/30" />
                    <Satellite size={24} strokeWidth={1.5} />
                    <div className="absolute -top-2 -right-2 text-[10px] px-1 py-0.5 rounded bg-slate-900/80 border border-slate-700 text-blue-200">
                      last
                    </div>
                  </motion.div>
                )}

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

                  {/* Red sensor info for the human red player */}
                  {mode === 'ai' && humanRole === 'B' && currentPlayer === 'B' && (
                    <div className="w-full max-w-xl rounded-xl border border-slate-700/60 bg-slate-900/50 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <div className="flex items-center gap-2">
                          <Radar size={15} className="text-slate-300" />
                          <span className="text-slate-300">Sensor Window</span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs border ${
                              redVisionNow
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                                : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                            }`}
                          >
                            {redVisionNow ? 'Visible (Exact Target)' : 'Hidden (No Exact Target)'}
                          </span>
                        </div>
                        <span className="text-xs text-slate-400 font-mono">
                          cycle-step {((turn - 1) % 4) + 1}/4
                        </span>
                      </div>

                      {!redVisionNow && (
                        <div className="mt-2 text-xs text-slate-300 flex items-center gap-2">
                          <AlertTriangle
                            size={14}
                            className={hiddenContactSignal ? 'text-amber-300' : 'text-slate-500'}
                          />
                          {hiddenContactSignal ? (
                            <span className="text-amber-200">
                              Contact alert: target is inside your lock zone (position unknown).
                            </span>
                          ) : (
                            <span className="text-slate-400">No contact alert this turn.</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap justify-center gap-3">
                    {[0, 1, 2, 3, 4].map((y) => {
                      const dx = y - 2;
                      const fromX = currentPlayer === 'A' ? aPos.x : bPos.x;
                      const valid = isValidMove(currentPlayer, fromX, y);
                      const orbitVal = orbitValueFromY(y);

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
                            <span className="font-bold">{orbitVal}</span>
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
                  Stronger AI, turn logs, replay, difficulty levels, stochastic observation noise, RL
                  mode, etc.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Hotseat handoff screen protector (only used before hidden turns to prevent leak) */}
      {hotseatHandoff && matchPhase === 'playing' && mode === 'hotseat' && (
        <div className="fixed inset-0 z-[200] bg-slate-950/95 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900/80 p-6 md:p-8 shadow-2xl text-center"
          >
            <div className="flex items-center justify-center gap-3 mb-4">
              <Satellite className="text-blue-400" size={26} />
              <Rocket className="text-red-400" size={26} />
            </div>

            <h3 className="text-2xl font-bold text-white mb-2">
              Next Turn Ready Check
            </h3>

            <p className="text-slate-300 text-sm leading-6 mb-2">
              Pass the device to the{' '}
              <span
                className={`font-semibold ${
                  hotseatHandoff.nextPlayer === 'A' ? 'text-blue-300' : 'text-red-300'
                }`}
              >
                {hotseatHandoff.nextPlayer === 'A' ? 'Blue (Evader)' : 'Red (Pursuer)'}
              </span>{' '}
              player.
            </p>

            <p className="text-slate-400 text-xs mb-5">
              Turn {hotseatHandoff.nextTurn} · Hidden Window
            </p>

            <button
              onClick={() => setHotseatHandoff(null)}
              className="px-6 py-3 rounded-xl bg-white text-slate-900 font-bold hover:bg-blue-100 transition active:scale-95"
            >
              Ready
            </button>
          </motion.div>
        </div>
      )}
    </div>
  );
}