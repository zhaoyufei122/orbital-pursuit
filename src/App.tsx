import React, { useEffect, useMemo, useState } from 'react';
import {
  Satellite,
  Rocket,
  Crosshair,
  ShieldAlert,
  Play,
  EyeOff,
  Users,
  Bot,
  BookOpen,
  ArrowLeft,
} from 'lucide-react';
import { motion } from 'motion/react';

// --- 游戏核心参数配置 ---
const GRID_W = 12; // 总共 12 列 (索引 0-11)
const GRID_H = 5; // 总共 5 条轨道 (索引 0-4)
const A_MIN_X = 5; // 蓝方最小边界 (对应第 6 列)
const A_MAX_X = 9; // 蓝方最大边界 (对应第 10 列)
const WIN_TIME = 2;
const MAX_TURNS = 20;

type Player = 'A' | 'B'; // A=蓝方逃逸者, B=红方追击者
type Screen = 'home' | 'instructions' | 'aiRoleSelect' | 'match';
type MatchPhase = 'playing' | 'gameover';
type Mode = 'hotseat' | 'ai';

type Pos = { x: number; y: number };

// --- 纯数学魔法：计算弯曲网格的坐标 ---
const getCurvedPos = (x: number, y: number) => {
  const dx = x - 5.5; // 以网格中心为轴
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
  '双盲行动：蓝方先秘密规划，红方再规划，随后双方同时结算。',
  '蓝方（Evader）只能在中间 5 列区域（第6~10列）活动。',
  '红方（Pursuer）可在全图活动，并拥有 3x3 锁定区。',
  `红方若连续 ${WIN_TIME} 回合将蓝方纳入锁定区，则红方获胜。`,
  `蓝方若成功存活至第 ${MAX_TURNS} 回合，则蓝方获胜。`,
];

const BACKGROUND_TEXT = [
  '本游戏抽象自“卫星追逃（Orbital Pursuit/Evasion）”问题：追击卫星尝试锁定目标卫星，而目标卫星通过机动规避追踪。',
  '这里用离散轨道（Orb 1~5）和横向漂移（左2/左1/不动/右1/右2）来模拟轨道机动决策。',
  '红方的 3x3 锁定区代表传感器/武器/捕获窗口；蓝方目标是利用机动与区域限制，在不利条件下坚持生存。',
  '该模型很适合扩展为博弈论、强化学习、风险感知控制或策略搜索实验平台。',
];

const INITIAL_A_POS: Pos = { x: 7, y: 2 };
const INITIAL_B_POS: Pos = { x: 1, y: 2 };

export default function App() {
  // 页面流程状态
  const [screen, setScreen] = useState<Screen>('home');

  // 对局模式状态
  const [mode, setMode] = useState<Mode | null>(null);
  const [humanRole, setHumanRole] = useState<Player | null>(null); // AI模式下人类扮演的角色

  // 对局运行状态（保留你原先玩法）
  const [matchPhase, setMatchPhase] = useState<MatchPhase>('playing');
  const [currentPlayer, setCurrentPlayer] = useState<Player>('A');

  const [aPos, setAPos] = useState<Pos>(INITIAL_A_POS);
  const [bPos, setBPos] = useState<Pos>(INITIAL_B_POS);

  const [pendingAMove, setPendingAMove] = useState<Pos | null>(null);
  const [turn, setTurn] = useState(1);
  const [bTimeInRange, setBTimeInRange] = useState(0);
  const [winner, setWinner] = useState<Player | null>(null);

  const isAIMode = mode === 'ai';

  // 预计算网格坐标（提升可读性/性能）
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

    // 胜负判定：红方优先（与你原逻辑一致）
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
      // 防御式校验（即使按钮已禁用，也做函数内校验）
      if (!isValidMove('A', aPos.x, selectedY)) return;

      const nextA = calcNextPos(aPos, selectedY);
      setPendingAMove(nextA);
      setCurrentPlayer('B');
      return;
    }

    // currentPlayer === 'B'
    if (!isValidMove('B', bPos.x, selectedY)) return;

    const nextB = calcNextPos(bPos, selectedY);
    const finalA = pendingAMove || aPos; // 理论上 pendingAMove 一定存在，这里做兜底

    resolveTurn(finalA, nextB);
  };

  // --- 简单 AI 策略 ---
  const pickAIMove = (player: Player): number => {
    const validMoves =
      player === 'A' ? getValidOrbs('A', aPos.x) : getValidOrbs('B', bPos.x);

    if (validMoves.length === 0) return 2;

    if (player === 'A') {
      // 蓝方：尽量远离红方，同时略微偏好居中（避免被边界卡死）
      let bestScore = -Infinity;
      let best: number[] = [];

      for (const y of validMoves) {
        const nextA = calcNextPos(aPos, y);
        const dist = chebyshevDist(nextA, bPos);
        const centerBias = -Math.abs(nextA.x - 7); // 越靠近中心越好（轻微）
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

    // 红方：尽量靠近（若已知蓝方已规划动作，则追 finalA）
    const targetA = pendingAMove || aPos;

    let bestScore = -Infinity;
    let best: number[] = [];

    for (const y of validMoves) {
      const nextB = calcNextPos(bPos, y);
      const dist = chebyshevDist(targetA, nextB);

      let score = -dist * 10;

      // 进入锁定区大加分
      if (dist <= 1) {
        score += 120;
        if (bTimeInRange + 1 >= WIN_TIME) score += 100; // 能直接赢则更优先
      }

      // 略微偏好贴近目标横向
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

  // --- AI 自动行动 ---
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

  // 当前是不是该人类操作（AI模式时会决定是否显示按钮）
  const isHumanTurn = (() => {
    if (screen !== 'match' || matchPhase !== 'playing') return false;
    if (mode === 'hotseat') return true;
    if (mode === 'ai') return humanRole === currentPlayer;
    return false;
  })();

  const currentModeLabel =
    mode === 'hotseat'
      ? '热座模式 Hotseat'
      : mode === 'ai'
      ? `AI对战 (${humanRole === 'A' ? '你是蓝方逃逸者' : '你是红方追击者'})`
      : '未选择模式';

  // ---------------------------
  // 页面 1：首页（仅标题 + 三个选项）
  // ---------------------------
  if (screen === 'home') {
    return (
      <div className="min-h-screen bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="relative w-full max-w-3xl rounded-3xl border border-slate-700/70 bg-slate-900/70 backdrop-blur-xl shadow-[0_0_60px_rgba(30,58,138,0.25)] p-8 md:p-10 overflow-hidden"
        >
          {/* 背景光晕 */}
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
              卫星追逃博弈 · 双盲回合制 · 轨道机动策略游戏
            </p>
          </div>

          <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              onClick={startHotseat}
              className="group rounded-2xl border border-slate-700 bg-slate-900/60 hover:bg-slate-800/80 p-5 text-left transition-all hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(255,255,255,0.06)]"
            >
              <div className="flex items-center gap-3 mb-3">
                <Users className="text-cyan-300" size={22} />
                <span className="text-white font-bold text-lg">热座模式</span>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                两名玩家本地轮流操作，保持双盲规划，再同时结算动作。
              </p>
            </button>

            <button
              onClick={() => setScreen('aiRoleSelect')}
              className="group rounded-2xl border border-slate-700 bg-slate-900/60 hover:bg-slate-800/80 p-5 text-left transition-all hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(59,130,246,0.15)]"
            >
              <div className="flex items-center gap-3 mb-3">
                <Bot className="text-violet-300" size={22} />
                <span className="text-white font-bold text-lg">AI对战</span>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                选择扮演红方追击者或蓝方逃逸者，与 AI 进行策略对局。
              </p>
            </button>

            <button
              onClick={() => setScreen('instructions')}
              className="group rounded-2xl border border-slate-700 bg-slate-900/60 hover:bg-slate-800/80 p-5 text-left transition-all hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(239,68,68,0.08)]"
            >
              <div className="flex items-center gap-3 mb-3">
                <BookOpen className="text-amber-300" size={22} />
                <span className="text-white font-bold text-lg">说明</span>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                查看游戏规则、胜负条件，以及“卫星追逃问题”的背景介绍。
              </p>
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // ---------------------------
  // 页面 2：说明页（规则 + 背景）
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
              返回首页
            </button>

            <div className="text-right">
              <h2 className="text-2xl md:text-3xl font-bold text-white">说明</h2>
              <p className="text-slate-400 text-sm">规则 & 背景介绍</p>
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
                <h3 className="text-xl font-bold text-white">游戏规则</h3>
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
                <p className="mb-1 text-slate-300 font-semibold">动作解释</p>
                <p>
                  选择轨道 <span className="font-mono text-slate-200">Orb y</span> 后，
                  横向位移为 <span className="font-mono text-slate-200">dx = y - 2</span>：
                  即 <span className="font-mono">←2, ←1, Stay, →1, →2</span>。
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
                <h3 className="text-xl font-bold text-white">游戏背景：卫星追逃问题</h3>
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
                <p className="text-slate-300 font-semibold mb-1">为什么这个题材有意思？</p>
                <p>
                  因为它天然包含 <span className="text-slate-200">对抗、信息不完全、风险管理、预测与反预测</span>，
                  很适合做博弈策略和 AI 实验。
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------
  // 页面 3：AI 角色选择页
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
              返回首页
            </button>

            <div className="text-right">
              <h2 className="text-2xl font-bold text-white">AI 对战</h2>
              <p className="text-slate-400 text-sm">请选择你要扮演的阵营</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* 红方追击者 */}
            <button
              onClick={() => startAIMatch('B')}
              className="group text-left rounded-2xl border border-red-900/40 bg-red-950/20 hover:bg-red-950/35 p-6 transition-all hover:-translate-y-1"
            >
              <div className="flex items-center gap-4 mb-4">
                <div className="w-14 h-14 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                  <Rocket className="text-red-400" size={28} />
                </div>
                <div>
                  <div className="text-white font-bold text-xl">追击者（红方）</div>
                  <div className="text-red-200/80 text-sm">Pursuer</div>
                </div>
              </div>

              <p className="text-slate-300 text-sm leading-6">
                你的目标是利用 3x3 锁定区追踪并压制蓝方，
                让其连续 <span className="font-mono text-white">{WIN_TIME}</span> 回合处于锁定范围内。
              </p>

              <div className="mt-4 text-xs text-red-200/80 font-mono">
                适合喜欢主动压迫、预测走位的玩家
              </div>
            </button>

            {/* 蓝方逃逸者 */}
            <button
              onClick={() => startAIMatch('A')}
              className="group text-left rounded-2xl border border-blue-900/40 bg-blue-950/20 hover:bg-blue-950/35 p-6 transition-all hover:-translate-y-1"
            >
              <div className="flex items-center gap-4 mb-4">
                <div className="w-14 h-14 rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
                  <Satellite className="text-blue-400" size={28} />
                </div>
                <div>
                  <div className="text-white font-bold text-xl">逃逸者（蓝方）</div>
                  <div className="text-blue-200/80 text-sm">Evader</div>
                </div>
              </div>

              <p className="text-slate-300 text-sm leading-6">
                你的目标是在中间受限区域内持续规避红方锁定，
                成功坚持至 <span className="font-mono text-white">第 {MAX_TURNS} 回合</span> 即可获胜。
              </p>

              <div className="mt-4 text-xs text-blue-200/80 font-mono">
                适合喜欢规避、骗招与空间管理的玩家
              </div>
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // ---------------------------
  // 页面 4：正式对局页（左规则 / 中棋盘 / 右背景）
  // ---------------------------
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black text-slate-200 font-sans py-6 px-3 md:px-4 overflow-x-hidden">
      <div className="max-w-[1600px] mx-auto">
        {/* 顶部栏 */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white drop-shadow-lg">
              Orbital Pursuit
            </h1>
            <p className="text-slate-400 text-sm mt-1">{currentModeLabel}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {mode === 'ai' && humanRole && (
              <span
                className={`px-3 py-1 rounded-full text-xs border ${
                  humanRole === 'A'
                    ? 'bg-blue-950/70 border-blue-800 text-blue-200'
                    : 'bg-red-950/70 border-red-800 text-red-200'
                }`}
              >
                你扮演：{humanRole === 'A' ? '蓝方逃逸者' : '红方追击者'}
              </span>
            )}

            <button
              onClick={backToMenuFromMatch}
              className="px-4 py-2 rounded-xl border border-slate-700 bg-slate-900/70 hover:bg-slate-800 transition text-sm"
            >
              返回首页
            </button>
          </div>
        </div>

        {/* 主布局：左规则 / 中游戏 / 右背景 */}
        <div className="flex flex-col xl:flex-row gap-5 items-start justify-center">
          {/* 左侧：规则（桌面左侧，小屏移到下方也可以） */}
          <aside className="w-full xl:w-[280px] order-2 xl:order-1">
            <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 backdrop-blur-xl p-5 sticky top-4">
              <div className="flex items-center gap-2 mb-3">
                <BookOpen size={18} className="text-cyan-300" />
                <h3 className="font-bold text-white">游戏规则</h3>
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
                <p className="text-slate-300 font-semibold mb-1">操作提示</p>
                <p>选择 Orb 1~5 表示下一步轨道，同时决定横向漂移量（dx = y - 2）。</p>
              </div>
            </div>
          </aside>

          {/* 中间：游戏主体 */}
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
                  {currentPlayer === 'A' ? '蓝方规划中' : '红方规划中'}
                </span>
              </div>
            </div>

            {/* 弯曲棋盘 - 加上横向滚动容器，防止小屏溢出 */}
            <div className="w-full overflow-x-auto pb-1">
              <div className="relative w-[760px] h-[460px] bg-slate-900/30 backdrop-blur-xl rounded-[2.5rem] border border-slate-700/50 shadow-2xl overflow-hidden shrink-0 mx-auto">
                {/* 底部光晕 */}
                <div className="absolute bottom-[-100px] left-1/2 -translate-x-1/2 w-[800px] h-[250px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-600/20 via-blue-900/10 to-transparent blur-2xl rounded-t-[100%] pointer-events-none z-0" />

                {/* 列标签 1-12 */}
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

                {/* 轨道标签 */}
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

                {/* 渲染弯曲网格 */}
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

                {/* 蓝方卫星 A */}
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

                {/* 红方追击者 B */}
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

            {/* Controls Panel / AI等待面板 / Game Over */}
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
                          {mode === 'hotseat' ? 'Evader (Blue) - 规划动作' : '你（蓝方）- 规划动作'}
                          {mode === 'hotseat' && (
                            <span className="text-sm font-normal text-blue-300/60 ml-1 border border-blue-800/50 bg-blue-950 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <EyeOff size={14} />
                              红方请回避视线
                            </span>
                          )}
                        </h3>
                      </>
                    ) : (
                      <>
                        <Rocket size={24} className="text-red-400" />
                        <h3 className="text-xl font-bold text-red-400 flex items-center gap-2 flex-wrap justify-center">
                          {mode === 'hotseat' ? 'Pursuer (Red) - 规划动作' : '你（红方）- 规划动作'}
                          {mode === 'hotseat' && (
                            <span className="text-sm font-normal text-red-300/60 ml-1 border border-red-800/50 bg-red-950 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <EyeOff size={14} />
                              蓝方动作已锁定
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
                      <p className="text-white font-semibold">
                        AI 正在为{currentPlayer === 'A' ? '蓝方（逃逸者）' : '红方（追击者）'}规划动作…
                      </p>
                      <p className="text-slate-400 text-sm mt-1">
                        {currentPlayer === 'A'
                          ? 'AI 将先锁定蓝方动作，再轮到你操作红方。'
                          : 'AI 正在基于当前位置进行追击决策。'}
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
                  {winner === 'B' ? 'TARGET LOCKED (红方获胜)' : 'EVADER ESCAPED (蓝方获胜)'}
                </h2>

                <p className="text-slate-400 text-sm">
                  {winner === 'B'
                    ? '红方成功完成连续锁定。'
                    : `蓝方成功存活至第 ${MAX_TURNS} 回合。`}
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
                    再来一局
                  </button>

                  <button
                    onClick={backToMenuFromMatch}
                    className="px-6 py-3 border border-slate-700 bg-slate-900/70 text-white font-semibold rounded-xl hover:bg-slate-800 transition-all"
                  >
                    返回首页
                  </button>
                </div>
              </motion.div>
            )}
          </main>

          {/* 右侧：背景（桌面右侧） */}
          <aside className="w-full xl:w-[280px] order-3">
            <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 backdrop-blur-xl p-5 sticky top-4">
              <div className="flex items-center gap-2 mb-3">
                <Satellite size={18} className="text-blue-300" />
                <h3 className="font-bold text-white">背景描述</h3>
              </div>

              <div className="space-y-2 text-sm text-slate-300 leading-6">
                {BACKGROUND_TEXT.map((t, i) => (
                  <p key={i}>{t}</p>
                ))}
              </div>

              <div className="mt-4 p-3 rounded-xl border border-slate-800 bg-slate-950/50 text-xs text-slate-400 leading-5">
                <p className="text-slate-300 font-semibold mb-1">可扩展方向</p>
                <p>后续可以加入：更强 AI、回合日志、历史回放、难度等级、概率扰动、RL 模式等。</p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}