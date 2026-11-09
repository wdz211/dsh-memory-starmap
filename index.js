/**
 * Host half of dsh-memory-starmap.
 *
 * Reads the machine's memory files (~/.dsh-beta/memories), builds a
 * force-directed graph (nodes = memory entries, links = shared distinctive
 * tokens), and serves it over an HTTP route the Client half polls:
 *
 *   GET /x-memory-starmap/graph.json
 *     -> { status:"ready", generatedAt, stats, nodes, links }   when a cache is warm
 *     -> { status:"warming" }                                    while a background build runs
 *     ?refresh=1 forces a background rebuild (still non-blocking).
 *
 * The O(n^2) link computation never runs inside the request: it runs in the
 * background in chunks (setImmediate yields) so the whole Harness event loop
 * stays responsive, then writes %TEMP%/memory-starmap-cache.json (TTL 30 min).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROUTE_PATH = '/x-memory-starmap';
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_BODY_CHARS = 1400;
const MAX_EXCERPT_CHARS = 120;
const DAY_MS = 86400 * 1000;
const TIME_WINDOW_DAYS = 90;

// Distinctive-token stop list (Chinese filler that carries no identity).
const STOP = new Set([
  '用户', '当前', '已完成', '执行', '问题', '修复', '确认', '版本', '文件', '使用',
  '必须', '记录', '需要', '默认', '更新', '新增', '检查', '处理', '验证', '报告',
  '输出', '配置', '工具', '返回', '错误', '失败', '成功', '测试', '写入', '读取',
  '会话', '条目', '内容', '相关', '进行', '通过', '支持', '提供', '包含', '以及',
  '并且', '但是', '之后', '关于', '这个', '该条', '以上',
]);

/* ------------------------------------------------------------------ paths */

function memoriesDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta');
  const primary = path.join(home, 'memories');
  if (fs.existsSync(primary)) return primary;
  // Fallback for profiles whose DSH_HOME points elsewhere but memories sit in ~/.dsh-beta.
  const fallback = path.join(os.homedir(), '.dsh-beta', 'memories');
  if (fs.existsSync(fallback)) return fallback;
  return primary;
}

function cacheFile() {
  return path.join(os.tmpdir(), 'memory-starmap-cache.json');
}

/* --------------------------------------------------------------- parsing */

function parseEntries(text) {
  const parts = text.split(/\n§\n/);
  const out = [];
  for (const raw of parts) {
    const t = raw.replace(/\r/g, '').trim();
    if (!t) continue;
    // HTML 注释是文件格式说明，不是记忆内容（曾把"待办条目格式说明"当成一条记忆画进图里）
    if (/^<!--/.test(t)) continue;
    const dm = t.match(/\[?(\d{4}-\d{2}-\d{2})/);
    out.push({ date: dm ? dm[1] : '', body: t });
  }
  return out;
}

function* walk(dir) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 下划线/点开头的目录是归档/隐藏区（如 daily/_archive）——不进图，
      // 否则归档等于没归，星图会把已归档内容继续算成活跃节点。
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      yield* walk(p);
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('-archive.md')) {
      yield p;
    }
  }
}

function trackOf(rel) {
  if (/^projects\//.test(rel)) {
    if (rel.endsWith('KEY.md')) return 'key';
    if (rel.endsWith('PROJECT.md')) return 'project';
    if (rel.endsWith('DAILY.md')) return 'daily';
    return 'project';
  }
  // 每日轨是 daily/YYYY-MM-DD.md（全局，不分项目）——漏这条会让整条每日轨被误并入 memory 轨
  if (/^daily\//.test(rel)) return 'daily';
  if (/USER\.md$/i.test(rel)) return 'user';
  if (/FAILURES\.md$/i.test(rel)) return 'failure';
  return 'memory';
}

/* ------------------------------------------------------ 隔离区（region）
 * 记忆的隔离边界是真实的目录结构，不是推断出来的：
 *   projects/<sha1(工作区绝对路径)前12位>/    一个工作区一块
 *   daily/                                   所有项目混装的每日轨（无法归属单一项目）
 *   根目录 MEMORY.md / USER.md / FAILURES.md  全局轨
 * 项目目录名就是工作区路径的 sha1 前 12 位 —— 所以工作区名不必硬编码：
 * 读 storages/workspace.json，把里面所有 `X:\…` 绝对路径按同一口径算哈希，
 * 建 hash → basename 映射（60 秒缓存）。取不到就诚实退回「项目+hash前6位」。
 */
const WS_MAP_TTL_MS = 60 * 1000;
let wsNameMap = null;
let wsNameAt = 0;

function collectAbsPaths(v, out, depth) {
  if (depth > 8 || v == null || out.length >= 400) return;
  if (typeof v === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(v)) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectAbsPaths(x, out, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) collectAbsPaths(v[k], out, depth + 1);
  }
}

function workspaceNameMap() {
  const now = Date.now();
  if (wsNameMap && now - wsNameAt < WS_MAP_TTL_MS) return wsNameMap;
  const map = new Map();
  wsNameMap = map;
  wsNameAt = now;
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta');
    let f = path.join(home, 'storages', 'workspace.json');
    if (!fs.existsSync(f)) f = path.join(os.homedir(), '.dsh-beta', 'storages', 'workspace.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const paths = [];
    collectAbsPaths(j, paths, 0);
    for (const raw of paths) {
      // 与记忆目录名同口径：Windows 反斜杠、去掉尾部分隔符、UTF-8 字节的 sha1 前 12 位
      const norm = raw.replace(/[\\/]+$/, '').split('/').join('\\');
      if (!/[\\/]/.test(norm)) continue;
      const h = createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 12);
      const base = path.basename(norm);
      if (h && base && !map.has(h)) map.set(h, base);
    }
    // 次要来源：部分项目目录自带 project.json 的 cwd（backfill 产物），自描述且可校验
    // （只认 sha1(cwd) 前 12 位 == 目录名 的那份，对不上就不采信）
    try {
      const projRoot = path.join(memoriesDir(), 'projects');
      for (const e of fs.readdirSync(projRoot, { withFileTypes: true })) {
        if (!e.isDirectory() || map.has(e.name)) continue;
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(projRoot, e.name, 'project.json'), 'utf8'));
          const cwd = typeof pj.cwd === 'string' ? pj.cwd.replace(/[\\/]+$/, '') : '';
          if (!cwd || !/[\\/]/.test(cwd)) continue;
          const cnorm = cwd.split('/').join('\\');
          const ch = createHash('sha1').update(cnorm, 'utf8').digest('hex').slice(0, 12);
          if (ch === e.name) {
            const cbase = path.basename(cnorm);
            if (cbase) map.set(e.name, cbase);
          }
        } catch { /* 没有 project.json 就跳过 */ }
      }
    } catch { /* projects 目录不可读：不采信，保持回退 */ }
  } catch {
    /* 拿不到工作区清单 → 全部回退成「项目<hash前6位>」，不猜 */
  }
  return map;
}

function regionOf(rel, names) {
  const pm = rel.match(/^projects\/([^/]+)\//);
  if (pm) {
    const hash = pm[1];
    const name = names.get(hash);
    return { region: 'p:' + hash, regionLabel: name || ('项目' + hash.slice(0, 6)) };
  }
  if (/^daily\//.test(rel)) return { region: 'daily', regionLabel: '每日日志(跨项目)' };
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  // 全局轨三条只认根目录里那三个文件名：子目录里的同名文件不是全局轨
  if (!rel.includes('/')) {
    if (/^USER\.md$/i.test(base)) return { region: 'user', regionLabel: '用户档案' };
    if (/^FAILURES\.md$/i.test(base)) return { region: 'failure', regionLabel: '失败账本' };
    if (/^MEMORY\.md$/i.test(base)) return { region: 'global', regionLabel: '全局记忆' };
  }
  // 认不出来的文件（TODOS-work.md、plugin-state.json 之类，以及 advisor/ 这些旁路目录）
  // 不再冒充「全局记忆」——那会让全局区看起来比真实的大。单独一块 other，节点一个不丢。
  return { region: 'other', regionLabel: '其他' };
}

function tokens(body) {
  const set = new Set();
  for (const m of body.matchAll(/[a-zA-Z0-9_@/\-\\.]{4,}/g)) {
    const t = m[0].replace(/[.\-_]+$/, '');
    if (t.length >= 4 && !/^https?$/.test(t)) set.add(t.toLowerCase());
  }
  for (const m of body.matchAll(/[\u4e00-\u9fff]{4,8}/g)) {
    const w = m[0];
    if (!STOP.has(w)) set.add(w);
  }
  return [...set];
}

function clean(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/* --------------------------------------------------------------- compute */

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ------------------------------------------------- 记忆强度（memory strength）
 * 目的：让星图不是"几何球"，而是记忆系统自身的回路投影。
 * 半径编码"记忆强度"——记得住的靠中心，正在遗忘的漂到外圈。
 *
 * 数据源（全部来自 ~/.dsh-beta/memories，不是编的）：
 *   entry-meta.json   importance(1-100) / recallCount / lastSeen / clarity / pinned
 *   recall-stats.json count / lastAccess（检索命中记录 = 间隔重复的强化证据）
 *   条目自带 date     → 年龄（遗忘曲线的自变量）
 *   图的 degree       → 结构中心性（被多少条记忆牵连）
 *
 * 关联方式：entryFingerprint(条目原文) = sha1(canonicalBody)·前16位，
 * 和 entry-meta.json 的 key 完全同口径。优先动态加载 memory-evolve 的真实实现
 * （口径永远不会漂）；加载不到才退回本地复刻。
 * 注意：entry-meta 只给"被评估过"的条目建记录（实测 43/1432），
 * 所以 importance 缺失时按中性 0.45 处理 —— 主信号是年龄+检索+连接度，三者全量都有。
 */
const DAY_MS_STRENGTH = 86400000;

let fpFn = null;
let clarityFn = null;
let fpTried = false;

// 本地复刻 dsh-memory-evolve/lib/decay.js 的 DEFAULT_DECAY_OPTS 判据（加载不到真实实现时兜底）
const DECAY_OPTS = {
  recentDays: 7, criticalScore: 85, highScore: 65, normalScore: 40,
  criticalClearAfter: 30, highFuzzyAfter: 90, highClearAfter: 30,
  normalTraceAfter: 120, normalFuzzyAfter: 45, normalClearAfter: 14,
  lowTraceAfter: 60, lowFuzzyAfter: 21, lowClearAfter: 7,
};
function baseClarityOf(importance, ageDays) {
  const o = DECAY_OPTS;
  if (importance >= o.highScore) {
    if (ageDays > o.highFuzzyAfter) return 'fuzzy';
    if (ageDays > o.highClearAfter) return 'clear';
    return 'vivid';
  }
  if (importance >= o.normalScore) {
    if (ageDays > o.normalTraceAfter) return 'trace';
    if (ageDays > o.normalFuzzyAfter) return 'fuzzy';
    if (ageDays > o.normalClearAfter) return 'clear';
    return 'vivid';
  }
  if (ageDays > o.lowTraceAfter) return 'trace';
  if (ageDays > o.lowFuzzyAfter) return 'fuzzy';
  if (ageDays > o.lowClearAfter) return 'clear';
  return 'vivid';
}
function localTargetClarity(ageDays, importance, pinned) {
  if (pinned) return 'vivid';
  if (ageDays === null || !isFinite(ageDays)) return null;
  if (importance >= DECAY_OPTS.criticalScore) return ageDays > DECAY_OPTS.criticalClearAfter ? 'clear' : 'vivid';
  const base = baseClarityOf(importance, ageDays);
  const rank = { vivid: 3, clear: 2, fuzzy: 1, trace: 0 };
  if (ageDays <= DECAY_OPTS.recentDays && rank[base] < rank.clear) return 'clear';
  return base;
}
const CLARITY_NORM = { vivid: 1, clear: 0.75, fuzzy: 0.45, trace: 0.15 };
const HEAD_STRIP_RES = [
  /^\[id:[0-9a-f]{8}\]\s*/i,
  /^\[[^\]]{0,48}\]\s*/,
  /^\s+/,
];
function fallbackCanonical(entry) {
  let rest = String(entry ?? '');
  for (let round = 0; round < 32; round += 1) {
    let changed = false;
    for (const re of HEAD_STRIP_RES) {
      const m = re.exec(rest);
      if (m && m[0].length > 0) { rest = rest.slice(m[0].length); changed = true; }
    }
    if (!changed) break;
  }
  return rest.trim().replace(/\s+/g, ' ');
}

/**
 * 本地兜底指纹（sha1(canonical) 前 16 位）。
 * 主口径应该是 entryFingerprint；这里只在两处用到：①解析不到包时的降级实现，
 * ②protectionOf 的**第二指纹**兜底——侧车按 entryFingerprint 存，万一主口径又回落，
 * 用这个口径再查一次，防止"不可归档"的条目被静默放行。
 */
function fallbackFingerprint(entry) {
  try {
    return createHash('sha1').update(fallbackCanonical(entry), 'utf8').digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
/**
 * 定位 dsh-memory-evolve 的 package.json（跟着当前 profile 走，不写死盘符）。
 *
 * 为什么需要：插件以 junction 挂在 profiles/<name>/node_modules 下，但
 * `import.meta.url` 解析出的是**源码真实路径**（`<repo>\plugins\dsh-memory-starmap`），
 * 从这里向上找 node_modules 是找不到的 → `req.resolve` 抛错 → 静默退到
 * fallbackCanonical。而两套算法**不一致**：fallback 会剥掉头部任意 `[标签]`，
 * entryFingerprint 不会。于是带 `[权限边界]`/`[git master]` 这类头条目的指纹两边对不上，
 * 侧车的 protected 位在星图侧就**静默漏判**——一条"不可归档"的条目能被归档掉且不报错。
 * 这不是算分偏差，是守卫失效，所以必须显式把 profile 的 node_modules 也当解析根。
 */
function resolveEvolvePkg(req) {
  try { return req.resolve('dsh-memory-evolve/package.json'); } catch { /* 继续找 */ }
  const roots = [];
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      // profiles/ 下除了各 profile 目录，还可能存在名为 node_modules 的条目，
      // 拼出来会变成 profiles/node_modules/node_modules 这种无效根，跳过它。
      if (e.isDirectory() && e.name !== 'node_modules') roots.push(path.join(home, 'profiles', e.name, 'node_modules'));
    }
  } catch { /* 没有 profiles 目录 */ }
  roots.push(process.cwd());
  for (const r of roots) {
    try { return req.resolve('dsh-memory-evolve/package.json', { paths: [r] }); } catch { /* 下一个根 */ }
  }
  return null;
}

async function resolveFingerprint() {
  if (fpTried) return fpFn;
  fpTried = true;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkg = resolveEvolvePkg(req);
    if (pkg) {
      const mod = await import(pathToFileURL(path.join(path.dirname(pkg), 'lib', 'entry-meta.js')).href);
      if (typeof mod.entryFingerprint === 'function') fpFn = mod.entryFingerprint;
      // 同一份源码里的衰减模型：用它算"这条记忆现在该有多清晰"，不自己发明参数
      try {
        const dmod = await import(pathToFileURL(path.join(path.dirname(pkg), 'lib', 'decay.js')).href);
        if (typeof dmod.targetClarity === 'function') clarityFn = dmod.targetClarity;
      } catch { /* 用下面的本地复刻 */ }
    }
  } catch { /* fall through to local impl */ }
  if (!fpFn) {
    const { createHash } = await import('node:crypto');
    fpFn = (entry) => createHash('sha1').update(fallbackCanonical(entry), 'utf8').digest('hex').slice(0, 16);
  }
  return fpFn;
}

function loadMemoryMeta() {
  const dir = memoriesDir();
  const byFp = new Map();
  const recall = new Map();
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'entry-meta.json'), 'utf8'));
    for (const [k, v] of Object.entries(m.entries || {})) byFp.set(k, v);
  } catch { /* no meta yet */ }
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'recall-stats.json'), 'utf8'));
    for (const [k, v] of Object.entries(r.entries || {})) recall.set(k, v);
  } catch { /* no recall stats yet */ }
  return { byFp, recall };
}

/**
 * 复合记忆强度 0..1。
 *  retention  艾宾浩斯保持率 exp(-age/S)，S 随重要度和复习次数变长
 *  centrality 结构中心性 log(1+degree)/log(13)
 *  imp        显式重要度（缺失给中性 0.45）
 *  recall     检索强化 min(1, count/5)
 */
function computeStrength(dateStr, importance, recallCount, degree, lastSeenRaw, pinned, maxDeg) {
  const now = Date.now();
  let t = NaN;
  if (lastSeenRaw) t = Date.parse(lastSeenRaw);
  if (!isFinite(t) && dateStr) t = Date.parse(dateStr);
  const ageDays = isFinite(t) ? Math.max(0, (now - t) / DAY_MS_STRENGTH) : null;
  const impRaw = importance == null ? 50 : importance; // 系统自己的中性重要度

  // ① 清晰度：用记忆系统自己的衰减判据（不自己发明参数）
  let clar = null;
  if (clarityFn) {
    try { clar = clarityFn({ ageDays, importance: impRaw, pinned: !!pinned }); } catch { clar = null; }
  }
  if (!clar) clar = localTargetClarity(ageDays, impRaw, !!pinned);
  const clarityNorm = clar && CLARITY_NORM[clar] != null ? CLARITY_NORM[clar] : 0.75;

  // ② 结构中心性：和越多记忆相连，越容易被想起来
  const centrality = maxDeg > 1 ? Math.min(1, Math.log(1 + degree) / Math.log(1 + maxDeg)) : 0;
  // ③ 检索强化：真的被用过多少次
  const recall = Math.min(1, recallCount / 5);

  const v = 0.30 * clarityNorm + 0.45 * centrality + 0.25 * recall;
  return { strength: Math.max(0, Math.min(1, v)), clarityTarget: clar, ageDaysRaw: ageDays };
}

/** 条目年龄（天）：优先 lastSeen，退化到 date，再不济按 30 天。 */
function ageDaysOf(dateStr, lastSeenRaw) {
  const now = Date.now();
  let t = NaN;
  if (lastSeenRaw) t = Date.parse(lastSeenRaw);
  if (!isFinite(t) && dateStr) t = Date.parse(dateStr);
  if (!isFinite(t)) return null; // 未知就是未知，不伪造
  return Math.max(0, (now - t) / DAY_MS_STRENGTH);
}

/* ------------------------------------------- 抱团核心（k-core）与连通分量
 * 为什么不再用「连通分量」当簇：全图密度只有 ~1%，这种稀疏图上分量几乎必然塌成
 * 一个巨型块（实测最大分量占 47%），画出来就是"圈住半个图"，没有信息量。
 * 真正说明"哪一撮记忆抱团"的是 k-core：反复剥掉度数 < k 的节点后剩下的核心。
 * core 数 = 这条记忆最多能跟邻居互相保持 k 个连接 —— 它对长链条不敏感，只认密集处，
 * 所以不会被一条偶然的边把半个图串成一坨。
 * 计算是 O(V+E) 的桶式剥离（不用第三方库）。
 */
function coreNumbers(n, deg, adj) {
  const d = Int32Array.from(deg);
  let maxD = 0;
  for (let i = 0; i < n; i++) if (d[i] > maxD) maxD = d[i];
  const bin = new Array(maxD + 1);
  for (let i = 0; i <= maxD; i++) bin[i] = [];
  for (let i = 0; i < n; i++) bin[d[i]].push(i);
  const gone = new Uint8Array(n);
  const core = new Int32Array(n);
  let md = 0;
  let done = 0;
  while (done < n) {
    while (md <= maxD && bin[md].length === 0) md++;
    if (md > maxD) break;                   // 只剩已剥掉节点的陈旧副本
    const v = bin[md].pop();
    if (gone[v] || d[v] !== md) continue;   // 桶里的陈旧副本：跳过
    gone[v] = 1;
    core[v] = md;
    done++;
    const nb = adj[v];
    for (let j = 0; j < nb.length; j++) {
      const u = nb[j];
      if (gone[u]) continue;
      // 只降"比当前层更深"的邻居：度数正好等于 md 的邻居留在本层
      // （它们同属 md-core）。少了这个守卫，三角形+悬挂点这种图会把还在
      // 2-core 里的节点算成 core=1，与 k-core 的定义直接冲突。
      if (d[u] > md) {
        d[u]--;
        bin[d[u]].push(u);
      }
    }
  }
  return core;
}

/** 全图连通分量（BFS）：只用来出"数字事实"（几块、最大块多大），不再用来圈簇。 */
function componentsOf(n, adj) {
  const comp = new Int32Array(n);
  comp.fill(-1);
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const idx = comps.length;
    const arr = [s];
    comp[s] = idx;
    for (let h = 0; h < arr.length; h++) {
      const nb = adj[arr[h]];
      for (let j = 0; j < nb.length; j++) {
        const u = nb[j];
        if (comp[u] >= 0) continue;
        comp[u] = idx;
        arr.push(u);
      }
    }
    comps.push(arr);
  }
  return { comp, comps };
}

const CORE_MIN = 3;   // 「抱团核心」的参考门槛：core >= 3 记作 nodesInCore3Plus
// 核层（年轮）门槛：k 越大越密、成员越少。输出按 k 降序。
const CORE_LEVELS = [12, 8, 6, 3];
const CORE_LAYER_MIN_SIZE = 5;

/* 核层（nesting core levels）：不再切「互不相交的簇」。
 * 实测 core>=3 的 440 个节点连成一整块（内部 1909 条边，density 只有 0.0198）——
 * 任何互斥切法都只能切出「一大块 + 零碎」，没有信息量。
 * 改按门槛分层：第 k 层的成员 = 所有 core>=k 的节点。
 * 层与层天然嵌套（k 越大必然是小集合的子集），画出来就是年轮：数字越小圈越大。
 * 只输出 size>=5 的层；某门槛不够 5 条就跳过（maxCore 仍在 stats 里给参考）。 */
function buildCoreLevels(nodes, links, core) {
  const n = nodes.length;
  const out = [];
  for (const k of CORE_LEVELS) {
    const inSet = new Uint8Array(n);
    const ids = [];
    const mix = {};
    for (let i = 0; i < n; i++) {
      if (core[i] < k) continue;
      inSet[i] = 1;
      ids.push(i);
      const t = nodes[i].track;
      mix[t] = (mix[t] || 0) + 1;
    }
    const size = ids.length;
    if (size < CORE_LAYER_MIN_SIZE) continue;
    let edges = 0;
    for (const l of links) if (inSet[l.source] && inSet[l.target]) edges++;
    const possible = (size * (size - 1)) / 2;
    const trackMix = {};
    for (const t of Object.keys(mix).sort((a, b) => mix[b] - mix[a])) {
      const ratio = mix[t] / size;
      if (ratio >= 0.05) trackMix[t] = Math.round(ratio * 1000) / 1000;
    }
    out.push({
      k,
      size,
      edges,
      density: possible > 0 ? Math.round((edges / possible) * 10000) / 10000 : 0,
      trackMix,
      members: ids,
    });
  }
  return out; // CORE_LEVELS 本身降序，输出天然按 k 降序
}

/* 磁盘缓存的核层结构特征：形如 "12r15/8r35/6r179/3r440"。
 * 认不出来（旧缓存没有 cores、或字段残缺、或 k 不在门槛表里）就返回 null，
 * 让调用方丢弃整份缓存 —— 否则会一直吐旧口径的图。 */
function coreSignature(cores) {
  if (!Array.isArray(cores)) return null;
  const parts = [];
  for (const c of cores) {
    if (!c || typeof c.k !== 'number' || typeof c.size !== 'number'
      || typeof c.edges !== 'number' || typeof c.density !== 'number'
      || CORE_LEVELS.indexOf(c.k) < 0
      || !Array.isArray(c.members) || c.members.length !== c.size) return null;
    parts.push(c.k + 'r' + c.size);
  }
  return parts.join('/');
}

async function computeGraph(logger) {
  const t0 = Date.now();
  const dir = memoriesDir();
  const files = [];
  for (const f of walk(dir)) files.push(f);

  const fp = await resolveFingerprint();
  const metaStore = loadMemoryMeta();
  const wsNames = workspaceNameMap();

  const docs = [];
  for (const f of files) {
    const rel = path.relative(dir, f).replace(/\\/g, '/');
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const track = trackOf(rel);
    const rg = regionOf(rel, wsNames);
    for (const e of parseEntries(text)) {
      // 正文里没有日期时，从文件路径取（daily/2026-11-01.md、projects/x/DAILY.md 等）——
      // 这是真实日期，不是估算；只有连路径都取不到才留空
      let date = e.date;
      if (!date) {
        const pm = rel.match(/(\d{4}-\d{2}-\d{2})/);
        if (pm) date = pm[1];
      }
      docs.push({
        date, body: e.body, track, toks: new Set(tokens(e.body)), file: rel, fp: fp(e.body),
        region: rg.region, regionLabel: rg.regionLabel,
      });
    }
  }

  // Cross-links: shared score >= 6 and at least one strong (path/@-like) token.
  const links = [];
  const n = docs.length;
  let ops = 0;
  for (let i = 0; i < n; i++) {
    const A = docs[i];
    for (let j = i + 1; j < n; j++) {
      const B = docs[j];
      if (A.date && B.date && Math.abs(Date.parse(A.date) - Date.parse(B.date)) > DAY_MS * TIME_WINDOW_DAYS) {
        if ((++ops & 0x3ffff) === 0) await tick();
        continue;
      }
      let shared = 0;
      const strong = [];
      for (const t of A.toks) {
        if (B.toks.has(t)) {
          shared++;
          if (/[./@]/.test(t)) strong.push(t);
        }
      }
      const score = shared + strong.length * 2;
      if (score >= 6 && strong.length >= 1) {
        links.push({ source: i, target: j, score, strong: strong.slice(0, 4) });
      }
      if ((++ops & 0x3ffff) === 0) await tick();
    }
  }

  const deg = new Array(n).fill(0);
  for (const l of links) {
    deg[l.source]++;
    deg[l.target]++;
  }

  const maxDeg = deg.reduce((m, x) => (x > m ? x : m), 0);

  // 邻接表（core 剥离与分量都用它；一次建好，两处复用）
  const adj = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = [];
  for (const l of links) {
    adj[l.source].push(l.target);
    adj[l.target].push(l.source);
  }
  const core = coreNumbers(n, deg, adj);
  const cc = componentsOf(n, adj);
  let largestComponent = 0;
  for (const c of cc.comps) if (c.length > largestComponent) largestComponent = c.length;
  let maxCore = 0;
  let nodesInCore3Plus = 0;
  for (let i = 0; i < n; i++) {
    if (core[i] > maxCore) maxCore = core[i];
    if (core[i] >= CORE_MIN) nodesInCore3Plus++;
  }

  const byTrack = {};
  const strongByNode = new Map();
  for (const l of links) {
    for (const t of l.strong) {
      let a = strongByNode.get(l.source);
      if (!a) strongByNode.set(l.source, (a = new Set()));
      a.add(t);
      let b = strongByNode.get(l.target);
      if (!b) strongByNode.set(l.target, (b = new Set()));
      b.add(t);
    }
  }

  const nodes = docs.map((d, i) => {
    byTrack[d.track] = (byTrack[d.track] || 0) + 1;
    const strong = strongByNode.has(i) ? [...strongByNode.get(i)].slice(0, 8) : [];
    // 记忆强度：把记忆系统自己的数据变成可视化坐标（缺失项按中性处理）
    const meta = metaStore.byFp.get(d.fp) || null;
    const rc = metaStore.recall.get(d.fp) || null;
    const importance = meta && meta.importance != null ? meta.importance : null;
    const recallCount = ((meta && meta.recallCount) || 0) + ((rc && rc.count) || 0);
    const lastSeen = (meta && meta.lastSeen) || (rc && rc.lastAccess) || null;
    const clarity = (meta && meta.clarity) || null;
    const pinned = !!(meta && meta.pinned);
    const cs = computeStrength(d.date, importance, recallCount, deg[i], lastSeen, pinned, maxDeg);
    const strength = cs.strength;
    return {
      id: i,
      // 稳定标识：fingerprint 用来唯一定位到某一条目；file 告诉前端它住在哪个文件
      // （id 只是数组下标，重排就会漂移，绝不能拿它做写操作的寻址依据）
      fp: d.fp,
      file: d.file,
      track: d.track,
      // 隔离区：目录结构就是隔离边界（前端切到「隔离区」分组时按它分扇区）
      region: d.region,
      regionLabel: d.regionLabel,
      date: d.date || '',
      degree: deg[i],
      // k-core 数：这条记忆最多能和邻居互相保持多少个连接（>=3 才算抱团核心）
      core: core[i],
      excerpt: clean(d.body).slice(0, MAX_EXCERPT_CHARS),
      text: d.body.slice(0, MAX_BODY_CHARS),
      strong,
      // ↓ 记忆回路语义（前端据此决定半径/亮度）
      importance,
      recallCount,
      lastSeen,
      clarity,
      pinned,
      strength,
      // 0.05 起：最强的记忆几乎贴到中心；1.0 落到最外（孤岛自然在最外层）
      radiusNorm: 0.05 + 0.95 * Math.pow(1 - strength, 1.35),
      // ---- 真实状态标记（全部可直接判真，不是视觉效果）----
      clarityTarget: cs.clarityTarget,
      ageDays: cs.ageDaysRaw === null ? null : Math.round(cs.ageDaysRaw * 10) / 10,
      ageUnknown: ageDaysOf(d.date, lastSeen) === null,
      isOrphan: deg[i] === 0,                 // 孤岛：和任何记忆都没有连接
      neverRecalled: recallCount === 0,       // 从没被检索命中过
      // 状态分档按"真实结构"分：当前系统才 22 天历史，99.9% 记忆的清晰度仍是 vivid，
      // 用遗忘程度分档会得出"人人都是核心"的假象；连接度才是此刻真实有区分度的信号
      status: pinned ? 'pinned'
        : (deg[i] === 0 ? 'orphan'
        : (deg[i] >= 8 ? 'hub'
        : (deg[i] >= 3 ? 'linked' : 'loose'))),
      // 可清理：孤岛 + 从没被检索过 + 已超出系统"当前工作集"窗口(7天)
      evictCandidate: !pinned && deg[i] === 0 && recallCount === 0 && cs.ageDaysRaw !== null && cs.ageDaysRaw >= 7,
    };
  });

  // ---- 隔离区汇总（供图例/扇区直接用；count 之和必然等于节点总数）----
  const regionAgg = new Map();
  for (const nd of nodes) {
    let r = regionAgg.get(nd.region);
    if (!r) {
      r = { key: nd.region, label: nd.regionLabel, count: 0, tracks: {} };
      regionAgg.set(nd.region, r);
    }
    r.count++;
    r.tracks[nd.track] = (r.tracks[nd.track] || 0) + 1;
  }
  const regions = [...regionAgg.values()].sort(
    (a, b) => (b.count - a.count) || String(a.key).localeCompare(String(b.key)),
  );
  for (const r of regions) {
    const sorted = {};
    for (const k of Object.keys(r.tracks).sort((x, y) => r.tracks[y] - r.tracks[x])) sorted[k] = r.tracks[k];
    r.tracks = sorted;
  }
  const cores = buildCoreLevels(nodes, links, core);

  const graph = {
    status: 'ready',
    generatedAt: new Date().toISOString(),
    stats: {
      entries: n, links: links.length, byTrack, ms: Date.now() - t0, files: files.length,
      regions: regions.length,
      // 互斥簇已废弃（core>=3 会连成一整块），字段留着兼容旧前端，恒为 0
      clusters: 0,
      coreLayers: cores.length,
      // 连通度是"数字事实"（图例照实念出来），不是聚合结论：
      // 稀疏图上最大分量必然巨大，这不代表记忆抱团，抱团看 core。
      components: cc.comps.length,
      largestComponent,
      largestPct: n > 0 ? Math.round((largestComponent / n) * 10000) / 10000 : 0,
      maxCore,
      nodesInCore3Plus,
      nodes: n,
    },
    nodes,
    links,
    regions,
    clusters: [],   // 旧前端读它，恒为空
    cores,          // P4 核层（年轮）：k 降序，每层一个成员集合
  };
  return graph;
}

/* --------------------------------------------------------------- runtime */

let cache = null;
let lastComputeAt = 0;
let computing = false;
let lastError = null;

function loadDiskCache() {
  if (cache) return;
  try {
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    const parsed = JSON.parse(raw);
    // 旧格式缓存必须丢弃：早期版本的图没有 strength/status 等语义字段，
    // 一旦被装载进内存，客户端会拿到"ready 但无新字段"的图并永久停止拉取，
    // 表现为"改了代码重启后界面还是老的、必须手动重开面板"。
    // 同理：v3 的 region/regions/clusters 也纳入探测，否则会继续吐 v2 的图。
    // v4 再补一层：互斥簇（clusters 非空）或认不出核层结构（cores）的缓存一律作废，
    // 否则「换成核层」之后界面还会读到旧口径的块。
    const probe0 = parsed && Array.isArray(parsed.nodes) && parsed.nodes.length ? parsed.nodes[0] : null;
    const coresSig = parsed ? coreSignature(parsed.cores) : null;
    const cacheHasSemantics = !!(probe0
      && probe0.strength !== undefined
      && probe0.region !== undefined
      && probe0.core !== undefined
      && Array.isArray(parsed.regions)
      && Array.isArray(parsed.clusters) && parsed.clusters.length === 0
      && coresSig !== null
      && parsed.stats && typeof parsed.stats.maxCore === 'number');
    if (parsed && parsed.status === 'ready' && Array.isArray(parsed.nodes) && cacheHasSemantics) {
      cache = parsed;
      lastComputeAt = Date.parse(parsed.generatedAt) || 0;
    }
  } catch {
    /* no cache yet */
  }
}

function writeDiskCache(graph) {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(graph), 'utf8');
  } catch {
    /* best effort */
  }
}

function startCompute(logger) {
  if (computing) return;
  computing = true;
  lastError = null;
  Promise.resolve()
    .then(() => computeGraph(logger))
    .then((graph) => {
      cache = graph;
      lastComputeAt = Date.now();
      writeDiskCache(graph);
      if (logger) {
        logger.info?.(
          'memory-starmap: built %d entries, %d links in %dms',
          graph.stats.entries, graph.stats.links, graph.stats.ms,
        );
      }
    })
    .catch((err) => {
      lastError = String((err && err.stack) || err);
      if (logger) logger.warn?.('memory-starmap: build failed: %s', lastError);
    })
    .finally(() => {
      computing = false;
    });
}

/* ---------------------------------------------------------------- 维护操作
 * 支持单条与批量两种。安全策略（硬约束，不靠调用方自觉）：
 *   1. 不传 confirmed:true 一律只返回预览，绝不写盘
 *   2. 写盘前先把整个原文件复制到 %TEMP%/starmap-act-<时间戳>/
 *   3. 靠 fingerprint 定位，命中 0 条或多条一律拒绝（宁可不动，不可动错）
 *   4. 归档目标一律落在 *-archive.md 或被 walk 跳过的 _ 目录里，不会被重新算进图
 *   5. 批量按文件分组，一个文件只读一次写一次（否则 487 条要扫 487 遍全库）
 * -------------------------------------------------------------------------- */

function splitChunks(txt) {
  return txt.split('\n§\n');
}

/* ---- 不可归档守卫（与 dsh-memory-evolve 同一口径）------------------------
 * 权威源是**侧车** <目录>/entry-meta.json 里该条目指纹的 `protected` 位：
 * 正文一个字节都不用改（不污染注入文本、不吃本就吃紧的注入预算）。
 * 侧车缺失 / 坏 JSON / 指纹对不上时**回退**正文末尾的 `【保留】` 标记
 * （兼容老条目），并把回退次数如实报出来——静默回退比没回退更危险。
 * ------------------------------------------------------------------------ */
const KEEP_MARK_RE = /【保留】\s*$/;
/** dir -> { mtimeMs, fps:Set<string>|null }；侧车按目录共享，按 mtime 失效。 */
const sidecarCache = new Map();

/** 正文末尾的 `【保留】` 标记（回退口径，只认末尾）。 */
function isProtectedEntry(text) {
  return KEEP_MARK_RE.test(String(text == null ? '' : text));
}

/**
 * 读一个目录的侧车，返回"标了 protected 的指纹集合"。
 * @returns {Set<string>|null} null = 侧车缺失或不可解析（调用方据此走正文回退）
 */
function protectedFpsOf(dir) {
  const file = path.join(dir, 'entry-meta.json');
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { sidecarCache.delete(dir); return null; }
  const cached = sidecarCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.fps;
  const fps = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.entries : null;
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const k of Object.keys(entries)) {
        const rec = entries[k];
        if (rec && typeof rec === 'object' && !Array.isArray(rec) && rec.protected === true) fps.add(k);
      }
    }
  } catch {
    sidecarCache.set(dir, { mtimeMs, fps: null });
    return null;   // 坏文件 → 当没有，走正文回退
  }
  sidecarCache.set(dir, { mtimeMs, fps });
  return fps;
}

function protectedSample(text, width) {
  const w = typeof width === 'number' ? width : 60;
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, w);
}

/** 受保护条目的预览（与 previewOf 同形状，前端可直接渲染）。 */
function previewOfProtected(hit) {
  return {
    track: trackOf(hit.rel),
    file: hit.rel,
    chars: hit.body.length,
    excerpt: protectedSample(hit.body, 60),
  };
}

/**
 * 判定一个命中的保护状态。
 * @returns {{source:'sidecar'|'inline'}|null} null = 不受保护
 */
function protectionOf(hit) {
  const fps = protectedFpsOf(path.dirname(hit.abs));
  if (fps !== null && hit.fp && fps.has(hit.fp)) return { source: 'sidecar' };
  // 双指纹兜底：侧车是按 entryFingerprint 存的。万一 fingerprint 解析又一次回落到本地
  // fallback（历史事故：解析不到包 → 两套算法不一致 → 22% 的受保护条目被静默漏判），
  // 用 fallback 口径再查一次侧车，宁可多拦也不放过一条"不可归档"的条目。
  if (fps !== null && fps.size) {
    const alt = fallbackFingerprint(hit.body);
    if (alt && fps.has(alt)) return { source: 'sidecar' };
  }
  if (isProtectedEntry(hit.body)) return { source: 'inline' };
  return null;
}

function archiveTargetFor(rel, abs) {
  const dir = path.dirname(abs);
  if (rel.startsWith('daily/')) return path.join(dir, '_archive', 'ARCHIVED-daily.md');
  if (rel.endsWith('KEY.md')) return path.join(dir, 'KEY-archive.md');
  if (rel.endsWith('MEMORY.md')) return path.join(dir, 'MEMORY-archive.md');
  if (rel.endsWith('FAILURES.md')) return path.join(dir, 'FAILURES-archive.md');
  if (rel.endsWith('USER.md')) return path.join(dir, 'USER-archive.md');
  return path.join(dir, path.basename(abs, '.md') + '-archive.md');
}

/** 一次性建立 fp -> 命中列表 的索引。批量操作必须用它。 */
async function buildFpIndex() {
  const fpFn = await resolveFingerprint();
  const root = memoriesDir();
  const map = new Map();
  for (const p of walk(root)) {
    let txt;
    try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const chunks = splitChunks(txt);
    const rel = path.relative(root, p).split(path.sep).join('/');
    for (let i = 0; i < chunks.length; i++) {
      const body = chunks[i].trim();
      if (!body) continue;
      const key = fpFn(body);
      // hit 自带指纹：归档守卫要拿它去侧车 entry-meta.json 查 protected 位
      const hit = { abs: p, rel, idx: i, chunks, body, fp: key };
      const arr = map.get(key);
      if (arr) arr.push(hit); else map.set(key, [hit]);
    }
  }
  return map;
}

function previewOf(op, hit) {
  return {
    op,
    track: trackOf(hit.rel),
    file: hit.rel,
    chars: hit.body.length,
    excerpt: clean(hit.body).slice(0, 160),
    archiveTo: op === 'archive'
      ? path.relative(memoriesDir(), archiveTargetFor(hit.rel, hit.abs)).split(path.sep).join('/')
      : null,
  };
}

function makeBackupDir() {
  const d = path.join(os.tmpdir(), 'starmap-act-' + Date.now());
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function applyEntryOp(op, targetFp, confirmed) {
  if (op !== 'archive' && op !== 'delete') {
    return { ok: false, error: 'bad-op', allowed: ['archive', 'delete'] };
  }
  if (!targetFp || typeof targetFp !== 'string') return { ok: false, error: 'missing-fp' };
  const index = await buildFpIndex();
  const hits = index.get(targetFp) || [];
  if (hits.length === 0) return { ok: false, error: 'not-found' };
  if (hits.length > 1) return { ok: false, error: 'ambiguous', count: hits.length };
  const hit = hits[0];
  // 不可归档守卫：受保护条目拒绝归档（预览里也如实说"会被拒"）。
  const single = op === 'archive' ? protectionOf(hit) : null;
  if (single) {
    const guard = {
      protected: 1,
      protectedSamples: [protectedSample(hit.body, 60)],
      protectedSource: single.source,
      protectedFallback: single.source === 'inline' ? 1 : 0,
    };
    if (!confirmed) {
      return Object.assign({ ok: true, preview: true }, previewOf(op, hit), guard, {
        entriesBefore: hit.chunks.filter(function (c) { return c.trim(); }).length,
        wouldArchive: false,
        note: '这条受保护（' + (single.source === 'sidecar' ? '侧车标记' : '正文【保留】标记') + '），确认执行时会被拒绝归档（本次是预览，什么都没写）。',
      });
    }
    return Object.assign({ ok: false, error: 'protected', op, file: hit.rel }, guard, {
      note: '受保护的条目不可归档：主轨未改动，归档未写入。',
    });
  }
  if (!confirmed) {
    return Object.assign({ ok: true, preview: true }, previewOf(op, hit), {
      entriesBefore: hit.chunks.filter(function (c) { return c.trim(); }).length,
      note: '这是预览，什么都没写。确认要执行请带 confirmed:true 再调一次。',
    });
  }
  const bdir = makeBackupDir();
  const backup = path.join(bdir, hit.rel.split('/').join('__'));
  fs.copyFileSync(hit.abs, backup);
  const keep = hit.chunks.filter(function (_, i2) { return i2 !== hit.idx; });
  let text = keep.join('\n§\n');
  if (text && !text.endsWith('\n')) text += '\n';
  let archivedTo = null;
  if (op === 'archive') {
    const ap = archiveTargetFor(hit.rel, hit.abs);
    fs.mkdirSync(path.dirname(ap), { recursive: true });
    const pre = fs.existsSync(ap) && fs.statSync(ap).size > 0 ? '\n§\n' : '';
    fs.appendFileSync(ap, pre + hit.body + '\n', 'utf8');
    archivedTo = path.relative(memoriesDir(), ap).split(path.sep).join('/');
  }
  fs.writeFileSync(hit.abs, text, 'utf8');
  return Object.assign({ ok: true }, previewOf(op, hit), {
    archivedTo,
    backup,
    entriesBefore: hit.chunks.filter(function (c) { return c.trim(); }).length,
    entriesAfter: keep.filter(function (c) { return c.trim(); }).length,
  });
}

/** 批量：按文件分组，每个文件只读一次、写一次。 */
async function applyBatchOp(op, fps, confirmed, allowBulk) {
  if (op !== 'archive' && op !== 'delete') {
    return { ok: false, error: 'bad-op', allowed: ['archive', 'delete'] };
  }
  if (!Array.isArray(fps) || !fps.length) return { ok: false, error: 'missing-fps' };
  if (fps.length > 2000) return { ok: false, error: 'too-many', max: 2000 };
  // 批量写盘的显式闸门：超过 SMALL_BATCH 条必须由调用方显式声明 allowBulk。
  // 界面只在「可清理候选」那一行渲染按钮并带这个旗标；手写脚本要一次动几十条，
  // 就得自己把 allowBulk 写出来——是"我明确知道这是批量操作"，不是隐式放行。
  // 要有这道闸的原因：孤岛占全库 42%，一个放错位置的按钮就能把 600 多条真记忆
  // 扫进归档，而且这不进回收站、不可撤销（只能去归档文件里手工挪回来）。
  const SMALL_BATCH = 5;
  if (confirmed === true && fps.length > SMALL_BATCH && allowBulk !== true) {
    return {
      ok: false,
      error: 'bulk-needs-optin',
      count: fps.length,
      need: 'allowBulk:true',
      hint: '批量归档/删除 ' + fps.length + ' 条需显式 allowBulk:true；≤' + SMALL_BATCH +
        ' 条手工小批不需要。界面只有「可清理候选」（孤岛+零检索+超7天）会带这个旗标。',
    };
  }
  const index = await buildFpIndex();
  const found = [];
  const guarded = [];
  let guardedInline = 0;
  let missing = 0;
  let ambiguous = 0;
  for (const f of fps) {
    const hits = index.get(f);
    if (!hits || !hits.length) { missing++; continue; }
    if (hits.length > 1) { ambiguous++; continue; }
    // 不可归档守卫：受保护条目从"待归档集合"里摘掉，记数并留样例。
    if (op === 'archive') {
      const verdict = protectionOf(hits[0]);
      if (verdict) {
        if (verdict.source === 'inline') guardedInline++;
        guarded.push(hits[0]);
        continue;
      }
    }
    found.push(hits[0]);
  }
  const guard = {
    protected: guarded.length,
    protectedSamples: guarded.slice(0, 3).map(function (h) { return protectedSample(h.body, 60); }),
    protectedPreview: guarded.slice(0, 3).map(previewOfProtected),
    // 侧车查不到、靠正文【保留】兜住的条数（回退次数，如实上报）
    protectedFallback: guardedInline,
  };
  const byTrack = {};
  for (const h of found) {
    const t = trackOf(h.rel);
    byTrack[t] = (byTrack[t] || 0) + 1;
  }
  if (!confirmed) {
    return Object.assign({
      ok: true, preview: true, op,
      count: found.length, missing, ambiguous, byTrack,
      sample: found.slice(0, 5).map(function (h) { return previewOf(op, h); }),
      note: '预览，什么都没写。带 confirmed:true 再调一次才执行。',
    }, guard);
  }
  const byFile = new Map();
  for (const h of found) {
    const k = h.abs;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(h);
  }
  const bdir = makeBackupDir();
  let removed = 0;
  const archWrites = new Map();
  for (const entry of byFile) {
    const abs = entry[0];
    const hits = entry[1];
    const rel = hits[0].rel;
    fs.copyFileSync(abs, path.join(bdir, rel.split('/').join('__')));
    const drop = new Set(hits.map(function (h) { return h.idx; }));
    const chunks = hits[0].chunks;
    const keep = chunks.filter(function (_, i) { return !drop.has(i); });
    let text = keep.join('\n§\n');
    if (text && !text.endsWith('\n')) text += '\n';
    fs.writeFileSync(abs, text, 'utf8');
    removed += hits.length;
    if (op === 'archive') {
      const ap = archiveTargetFor(rel, abs);
      if (!archWrites.has(ap)) archWrites.set(ap, []);
      for (const h of hits) archWrites.get(ap).push(h.body);
    }
  }
  for (const entry of archWrites) {
    const ap = entry[0];
    const bodies = entry[1];
    fs.mkdirSync(path.dirname(ap), { recursive: true });
    const pre = fs.existsSync(ap) && fs.statSync(ap).size > 0 ? '\n§\n' : '';
    fs.appendFileSync(ap, pre + bodies.join('\n§\n') + '\n', 'utf8');
  }
  return Object.assign({
    ok: true, op, removed, files: byFile.size, missing, ambiguous, byTrack, backupDir: bdir,
  }, guard);
}

/* ------------------------------------------------------- 巡检报告（只读） */

function readPatrol() {
  try {
    // 巡检报告目录：默认 <cwd>/docs，可用 DSH_STARMAP_PATROL_DIR 覆盖。
    // 目录不存在就返回 null（图照常显示，只是没有水位数据），所以不写死任何绝对路径。
    const dir = process.env.DSH_STARMAP_PATROL_DIR || path.join(process.cwd(), 'docs');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(function (n) { return /^memory-patrol-\d{4}-\d{2}-\d{2}\.json$/.test(n); });
    if (!files.length) return null;
    files.sort();
    const name = files[files.length - 1];
    const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const at = Date.parse(j.generatedAt) || fs.statSync(path.join(dir, name)).mtimeMs;
    const water = Array.isArray(j.water) ? j.water : [];
    const rated = water.filter(function (w) { return w.ratio != null; });
    const worst = rated.slice().sort(function (a, b) { return b.ratio - a.ratio; })[0] || null;
    function pctOf(t) {
      const r = rated.filter(function (w) { return w.track === t; })
        .sort(function (a, b) { return b.ratio - a.ratio; })[0];
      return r ? Math.round(r.ratio * 1000) / 10 : null;
    }
    return {
      at: at,
      hoursAgo: Math.round(((Date.now() - at) / 3600000) * 10) / 10,
      mode: j.mode || '',
      file: name,
      duplicateGroups: (j.duplicates || []).length,
      conflicts: (j.conflicts || []).length,
      archived: (j.archived || []).length,
      worstTrack: worst ? worst.track : null,
      worstPct: worst ? Math.round(worst.ratio * 1000) / 10 : null,
      worstChars: worst ? worst.chars : null,
      worstBudget: worst ? worst.budget : null,
      keyPct: pctOf('key'),
      memoryPct: pctOf('memory'),
      userPct: pctOf('user'),
    };
  } catch { return null; }
}

/** 图数据下发时顺手带上巡检结果（只读附加，不影响缓存）。 */
function serveGraph(res, obj, head) {
  let out = obj;
  try {
    const p = readPatrol();
    if (p) out = Object.assign({}, obj, { patrol: p });
  } catch { /* 巡检缺失不影响主图 */ }
  sendJSON(res, 200, out, head);
}

function sendJSON(res, status, obj, head) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(head ? undefined : body);
}

/* ------------------------------------------------------------------ plugin */

export function apply(ctx) {
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() =>
      wctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          const _url = new URL(req.url || '/', 'http://localhost');
          const _rest = _url.pathname.slice(ROUTE_PATH.length);

          // ---- 维护操作：POST /act（默认只预览，confirmed:true 才写）----
          if (_rest === '/act') {
            if (req.method !== 'POST') {
              sendJSON(res, 405, { error: 'method-not-allowed', allow: 'POST' });
              return;
            }
            try {
              let raw = '';
              for await (const chunk of req) raw += chunk;
              const body = raw ? JSON.parse(raw) : {};
              const out = Array.isArray(body.fps)
                ? await applyBatchOp(body.op, body.fps, body.confirmed === true, body.allowBulk === true)
                : await applyEntryOp(body.op, body.fp, body.confirmed === true);
              if (out.ok && !out.preview) {
                // 写过了：图必须重建，否则界面还在显示旧结构
                startCompute(ctx.logger);
              }
              sendJSON(res, out.ok ? 200 : 400, out);
            } catch (e) {
              sendJSON(res, 500, { ok: false, error: String((e && e.message) || e) });
            }
            return;
          }

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405;
            res.end();
            return;
          }
          const head = req.method === 'HEAD';
          try {
            const url = _url;
            const rest = _rest;
            if (rest !== '/graph.json' && rest !== '/') {
              sendJSON(res, 404, { error: 'not-found' }, head);
              return;
            }
            loadDiskCache();
            const force = url.searchParams.get('refresh') === '1';
            const fresh = cache && Date.now() - lastComputeAt < CACHE_TTL_MS;

            if (force) {
              startCompute(ctx.logger);
              if (cache && !computing) {
                // Extremely fast path: compute finished synchronously (shouldn't happen).
                serveGraph(res, cache, head);
              } else {
                sendJSON(res, 200, { status: 'warming', refreshing: true }, head);
              }
              return;
            }

            if (cache && fresh) {
              serveGraph(res, cache, head);
              return;
            }

            if (!computing) startCompute(ctx.logger);

            if (cache) {
              // Serve the stale-but-usable cache while the rebuild runs.
              serveGraph(res, cache, head);
              return;
            }

            sendJSON(res, 200, { status: 'warming', error: lastError || undefined }, head);
          } catch (e) {
            sendJSON(res, 500, { status: 'error', error: String((e && e.stack) || e) }, head);
          }
        },
      }),
    );
  });
}

export const name = 'memory-starmap';

/** Test hook (no runtime effect): 只走预览分支，confirmed 固定 false，绝不写盘。 */
export async function __batchPreviewForTest(op, fps) {
  return applyBatchOp(op, fps, false);
}

/** Test hook: 巡检读取（只读）。 */
export function __patrolForTest() {
  return readPatrol();
}

export async function __actPreviewForTest(op, fp) {
  return applyEntryOp(op, fp, false);
}

/** Test hook (no runtime effect): build the graph once without the HTTP layer. */
export async function __buildGraphForTest() {
  return computeGraph(null);
}
