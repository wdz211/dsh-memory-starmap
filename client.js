/* eslint-disable */
/**
 * Client half of dsh-memory-starmap.
 *
 * 2D 极坐标盘 + 真实连线。
 *  - 半径 = 可达性（连接度 + 是否真被检索过 + 系统自己算的清晰度）
 *  - 角度 = 轨道扇区（扇区宽度按该轨条数分配）
 *  - 连线 = 真实的相似度边，线宽/线亮 = score
 *  - 实心 = 有连接，空心 = 孤岛，红圈 = 可清理候选
 *
 * 为什么不用 3D：z 轴没有编码任何信息，透过去看见背面会让画面糊成一团，
 * 旋转又让位置不稳定（人靠空间记忆读图）。2D 位置固定、无遮挡、能标字。
 * 无第三方库，无物理引擎，无相机。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-starmap',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var useRef = React.useRef;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;

    var ID = 'memory-starmap';

    var TRACK_COLORS = {
      // 旧配色 project 与 daily 几乎同色（#8f86b8 / #8a93a8），肉眼分不开；
      // 这里把 6 个轨的色相彻底拉开，并在深色底上提高明度
      key: '#ffc247',
      memory: '#2fd4c0',
      user: '#ff6fa5',
      project: '#7b8cff',
      daily: '#9aa7bd',
      failure: '#ff4d4d',
    };
    var TRACK_LABELS = {
      key: '关键记忆',
      memory: '全局记忆',
      user: '用户档案',
      project: '项目日志',
      daily: '每日日志',
      failure: '失败账本',
    };
    var TRACK_ORDER = ['key', 'memory', 'user', 'project', 'daily', 'failure'];

    /* --------------------------------------------------------------- icon */

    function StarIcon(props) {
      var size = (props && props.size) || 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4 15 L10 7 L17 10 L14 19 Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeOpacity: 0.6,
        }),
        h('path', { d: 'M10 7 L12 3', stroke: 'currentColor', strokeWidth: 1, strokeOpacity: 0.45 }),
        h('path', { d: 'M17 10 L21 6', stroke: 'currentColor', strokeWidth: 1, strokeOpacity: 0.45 }),
        h('path', { d: 'M4 15 L2 21', stroke: 'currentColor', strokeWidth: 1, strokeOpacity: 0.45 }),
        h('circle', { cx: 10, cy: 7, r: 2.1, fill: '#f5a742' }),
        h('circle', { cx: 4, cy: 15, r: 1.5, fill: '#3fd6d6' }),
        h('circle', { cx: 17, cy: 10, r: 1.5, fill: '#ff6fb5' }),
        h('circle', { cx: 14, cy: 19, r: 1.3, fill: '#a47bff' }),
        h('circle', { cx: 12, cy: 3, r: 1, fill: '#7f93c4' }),
      );
    }

    /* ------------------------------------------------------------- helpers */

    function detectDark(theme) {
      try {
        var t = theme && theme.getTheme && theme.getTheme();
        if (t) {
          if (t.scheme === 'light' || t.mode === 'light') return false;
          if (t.scheme === 'dark' || t.mode === 'dark') return true;
          if (typeof t.dark === 'boolean') return t.dark;
        }
      } catch (e) {
        /* ignore */
      }
      try {
        var el = document.documentElement;
        var sig = ((el && el.getAttribute('data-theme')) || '') + ' ' + ((document.body && document.body.className) || '');
        if (/light/i.test(sig)) return false;
      } catch (e) {
        /* ignore */
      }
      return true;
    }

    function withAlpha(hex, a) {
      var r = parseInt(hex.slice(1, 3), 16);
      var g = parseInt(hex.slice(3, 5), 16);
      var b = parseInt(hex.slice(5, 7), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    /* ---- 小球精灵：预渲染到离屏 canvas，避免每帧为上千个点建渐变 ---- */
    var SPHERE_CACHE = {};
    function mixHex(hex, to, t) {
      var r = parseInt(hex.slice(1, 3), 16);
      var g = parseInt(hex.slice(3, 5), 16);
      var b = parseInt(hex.slice(5, 7), 16);
      var tr = parseInt(to.slice(1, 3), 16);
      var tg = parseInt(to.slice(3, 5), 16);
      var tb = parseInt(to.slice(5, 7), 16);
      return 'rgb(' + Math.round(r + (tr - r) * t) + ',' + Math.round(g + (tg - g) * t) + ',' + Math.round(b + (tb - b) * t) + ')';
    }
    function sphereSprite(color, rad, lit) {
      var key = color + '|' + rad + '|' + (lit ? 1 : 0);
      var hit = SPHERE_CACHE[key];
      if (hit) return hit;
      var scale = 3;
      var pad = 1.5;
      var size = Math.ceil((rad * 2 + pad * 2) * scale);
      var cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      var g2 = cv.getContext('2d');
      var cxp = size / 2;
      var cyp = size / 2;
      var rp = rad * scale;
      // 实心球：平涂本体 + 左上硬高光 + 右下暗部 + 边缘光。
      // 旧版是"中心近白 + 外圈黑"的发光球，几百个叠在一起会相加过曝成一团白光。
      // 发光圆球：中心亮核 -> 本色 -> 暗边。
      // 中心白度压到 0.58：几百个球重叠时不会累加成纯白（旧版 0.78 就是中心那团白光的来源）
      var gr = g2.createRadialGradient(
        cxp - rp * 0.32, cyp - rp * 0.34, rp * 0.05,
        cxp, cyp, rp
      );
      if (lit) {
        gr.addColorStop(0, mixHex(color, '#ffffff', 0.58));
        gr.addColorStop(0.30, mixHex(color, '#ffffff', 0.24));
        gr.addColorStop(0.68, color);
        gr.addColorStop(0.90, mixHex(color, '#000000', 0.40));
        gr.addColorStop(1, mixHex(color, '#000000', 0.70));
      } else {
        gr.addColorStop(0, mixHex(color, '#000000', 0.50));
        gr.addColorStop(0.60, mixHex(color, '#000000', 0.66));
        gr.addColorStop(1, mixHex(color, '#000000', 0.84));
      }
      g2.fillStyle = gr;
      g2.beginPath();
      g2.arc(cxp, cyp, rp, 0, Math.PI * 2);
      g2.fill();
      // 小球（<3.5px）不描边：那圈边缘光在这个尺寸会变成"环套环"
      if (rad >= 3.5) {
        g2.strokeStyle = lit ? withAlpha(color, 0.80) : 'rgba(210,224,246,0.70)';
        g2.lineWidth = Math.max(1, scale * 0.30);
        g2.beginPath();
        g2.arc(cxp, cyp, rp - g2.lineWidth / 2, 0, Math.PI * 2);
        g2.stroke();
      }
      var sprite = { cv: cv, w: rad * 2 + pad * 2 };
      SPHERE_CACHE[key] = sprite;
      return sprite;
    }

    /* --------------------------------------------------------------- panel */

    function GraphPanel(props) {
      var theme = props && props.theme;

      var containerRef = useRef(null);
      var canvasRef = useRef(null);
      var tooltipRef = useRef(null);

      var dataRef = useRef(null); // { nodes, links }
      var layRef = useRef(null); // { pts, byId, sect, present, counts, cx, cy, RMAX, W, H }
      var viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
      var dragRef = useRef(null);
      var staticRef = useRef(null);          // 静态背景层（环/扇区分隔/标签）离屏预渲染
      var linkRef = useRef(null);            // 连线烘焙层（切档/切主题时才重建）
      var linkStampRef = useRef('');
      var animRef = useRef({ pulse: null }); // 点击扩散脉冲状态
      var loopRef = useRef(0);               // 常驻动画循环句柄
      var rafRef = useRef(0);

      var uiRef = useRef({
        filters: {},
        showAll: true,
        searchLower: '',
        matchSet: null,
        selectedId: null,
        dark: true,
        animate: true,
        focus: null,
      });

      var statusState = useState('loading');
      var status = statusState[0], setStatus = statusState[1];
      var statsState = useState(null);
      var stats = statsState[0], setStats = statsState[1];
      var errState = useState('');
      var errMsg = errState[0], setErrMsg = errState[1];
      var selectedState = useState(null);
      var selected = selectedState[0], setSelected = selectedState[1];
      var filtersState = useState({});
      var filters = filtersState[0], setFilters = filtersState[1];
      var showAllState = useState(true);
      var showAll = showAllState[0], setShowAll = showAllState[1];
      var searchState = useState('');
      var search = searchState[0], setSearch = searchState[1];
      var tickState = useState(0);
      var tick = tickState[0], setTick = tickState[1];
      var animState = useState(true);
      var animate = animState[0], setAnimate = animState[1];
      var focusState = useState(null);
      var focus = focusState[0], setFocus = focusState[1];
      var guideState = useState(true);
      var showGuide = guideState[0], setShowGuide = guideState[1];
      var actMsgState = useState('');
      var actMsg = actMsgState[0], setActMsg = actMsgState[1];
      var actPendState = useState(null);
      var actPend = actPendState[0], setActPend = actPendState[1];
      var batchMsgState = useState('');
      var batchMsg = batchMsgState[0], setBatchMsg = batchMsgState[1];
      var batchPendState = useState(null);
      var batchPend = batchPendState[0], setBatchPend = batchPendState[1];

      var dark = detectDark(theme);

      /* ---- fetch + poll ---- */
      useEffect(() => {
        var stopped = false;
        var timer = null;
        var staleRetry = 0; // 拿到"没有语义字段"的旧图时的重试次数，防止死循环
        function load(force) {
          var url = '/x-memory-starmap/graph.json' + (force ? '?refresh=1' : '');
          fetch(url, { cache: 'no-store' })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.json();
            })
            .then(function (body) {
              if (stopped) return;
              if (body && body.status === 'ready' && Array.isArray(body.nodes)) {
                // 陈旧探测：新版图每个节点都带 strength；没有就说明主机还挂着旧图。
                // v3 再加 region/regions 与 stats.maxCore 探测；v4 用 cores（核层）探测 ——
                // 旧图若还带非空 clusters（互斥簇口径）或干脆没有 cores，就说明主机没换算法。
                var probe = body.nodes[0];
                if ((!probe || probe.strength === undefined || probe.region === undefined
                  || typeof probe.core !== 'number'
                  || !Array.isArray(body.regions) || !Array.isArray(body.cores)
                  || (body.clusters && body.clusters.length)
                  || !body.stats || typeof body.stats.maxCore !== 'number') && staleRetry < 2) {
                  staleRetry++;
                  setStatus('warming');
                  timer = setTimeout(function () { load(true); }, 800);
                  return;
                }
                dataRef.current = {
                  nodes: body.nodes,
                  links: body.links || [],
                  patrol: body.patrol || null,
                  regions: body.regions || [],
                  clusters: body.clusters || [],
                  cores: body.cores || [],
                };
                setErrMsg('');
                setStatus('ready');
                setStats(body.stats || null);
              } else {
                setStatus('warming');
                timer = setTimeout(function () { load(false); }, 1500);
              }
            })
            .catch(function (e) {
              if (stopped) return;
              setStatus('error');
              setErrMsg(String(e && e.message ? e.message : e));
              timer = setTimeout(function () { load(false); }, 3000);
            });
        }
        load(false);
        return function () {
          stopped = true;
          if (timer) clearTimeout(timer);
        };
      }, []);

      /* ---- 同步 ui 状态到 ref（draw 只读 ref，避免闭包过期）---- */
      var edgeState = useState('all');
      var edgeMode = edgeState[0], setEdgeMode = edgeState[1];
      /* P0 分组开关：轨道（现状）/ 隔离区。只换扇区分组键，节点颜色仍按轨道 */
      var groupState = useState('track');
      var groupMode = groupState[0], setGroupMode = groupState[1];
      /* P1 核层（年轮）开关：关 / k>=12 / k>=8 / k>=6 / k>=3，一次只画其中一层。
         clusterSel = 选中那层的 k 门槛（复用 focusSet 高亮成员） */
      var clusterState = useState('off');
      var clusterMode = clusterState[0], setClusterMode = clusterState[1];
      var clusterSelState = useState(null);
      var clusterSel = clusterSelState[0], setClusterSel = clusterSelState[1];
      /* 图里真实存在的核层 k 值（降序）。某门槛不够 5 条时后端不输出该层，
         这里如实反映 —— 没有的档位点了也不画，不编造。 */
      function coreLevels() {
        var d = dataRef.current;
        var out = [];
        if (d && d.cores) {
          for (var i = 0; i < d.cores.length; i++) {
            if (d.cores[i] && typeof d.cores[i].k === 'number') out.push(d.cores[i].k);
          }
        }
        return out;
      }
      var coreModeK = clusterMode === 'off' ? 0 : parseInt(String(clusterMode).slice(1), 10) || 0;
      var coreMissing = coreModeK > 0 && coreLevels().indexOf(coreModeK) < 0;
      /* 年轮摘要文本，数字全部来自 cores（图例与按钮提示共用，禁止写死） */
      function coreRingText() {
        var d = dataRef.current;
        var parts = [];
        if (d && d.cores) {
          for (var i = 0; i < d.cores.length; i++) {
            var L = d.cores[i];
            if (L && typeof L.k === 'number' && typeof L.size === 'number') {
              parts.push('k\u2265' + L.k + ' ' + L.size + '\u6761');
            }
          }
        }
        return parts.join(' / ');
      }
      uiRef.current.edgeMode = edgeMode;
      uiRef.current.groupMode = groupMode;
      uiRef.current.clusterMode = clusterMode;
      uiRef.current.clusterSel = clusterSel;
      uiRef.current.filters = filters;
      uiRef.current.showAll = showAll;
      uiRef.current.dark = dark;
      uiRef.current.animate = animate;
      uiRef.current.focus = focus;
      uiRef.current.selectedId = selected ? selected.id : null;
      var searchLower = search.trim().toLowerCase();
      uiRef.current.searchLower = searchLower;
      uiRef.current.matchSet = useMemo(function () {
        if (!searchLower) return null;
        var d = dataRef.current;
        if (!d) return null;
        var s = new Set();
        for (var i = 0; i < d.nodes.length; i++) {
          var n = d.nodes[i];
          if (n.text && n.text.toLowerCase().indexOf(searchLower) >= 0) s.add(n.id);
        }
        return s;
      }, [searchLower, status]);

      /* ---- 绘制 ---- */
      /* ---- 布局 + 静态层重建 ---- */
      function draw() {
        var canvas = canvasRef.current;
        var container = containerRef.current;
        if (!canvas || !container) return;
        var d = dataRef.current;
        var cw = container.clientWidth || 800;
        var ch = container.clientHeight || 600;
        var dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
          canvas.width = Math.floor(cw * dpr);
          canvas.height = Math.floor(ch * dpr);
        }
        var ui = uiRef.current;
        if (!d || !d.nodes.length) {
          var c0 = canvas.getContext('2d');
          c0.setTransform(dpr, 0, 0, dpr, 0, 0);
          c0.fillStyle = ui.dark ? '#0b0b0d' : '#f7f9fc';
          c0.fillRect(0, 0, cw, ch);
          layRef.current = null;
          return;
        }

        var padTop = 76;
        var padBottom = 26;
        var padSide = 96;
        var cx = cw / 2;
        var cy = (ch + padTop - padBottom) / 2;
        var RMAX = Math.max(60, Math.min((cw - padSide * 2) / 2, (ch - padTop - padBottom) / 2));

        var gmode = ui.groupMode || 'track';
        var by = {}, i, n, gk0;
        for (i = 0; i < d.nodes.length; i++) {
          n = d.nodes[i];
          if (ui.filters[n.track] === false) continue;
          if (!ui.showAll && n.isOrphan) continue;
          // 分组键：默认按轨道（现状）；切到隔离区时按 region（目录就是隔离边界）
          gk0 = gmode === 'region' ? (n.region || 'global') : n.track;
          (by[gk0] = by[gk0] || []).push(n);
        }
        var present;
        if (gmode === 'region') {
          present = [];
          var regList = d.regions || [];
          for (i = 0; i < regList.length; i++) {
            if (by[regList[i].key]) present.push(regList[i].key);
          }
          for (gk0 in by) if (present.indexOf(gk0) < 0) present.push(gk0);
        } else {
          present = TRACK_ORDER.filter(function (t) { return by[t] && by[t].length; });
        }
        // 扇区标签/颜色：隔离区模式下标签 = regionLabel，颜色取中性色（节点颜色仍按轨道，
        // 扇区颜色若也按轨道上色会让人误以为区域有类别色）
        var labelOf = {}, colorOf = {};
        var labelByKey = {};
        for (i = 0; i < ((d.regions || []).length); i++) labelByKey[d.regions[i].key] = d.regions[i].label;
        for (i = 0; i < present.length; i++) {
          var pk0 = present[i];
          if (gmode === 'region') {
            labelOf[pk0] = labelByKey[pk0] || pk0;
            colorOf[pk0] = ui.dark ? 'rgba(196,210,240,0.92)' : 'rgba(38,52,80,0.92)';
          } else {
            labelOf[pk0] = TRACK_LABELS[pk0] || pk0;
            colorOf[pk0] = TRACK_COLORS[pk0] || '#9aa7bd';
          }
        }
        var counts = {}, total = 0;
        for (i = 0; i < present.length; i++) {
          counts[present[i]] = by[present[i]].length;
          total += counts[present[i]];
        }
        // 小轨道按条数只分到几度（失败账本 30 条 ≈ 9°），根本看不见；
        // 给每个轨保底 12°，剩下的按条数比例分配
        var sect = {}, acc = -Math.PI / 2;
        var MIN_SECT = 0.2094;
        var sectRest = Math.max(0, 2 * Math.PI - MIN_SECT * present.length);
        var sectW = 0;
        for (i = 0; i < present.length; i++) sectW += counts[present[i]] || 0;
        for (i = 0; i < present.length; i++) {
          var t0 = present[i];
          var a = MIN_SECT + sectRest * ((counts[t0] || 0) / (sectW || 1));
          sect[t0] = { a0: acc, a1: acc + a, n: counts[t0] };
          acc += a;
        }
        // ★ 面积均分：先按 radiusNorm 排序，再用 sqrt(名次) 定半径。
        //   这样"强度高在内圈"的语义不变，但每一层分到的面积相等 ——
        //   旧版直接用 radiusNorm 当半径，强度集中在 0.3-0.5 的几百个节点
        //   会精确落在同一圈上，叠成一团白光。角度也按黄金比抖动，避免并列。
        var pts = [], byId = {};
        var GOLD = 0.5698402909980532;
        for (i = 0; i < present.length; i++) {
          var tk = present[i], sc2 = sect[tk], arr = by[tk];
          arr = arr.slice().sort(function (a1, b1) {
            return (a1.radiusNorm || 0) - (b1.radiusNorm || 0);
          });
          for (var k = 0; k < arr.length; k++) {
            var nn = arr[k];
            // ★ 角度必须与半径解耦：若角度也用 k，就会和 sqrt(k/n) 的半径联动成一条螺旋线
            //   （表现为"从外缘卷向中心的点带，其余区域全空"）。用 id 散列定角度，
            //   位置稳定（同一节点每次刷新都在原处），且与排名无关，扇区才能被真正铺满。
            var uh = ((nn.id * 2654435761) % 10007) / 10007;
            var ang = sc2.a0 + (sc2.a1 - sc2.a0) * (0.03 + 0.94 * uh);
            // 半径 = 可达性，但要用「名次」而不是 radiusNorm 原值来定半径：
            //   radiusNorm 的上界被公式锁死在 0.64 附近（强度最低也有 0.28），
            //   直接拿原值画，最外圈 36% 的圆盘永远是空的，内圈反而堆成几道环。
            //   改成 sqrt(名次)：面积均匀 → 从中心往外铺满，同时仍然「越强越靠里」。
            var qq = (k + 0.5) / arr.length;
            var rr = RMAX * (0.12 + 0.88 * Math.sqrt(qq))
              + (((k * 0.7548776662) % 1) - 0.5) * RMAX * 0.03;
            var pt = {
              n: nn, x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr,
              bx: 0, by: 0, ph: (k * 0.618034) % 6.2832,
            };
            pts.push(pt);
            byId[nn.id] = pt;
          }
        }
        var adj = {};
        for (i = 0; i < d.links.length; i++) {
          var lk = d.links[i];
          if (!byId[lk.source] || !byId[lk.target]) continue;
          (adj[lk.source] = adj[lk.source] || []).push(lk.target);
          (adj[lk.target] = adj[lk.target] || []).push(lk.source);
        }
        layRef.current = {
          pts: pts, byId: byId, sect: sect, present: present, counts: counts,
          cx: cx, cy: cy, RMAX: RMAX, W: cw, H: ch, adj: adj, focusSet: null,
          groupMode: gmode, labelOf: labelOf, colorOf: colorOf, coreLayer: null,
        };
        if (ui.focus) {
          var fset = {};
          for (i = 0; i < d.nodes.length; i++) {
            var nn3 = d.nodes[i];
            var hitF = ui.focus === 'orphan' ? nn3.isOrphan
              : ui.focus === 'never' ? !nn3.recallCount
              : ui.focus === 'evict' ? nn3.evictCandidate
              : ui.focus === 'failure' ? nn3.track === 'failure'
              : ui.focus === 'key' ? nn3.track === 'key'
              : false;
            if (hitF) fset[nn3.id] = 1;
          }
          layRef.current.focusSet = fset;
        }
        // 选中某个核层 = 复用同一套高亮：焦点集合就是这一层的成员（内部边随之点亮）
        // 成员集合后端已按 core>=k 筛好，与画出来的范围完全一致
        if (ui.clusterSel != null) {
          var clist = d.cores || [];
          for (i = 0; i < clist.length; i++) {
            if (clist[i] && clist[i].k === ui.clusterSel && clist[i].members) {
              var cfset = {};
              for (var mi = 0; mi < clist[i].members.length; mi++) cfset[clist[i].members[mi]] = 1;
              layRef.current.focusSet = cfset;
              break;
            }
          }
        }
        buildStatic();
        startLoop();
      }

      /* 静态背景层：同心环 / 扇区分隔 / 轨标签。只在布局变化时重画一次。 */
      function buildStatic() {
        var lay = layRef.current;
        if (!lay) return;
        var ui = uiRef.current;
        var W = lay.W, H = lay.H, cx = lay.cx, cy = lay.cy, RMAX = lay.RMAX;
        var sc = staticRef.current;
        if (!sc) { sc = document.createElement('canvas'); staticRef.current = sc; }
        var dpr = window.devicePixelRatio || 1;
        if (sc.width !== Math.floor(W * dpr) || sc.height !== Math.floor(H * dpr)) {
          sc.width = Math.floor(W * dpr);
          sc.height = Math.floor(H * dpr);
        }
        var g = sc.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        var i;
        g.strokeStyle = ui.dark ? 'rgba(255,255,255,0.085)' : 'rgba(0,0,0,0.09)';
        g.lineWidth = 1;
        for (i = 1; i <= 5; i++) {
          g.beginPath();
          g.arc(cx, cy, (RMAX * i) / 5, 0, Math.PI * 2);
          g.stroke();
        }
        for (i = 0; i < lay.present.length; i++) {
          var st = lay.sect[lay.present[i]];
          // 扇区分隔线：从内侧 0.12R 拉到外缘（不从圆心出，避免中心糊）
          g.strokeStyle = ui.dark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.22)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(cx + Math.cos(st.a0) * RMAX * 0.12, cy + Math.sin(st.a0) * RMAX * 0.12);
          g.lineTo(cx + Math.cos(st.a0) * RMAX, cy + Math.sin(st.a0) * RMAX);
          g.stroke();
        }
        g.textBaseline = 'middle';
        /* P1 核层：**不画任何"圈"**。
           节点的位置由「可达性排名定半径 + 轨道定扇区」决定，与它属于哪个密度核完全无关，
           所以同一层的成员必然散落在整个盘面上 —— 画圆、矩形、凸包都在暗示"这里是一块区域"，那是假象。
           真实可画的东西是：这一层成员之间**真实存在的那些边**。
           画出来就是一张网：k>=12 那层是 15 个点、105 条边（完全图），密到发亮，这才是"抱团"的真实样子。
           内部边与成员高亮各合成一条 path、各一次 stroke，仍在静态层，零新增逐帧开销。 */
        var cmode = ui.clusterMode || 'off';
        lay.coreLayer = null;
        if (cmode !== 'off') {
          var lv = parseInt(String(cmode).slice(1), 10) || 0;
          var clAll = (dataRef.current && dataRef.current.cores) || [];
          var dsrc = dataRef.current || {};
          for (var ci = 0; ci < clAll.length; ci++) {
            var cl = clAll[ci];
            if (!cl || cl.k !== lv || !cl.members || !cl.members.length) continue;
            var inSet = {}, visIds = [], sx = 0, sy = 0;
            for (var mj = 0; mj < cl.members.length; mj++) {
              var mp = lay.byId[cl.members[mj]];
              if (!mp || !mp.n) continue;
              inSet[cl.members[mj]] = 1;
              sx += mp.x; sy += mp.y; visIds.push(cl.members[mj]);
            }
            if (visIds.length < 5) continue;      // 太薄的一片不画，免得看着像"抱团"
            var ccx = sx / visIds.length, ccy = sy / visIds.length;
            var dens = (cl.density == null) ? 0 : cl.density;
            var hiDens = dens >= 0.3;             // 密度 >=0.3 的层画亮，稀疏层画淡
            var dom = '-';
            for (var dk in (cl.trackMix || {})) { dom = dk; break; }  // trackMix 已按占比降序
            var ccol = TRACK_COLORS[dom] || '#9aa7bd';
            // ① 该层内部边：两端都在成员集合里的真实连线（一次遍历全部 links）
            var ewPts = [], lnk = dsrc.links || [];
            for (var li = 0; li < lnk.length; li++) {
              var L2 = lnk[li];
              if (!inSet[L2.source] || !inSet[L2.target]) continue;
              var pa = lay.byId[L2.source], pb = lay.byId[L2.target];
              if (!pa || !pb) continue;
              ewPts.push(pa.x, pa.y, pb.x, pb.y);
            }
            if (ewPts.length) {
              g.beginPath();
              for (var pi = 0; pi < ewPts.length; pi += 4) {
                g.moveTo(ewPts[pi], ewPts[pi + 1]);
                g.lineTo(ewPts[pi + 2], ewPts[pi + 3]);
              }
              g.strokeStyle = withAlpha(ccol, hiDens ? 0.55 : 0.28);
              g.lineWidth = hiDens ? 1.1 : 0.8;
              g.stroke();
            }
            // ② 成员加亮：一圈 1px 描边，合成一条 path、一次 stroke
            g.beginPath();
            for (var mk = 0; mk < visIds.length; mk++) {
              var mp3 = lay.byId[visIds[mk]];
              g.moveTo(mp3.x + 3.2, mp3.y);
              g.arc(mp3.x, mp3.y, 3.2, 0, Math.PI * 2);
            }
            g.strokeStyle = withAlpha(ccol, hiDens ? 0.95 : 0.6);
            g.lineWidth = 1;
            g.stroke();
            // ③ 标签放质心（已经不存在"圆半径外"这个概念）
            var ctext = '核 k\u2265' + (cl.k || lv) + ' \u00b7 ' + visIds.length + '\u6761 \u00b7 '
              + (ewPts.length / 4) + '\u6761\u5185\u90e8\u8fb9 \u00b7 \u4e3b\u5bfc:' + (TRACK_LABELS[dom] || dom);
            g.font = '500 12px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.lineWidth = 3;
            g.strokeStyle = ui.dark ? 'rgba(11,11,13,0.85)' : 'rgba(247,249,252,0.85)';
            g.strokeText(ctext, ccx, ccy);   // 先垫一层背景色，否则标签会被密集的边吞掉
            g.fillStyle = withAlpha(ccol, 0.95);
            g.fillText(ctext, ccx, ccy);
            lay.coreLayer = {
              k: cl.k || lv, size: visIds.length, pairs: ewPts.length / 4,
              members: visIds, label: ctext,
            };
          }
        }
        g.font = '600 12px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif';
        g.textBaseline = 'middle';
        g.textAlign = 'center';
        // 布局变了 -> 连线层必须重建（否则连线还停在旧坐标上）
        linkStampRef.current = '';
        for (i = 0; i < lay.present.length; i++) {
          var t3 = lay.present[i], s3 = lay.sect[t3];
          var am = (s3.a0 + s3.a1) / 2, lr = RMAX + 26;
          g.fillStyle = (lay.colorOf && lay.colorOf[t3]) || TRACK_COLORS[t3] || '#9aa7bd';
          g.fillText(((lay.labelOf && lay.labelOf[t3]) || TRACK_LABELS[t3] || t3) + ' ' + lay.counts[t3],
            cx + Math.cos(am) * lr, cy + Math.sin(am) * lr);
        }
        // 半径刻度：每圈 = 排名 20%。让「半径=可达性排名」能肉眼读出来
        g.font = '500 10px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif';
        g.fillStyle = ui.dark ? 'rgba(255,255,255,0.42)' : 'rgba(0,0,0,0.42)';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        for (i = 1; i <= 5; i++) {
          var rPct = (RMAX * i) / 5;
          var lxP = cx + rPct * 0.7071 + 3, lyP = cy - rPct * 0.7071 - 1;
          // 先用背景色描一遍做垫底，否则刻度会被密集的点盖掉
          g.lineWidth = 3;
          g.strokeStyle = ui.dark ? 'rgba(11,11,13,0.88)' : 'rgba(247,249,252,0.88)';
          g.strokeText((i * 20) + '%', lxP, lyP);
          g.fillText((i * 20) + '%', lxP, lyP);
        }
      }
      /* 连线图层：按档位一次性烘焙到离屏 canvas，每帧只 blit。
         2141 条线逐条 stroke 是开图卡顿的主因，这里把它压成 4 次 stroke + 1 次 blit。 */
      function buildLinkLayer() {
        var lay = layRef.current, d = dataRef.current;
        if (!lay || !d) return;
        var ui = uiRef.current;
        var cv = linkRef.current;
        if (!cv) { cv = document.createElement('canvas'); linkRef.current = cv; }
        var dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.floor(lay.W * dpr) || cv.height !== Math.floor(lay.H * dpr)) {
          cv.width = Math.floor(lay.W * dpr);
          cv.height = Math.floor(lay.H * dpr);
        }
        var g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, lay.W, lay.H);
        var emode = ui.edgeMode || 'all';
        linkStampRef.current = emode + '|' + (ui.dark ? 1 : 0);
        if (emode === 'off') return;
        var byId = lay.byId;
        var segs = [[], [], [], []];
        var i, lk, A, B, score, tier;
        for (i = 0; i < d.links.length; i++) {
          lk = d.links[i];
          A = byId[lk.source];
          B = byId[lk.target];
          if (!A || !B) continue;
          score = lk.score || 0;
          tier = score >= 16 ? 3 : (score >= 11 ? 2 : (score >= 8 ? 1 : 0));
          if (emode === 'strong' && tier < 2) continue;
          segs[tier].push(A.x, A.y, B.x, B.y);
        }
        var OP = [0.045, 0.11, 0.26, 0.55];
        var LW = [0.5, 0.65, 0.95, 1.5];
        g.lineCap = 'round';
        for (var t = 0; t < 4; t++) {
          var arr2 = segs[t];
          if (!arr2.length) continue;
          g.strokeStyle = ui.dark
            ? 'rgba(150,180,235,' + OP[t] + ')'
            : 'rgba(56,78,120,' + OP[t] + ')';
          g.lineWidth = LW[t];
          g.beginPath();
          for (var q = 0; q < arr2.length; q += 4) {
            g.moveTo(arr2[q], arr2[q + 1]);
            g.lineTo(arr2[q + 2], arr2[q + 3]);
          }
          g.stroke();
          if (t === 3) {
            g.strokeStyle = ui.dark ? 'rgba(120,200,255,0.10)' : 'rgba(56,78,120,0.07)';
            g.lineWidth = LW[3] * 4.0;
            g.stroke();
          }
        }
      }

      /* 每帧：清屏 → 静态层 → 连线 → 小球 → 脉冲/高亮 */
      function renderFrame(tSec) {
        var canvas = canvasRef.current;
        var lay = layRef.current;
        var d = dataRef.current;
        if (!canvas || !lay || !d) return;
        var c = canvas.getContext('2d');
        var ui = uiRef.current;
        var view = viewRef.current;
        var dpr = window.devicePixelRatio || 1;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.fillStyle = ui.dark ? '#0b0b0d' : '#f7f9fc';
        c.fillRect(0, 0, lay.W, lay.H);
        c.save();
        c.translate(lay.cx + view.panX, lay.cy + view.panY);
        c.scale(view.zoom, view.zoom);
        c.translate(-lay.cx, -lay.cy);
        if (staticRef.current) c.drawImage(staticRef.current, 0, 0, lay.W, lay.H);

        var animate = ui.animate;
        var pts = lay.pts, byId = lay.byId, i, p;
        // 呼吸：只有"有连接"的节点轻微浮动，孤岛完全静止 —— 活的在动，死的钉住
        for (i = 0; i < pts.length; i++) {
          p = pts[i];
          if (animate && !p.n.isOrphan) {
            p.bx = Math.sin(tSec * 2.0 + p.ph) * 0.55;
            p.by = Math.cos(tSec * 1.7 + p.ph) * 0.55;
          } else {
            p.bx = 0;
            p.by = 0;
          }
        }

        var matchSet = ui.matchSet;
        var selId = ui.selectedId;
        var pulse = animRef.current.pulse;
        var focusSet = lay.focusSet;

        /* 连线：默认不画。
           1204 个节点 / 1938 条边画在同一张极坐标图上，跨扇区的长线必然结成
           "线墙"，把节点状态整个盖掉 —— 而这张图首要目的是看记忆状态。
           所以：选中节点只画它的边；筛了类别只画该类内部边；也可手动开 强/全。 */
        /* 连线：全部照画，但按 score 分四档，亮度与粗细同时区分 ——
              >=16  强   ：亮、粗、外加一层光晕（骨架）
              11-15 中   ：清楚可见
              8-10  弱   ：淡，能看出走向但抢不了节点
              <8    极弱 ：只当一层底纹，证明"这里连过"，但不构成视觉噪音
           全部画出来 + 分档，是为了既不丢信息、又不糊成线墙。 */
        /* 连线不在这里逐条画 —— 2141 条线每帧 stroke 一次就是卡顿的根。
           现在：links 预烘焙到离屏图层（linkRef），只有切档/切主题/换数据才重建；
           每帧这里只 drawImage 一次。选中/聚焦时才走少量实时绘制。 */
        var emode = ui.edgeMode || 'all';
        if (linkStampRef.current !== emode + '|' + (ui.dark ? 1 : 0)) buildLinkLayer();
        if (!selId && !focusSet) {
          if (linkRef.current && emode !== 'off') c.drawImage(linkRef.current, 0, 0, lay.W, lay.H);
        } else {
          var EDGE_OP0 = [0.045, 0.11, 0.26, 0.55];
          var EDGE_LW0 = [0.5, 0.65, 0.95, 1.5];
          c.lineCap = 'round';
          for (i = 0; i < d.links.length; i++) {
            var lk2 = d.links[i];
            var A2 = byId[lk2.source], B2 = byId[lk2.target];
            if (!A2 || !B2) continue;
            var sc2 = lk2.score || 0;
            var tr2 = sc2 >= 16 ? 3 : (sc2 >= 11 ? 2 : (sc2 >= 8 ? 1 : 0));
            var isSelEdge2 = !!(selId && (lk2.source === selId || lk2.target === selId));
            if (selId) { if (!isSelEdge2) continue; }
            else if (focusSet) { if (!(focusSet[lk2.source] && focusSet[lk2.target])) continue; }
            if (selId && focusSet && !isSelEdge2) continue;
            var op2 = isSelEdge2 ? 0.85 : EDGE_OP0[tr2];
            var lw2 = isSelEdge2 ? 2.2 : EDGE_LW0[tr2];
            if (matchSet) op2 *= 0.55;
            c.strokeStyle = ui.dark
              ? 'rgba(150,180,235,' + op2.toFixed(3) + ')'
              : 'rgba(56,78,120,' + op2.toFixed(3) + ')';
            c.lineWidth = lw2;
            c.beginPath();
            c.moveTo(A2.x + A2.bx, A2.y + A2.by);
            c.lineTo(B2.x + B2.bx, B2.y + B2.by);
            c.stroke();
          }
        }

        /* 节点：按 (颜色, 透明度档) 打包成一条路径，每档只 fill/stroke 一次。
           原来 1293 个节点 = 1293 次 beginPath+fill，且每帧还要重排一次序；
           现在 fill 次数降到 ~30，排序直接取消 —— 这是开图卡顿的主因。 */
        var solidG = {}, hollowG = {}, haloG = {};
        var redList = [], pulseList = [], matchList = [], selRing = null;
        for (i = 0; i < pts.length; i++) {
          p = pts[i];
          var nd2 = p.n;
          var col2 = TRACK_COLORS[nd2.track] || '#9aa7bd';
          var st2 = nd2.strength == null ? 0.45 : nd2.strength;
          var radPx = 1.8 + Math.pow(nd2.degree || 0, 0.62) * 0.92 + (st2 - 0.30) * 6.0;
          if (radPx > 9) radPx = 9;
          if (nd2.track === 'failure') radPx += 0.6;
          var isMatch2 = !!(matchSet && matchSet.has(nd2.id));
          var isSel2 = selId === nd2.id;
          var aa = nd2.isOrphan ? 0.55 : (0.76 + 0.16 * st2);
          if (matchSet && !isMatch2) aa *= 0.22;
          if (selId && !isSel2) aa *= 0.42;
          if (focusSet && !focusSet[nd2.id]) aa *= 0.14;
          var glow2 = 0;
          if (pulse) {
            var hp2 = pulse.hops[nd2.id];
            if (hp2 != null) {
              var cyc2 = (tSec - pulse.t0) % 3.0;
              var kk2 = (cyc2 - hp2 * 0.18) / 0.65;
              if (kk2 > 0 && kk2 < 1) { glow2 = Math.sin(kk2 * Math.PI); aa = Math.min(1, aa + glow2 * 0.5); }
            }
          }
          var nx2 = p.x + p.bx, ny2 = p.y + p.by;
          if (nd2.isOrphan) {
            var oa = Math.max(0.22, Math.min(1, aa * 1.20));
            var oq = Math.round(oa * 10) / 10, okey = col2 + '|' + oq;
            if (!hollowG[okey]) hollowG[okey] = { col: col2, a: oq, v: [] };
            hollowG[okey].v.push(nx2, ny2);
          } else {
            var dotR = Math.max(1.5, radPx * 0.55);
            var fq = Math.round(Math.max(0.15, Math.min(1, aa)) * 10) / 10, fkey = col2 + '|' + fq;
            if (!solidG[fkey]) solidG[fkey] = { col: col2, a: fq, v: [] };
            solidG[fkey].v.push(nx2, ny2, dotR);
            if ((nd2.degree || 0) >= 8) {
              if (!haloG[col2]) haloG[col2] = { col: col2, v: [] };
              haloG[col2].v.push(nx2, ny2, dotR);
            }
          }
          if (glow2 > 0.02) pulseList.push(nx2, ny2, radPx + 2.2 + glow2 * 1.6, glow2 * 0.85);
          if (nd2.evictCandidate) redList.push(nx2, ny2, radPx + 3);
          if (isMatch2) matchList.push(nx2, ny2, radPx + 3.2);
          if (isSel2) selRing = [nx2, ny2, radPx + 5];
        }
        var gk, gv, gi;
        /* 枢纽光晕（先画，压在点底下） */
        for (gk in haloG) {
          gv = haloG[gk];
          c.globalAlpha = 0.13;
          c.fillStyle = gv.col;
          c.beginPath();
          for (gi = 0; gi < gv.v.length; gi += 3) {
            c.moveTo(gv.v[gi] + gv.v[gi + 2] + 2.8, gv.v[gi + 1]);
            c.arc(gv.v[gi], gv.v[gi + 1], gv.v[gi + 2] + 2.8, 0, 6.2832);
          }
          c.fill();
        }
        /* 空心圈 = 孤岛 */
        c.lineWidth = 1.15;
        for (gk in hollowG) {
          gv = hollowG[gk];
          c.globalAlpha = gv.a;
          c.strokeStyle = withAlpha(gv.col, 0.95);
          c.beginPath();
          for (gi = 0; gi < gv.v.length; gi += 2) {
            c.moveTo(gv.v[gi] + 2.8, gv.v[gi + 1]);
            c.arc(gv.v[gi], gv.v[gi + 1], 2.8, 0, 6.2832);
          }
          c.stroke();
        }
        /* 实心点 = 有连接 */
        for (gk in solidG) {
          gv = solidG[gk];
          c.globalAlpha = gv.a;
          c.fillStyle = gv.col;
          c.beginPath();
          for (gi = 0; gi < gv.v.length; gi += 3) {
            c.moveTo(gv.v[gi] + gv.v[gi + 2], gv.v[gi + 1]);
            c.arc(gv.v[gi], gv.v[gi + 1], gv.v[gi + 2], 0, 6.2832);
          }
          c.fill();
        }
        /* 特殊环：可清理(红) / 搜索命中(黄) / 脉冲(白) / 选中(白) —— 数量少，逐个画 */
        var ringSets = [
          { v: redList, col: '#e05a5a', a: 0.9, lw: 1.2 },
          { v: matchList, col: '#ffe27a', a: 1, lw: 1.3 }
        ];
        for (gi = 0; gi < ringSets.length; gi++) {
          var rs = ringSets[gi];
          if (!rs.v.length) continue;
          c.globalAlpha = rs.a;
          c.strokeStyle = rs.col;
          c.lineWidth = rs.lw;
          c.beginPath();
          for (var ri = 0; ri < rs.v.length; ri += 3) {
            c.moveTo(rs.v[ri] + rs.v[ri + 2], rs.v[ri + 1]);
            c.arc(rs.v[ri], rs.v[ri + 1], rs.v[ri + 2], 0, 6.2832);
          }
          c.stroke();
        }
        for (gi = 0; gi < pulseList.length; gi += 4) {
          c.globalAlpha = pulseList[gi + 3];
          c.strokeStyle = '#ffffff';
          c.lineWidth = 1.1;
          c.beginPath();
          c.arc(pulseList[gi], pulseList[gi + 1], pulseList[gi + 2], 0, 6.2832);
          c.stroke();
        }
        if (selRing) {
          c.globalAlpha = 1;
          c.strokeStyle = ui.dark ? '#ffffff' : '#1b2a4a';
          c.lineWidth = 1.6;
          c.beginPath();
          c.arc(selRing[0], selRing[1], selRing[2], 0, 6.2832);
          c.stroke();
        }
        c.globalAlpha = 1;
        c.restore();
      }

      /* 常驻动画循环（30fps；关掉动效降到 4fps 省电） */
      function startLoop() {
        if (loopRef.current) return;
        var last = 0;
        function step(ts) {
          loopRef.current = window.requestAnimationFrame(step);
          var gap = uiRef.current.animate ? 32 : 250;
          if (ts - last < gap) return;
          last = ts;
          // 渲染异常不许静默变成空白屏：出错就把错误画在画布上，自己先看得见
          try {
            renderFrame(ts / 1000);
          } catch (e) {
            var cvE = canvasRef.current;
            if (cvE) {
              var cE = cvE.getContext('2d');
              cE.setTransform(1, 0, 0, 1, 0, 0);
              cE.fillStyle = '#1a0b0b';
              cE.fillRect(0, 0, cvE.width, cvE.height);
              cE.fillStyle = '#ff7b7b';
              cE.font = '600 16px Consolas,monospace';
              cE.fillText('RENDER ERROR: ' + (e && e.message ? e.message : e), 24, 40);
              cE.fillText(String(e && e.stack ? e.stack.split('\n')[1] : ''), 24, 68);
            }
            if (!animRef.current.renderErrLogged) {
              animRef.current.renderErrLogged = 1;
              try { console.error('[starmap] render error', e); } catch (e2) {}
            }
          }
        }
        loopRef.current = window.requestAnimationFrame(step);
      }

      function scheduleDraw() {
        if (rafRef.current) return;
        rafRef.current = window.requestAnimationFrame(function () {
          rafRef.current = 0;
          draw();
        });
      }

      /* 点击扩散：从选中节点 BFS 算真实跳数，波沿真实边一圈圈扩散 */
      function startPulse(id) {
        var lay = layRef.current;
        if (!lay || !id) { animRef.current.pulse = null; return; }
        var hops = {};
        hops[id] = 0;
        var q = [id], head = 0;
        while (head < q.length && head < 900) {
          var cur = q[head++];
          var nb = lay.adj[cur];
          if (!nb) continue;
          for (var j = 0; j < nb.length; j++) {
            var w = nb[j];
            if (hops[w] == null) { hops[w] = hops[cur] + 1; q.push(w); }
          }
        }
        animRef.current.pulse = { id: id, hops: hops, t0: performance.now() / 1000 };
      }

      useEffect(function () {
        scheduleDraw();
      // 依赖里必须有 focus：focusSet 是在 draw() 里算出来的，
      // 少了它，点维护引导的行只会改 React 状态（行底色变），图上永远不亮。
      }, [status, filters, showAll, search, selected, stats, tick, animate, groupMode, clusterMode, clusterSel, focus, dark]);

      useEffect(function () {
        startPulse(selected ? selected.id : null);
      }, [selected]);


      useEffect(function () {
        var el = containerRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        var ro = new ResizeObserver(function () { scheduleDraw(); });
        ro.observe(el);
        return function () { ro.disconnect(); };
      }, []);

      // 滚轮必须用原生非 passive 监听，否则 preventDefault 不生效、整页会跟着滚
      useEffect(function () {
        var canvas = canvasRef.current;
        if (!canvas) return undefined;
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return function () { canvas.removeEventListener('wheel', onWheel); };
      }, []);

      useEffect(function () {
        return function () {
          if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
          if (loopRef.current) window.cancelAnimationFrame(loopRef.current);
          loopRef.current = 0;
        };
      }, []);

      /* ---- 坐标换算与命中 ---- */
      function toWorld(clientX, clientY) {
        var canvas = canvasRef.current;
        var lay = layRef.current;
        if (!canvas || !lay) return null;
        var rect = canvas.getBoundingClientRect();
        var mx = clientX - rect.left;
        var my = clientY - rect.top;
        var v = viewRef.current;
        return {
          mx: mx,
          my: my,
          x: (mx - lay.cx - v.panX) / v.zoom + lay.cx,
          y: (my - lay.cy - v.panY) / v.zoom + lay.cy,
          z: v.zoom,
        };
      }

      function hitTest(w) {
        var lay = layRef.current;
        if (!lay) return null;
        var best = null;
        var bestD = Infinity;
        for (var i = 0; i < lay.pts.length; i++) {
          var p = lay.pts[i];
          var dx = w.x - p.x;
          var dy = w.y - p.y;
          var d2 = dx * dx + dy * dy;
          var rr = Math.max(7, 2.4 + Math.log(1 + (p.n.degree || 0)) * 0.85 + 4);
          if (d2 <= rr * rr && d2 < bestD) {
            bestD = d2;
            best = p;
          }
        }
        return best;
      }

      /* 核层现在不画任何轮廓，所以不存在"点轮廓"这回事：
         点某个成员节点就是选中它本身（走正常的节点命中）。 */
      function hitCluster(w) {
        return null;
      }

      function showTip(p, clientX, clientY) {
        var tip = tooltipRef.current;
        var container = containerRef.current;
        if (!tip || !container) return;
        var nd = p.n;
        var lines = [];
        lines.push('[' + (TRACK_LABELS[nd.track] || nd.track) + '] 度 ' + (nd.degree || 0));
        lines.push('强度 ' + (nd.strength == null ? '-' : nd.strength.toFixed(2)) +
          '　清晰度 ' + (nd.clarityTarget || '-'));
        if (nd.date) lines.push(nd.date);
        if (nd.isOrphan) lines.push('孤岛：没有任何连接');
        var text = (nd.text || '').slice(0, 150);
        tip.textContent = '';
        var head = document.createElement('div');
        head.style.cssText = 'color:' + (TRACK_COLORS[nd.track] || '#9aa7bd') + ';font-weight:600;margin-bottom:3px';
        head.textContent = lines.shift();
        tip.appendChild(head);
        for (var i = 0; i < lines.length; i++) {
          var dv = document.createElement('div');
          dv.style.cssText = 'opacity:0.72;font-size:11px';
          dv.textContent = lines[i];
          tip.appendChild(dv);
        }
        var body = document.createElement('div');
        body.style.cssText = 'margin-top:5px;opacity:0.9;white-space:pre-wrap;word-break:break-word';
        body.textContent = text;
        tip.appendChild(body);

        var rect = container.getBoundingClientRect();
        var px = clientX - rect.left;
        var py = clientY - rect.top;
        tip.style.display = 'block';
        var tw = tip.offsetWidth;
        var th = tip.offsetHeight;
        var left = px + 14;
        var top = py + 14;
        if (left + tw > rect.width - 8) left = px - tw - 14;
        if (top + th > rect.height - 8) top = py - th - 14;
        if (left < 8) left = 8;
        if (top < 8) top = 8;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
      }

      function hideTip() {
        var tip = tooltipRef.current;
        if (tip) tip.style.display = 'none';
      }

      /* ---- 交互 ---- */
      function onMouseMove(e) {
        var drag = dragRef.current;
        if (drag && drag.mode === 'pan') {
          var v = viewRef.current;
          v.panX = drag.panX0 + (e.clientX - drag.x0);
          v.panY = drag.panY0 + (e.clientY - drag.y0);
          scheduleDraw();
          return;
        }
        var w = toWorld(e.clientX, e.clientY);
        if (!w) return;
        var p = hitTest(w);
        if (p) {
          showTip(p, e.clientX, e.clientY);
          var canvas = canvasRef.current;
          if (canvas) canvas.style.cursor = 'pointer';
        } else {
          hideTip();
          var canvas2 = canvasRef.current;
          if (canvas2) canvas2.style.cursor = drag ? 'grabbing' : 'grab';
        }
      }

      function onMouseDown(e) {
        if (e.button !== 0) return;
        var w = toWorld(e.clientX, e.clientY);
        if (!w) return;
        var p = hitTest(w);
        if (p) {
          dragRef.current = { mode: 'click', moved: false, x0: e.clientX, y0: e.clientY, pt: p };
        } else {
          var v = viewRef.current;
          dragRef.current = {
            mode: 'pan', x0: e.clientX, y0: e.clientY,
            panX0: v.panX, panY0: v.panY,
          };
          var canvas = canvasRef.current;
          if (canvas) canvas.style.cursor = 'grabbing';
        }
      }

      function onMouseUp(e) {
        var drag = dragRef.current;
        dragRef.current = null;
        var canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'grab';
        if (!drag) return;
        var moved = Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4;
        if (drag.mode === 'click') {
          if (!moved) setSelected(drag.pt.n);
          return;
        }
        // 空白处（拖拽模式下）单击：命中核层轮廓 = 选中该层（复用 focusSet 高亮成员），否则取消
        if (drag.mode === 'pan' && !moved) {
          var w = toWorld(e.clientX, e.clientY);
          var cl = w ? hitCluster(w) : null;
          if (cl) setFocus(null);
          setClusterSel(cl ? cl.id : null);
        }
      }

      function onMouseLeave() {
        dragRef.current = null;
        hideTip();
      }

      function onWheel(e) {
        if (e.preventDefault) e.preventDefault();
        var w = toWorld(e.clientX, e.clientY);
        if (!w) return;
        var lay = layRef.current;
        if (!lay) return;
        var v = viewRef.current;
        var factor = Math.exp(-e.deltaY * 0.0016);
        var next = Math.max(0.5, Math.min(6, v.zoom * factor));
        var k = next / v.zoom;
        // 以光标为锚点缩放
        v.panX = w.mx - lay.cx - (w.mx - lay.cx - v.panX) * k;
        v.panY = w.my - lay.cy - (w.my - lay.cy - v.panY) * k;
        v.zoom = next;
        scheduleDraw();
      }

      function resetView() {
        var v = viewRef.current;
        v.zoom = 1;
        v.panX = 0;
        v.panY = 0;
        scheduleDraw();
      }

      function toggleTrack(track) {
        setFilters(function (prev) {
          var next = Object.assign({}, prev);
          next[track] = prev[track] === false ? true : false;
          return next;
        });
      }

      /* ---- render UI ---- */
      var trackList = useMemo(function () {
        if (stats && stats.byTrack) {
          return TRACK_ORDER.filter(function (t) { return stats.byTrack[t] != null; });
        }
        return TRACK_ORDER;
      }, [stats]);

      var diag = useMemo(function () {
        var d = dataRef.current;
        if (!d || !d.nodes || !d.nodes.length) return null;
        var ns = d.nodes, i, n;
        var orphan = 0, never = 0, evict = 0, fail = 0;
        var byChars = {}, byCount = {}, oldest = 0, totChars = 0;
        for (i = 0; i < ns.length; i++) {
          n = ns[i];
          if (n.isOrphan) orphan++;
          if (!n.recallCount) never++;
          if (n.evictCandidate) evict++;
          if (n.track === 'failure') fail++;
          byCount[n.track] = (byCount[n.track] || 0) + 1;
          byChars[n.track] = (byChars[n.track] || 0) + ((n.text || '').length);
          if (n.ageDays != null && n.ageDays > oldest) oldest = n.ageDays;
        }
        for (var k in byChars) totChars += byChars[k];
        return {
          total: ns.length, orphan: orphan, never: never, evict: evict, fail: fail,
          keyCount: byCount.key || 0, byChars: byChars, byCount: byCount,
          totChars: totChars, oldest: oldest,
        };
      }, [status]);

      var chipNodes = trackList.map(function (t) {
        var off = filters[t] === false;
        return h(
          'button',
          {
            key: t,
            onClick: function () { toggleTrack(t); },
            title: TRACK_LABELS[t] + (stats && stats.byTrack ? ' · ' + (stats.byTrack[t] || 0) : ''),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '4px 9px',
              borderRadius: '999px',
              border: '1px solid ' + (off ? 'transparent' : withAlpha(TRACK_COLORS[t], 0.6)),
              background: off ? 'rgba(127,127,127,0.10)' : withAlpha(TRACK_COLORS[t], 0.16),
              color: off ? 'inherit' : TRACK_COLORS[t],
              opacity: off ? 0.55 : 1,
              fontSize: '12px',
              cursor: 'pointer',
              lineHeight: 1.2,
            },
          },
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: TRACK_COLORS[t], display: 'inline-block' } }),
          TRACK_LABELS[t],
          stats && stats.byTrack ? h('span', { style: { opacity: 0.7 } }, String(stats.byTrack[t] || 0)) : null,
        );
      });

      var topBar = h(
        'div',
        {
          style: {
            position: 'absolute',
            top: 10,
            left: 10,
            right: 10,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            alignItems: 'center',
            zIndex: 5,
          },
        },
        h('input', {
          value: search,
          onChange: function (e) { setSearch(e.target.value); },
          placeholder: '搜索记忆…',
          style: {
            width: '170px',
            padding: '5px 9px',
            borderRadius: '8px',
            border: '1px solid rgba(130,150,190,0.5)',
            background: 'rgba(20,28,48,0.55)',
            color: 'inherit',
            fontSize: '12px',
            outline: 'none',
          },
        }),
        chipNodes,
        h(
          'button',
          {
            onClick: function () { setShowAll(function (v) { return !v; }); },
            title: '是否显示孤岛（没有任何连接的记忆）',
            style: {
              padding: '4px 9px',
              borderRadius: '8px',
              border: '1px solid rgba(130,150,190,0.5)',
              background: showAll ? 'rgba(120,180,255,0.25)' : 'rgba(20,28,48,0.55)',
              color: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
            },
          },
          showAll ? '隐藏孤岛' : '显示全部',
        ),
        h(
          'button',
          {
            onClick: function () { setGroupMode(function (v) { return v === 'track' ? 'region' : 'track'; }); },
            title: '扇区分组方式：轨道 = 按记忆类别分扇区（默认）；隔离区 = 按记忆目录分扇区（每个工作区一块）。节点颜色始终按轨道，所以切到隔离区能一眼看出「这块区里都是什么类型的记忆」',
            style: {
              padding: '4px 9px',
              borderRadius: '8px',
              border: '1px solid rgba(130,150,190,0.5)',
              background: groupMode === 'region' ? 'rgba(120,180,255,0.25)' : 'rgba(20,28,48,0.55)',
              color: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
            },
          },
          groupMode === 'region' ? '分组 隔离区' : '分组 轨道',
        ),
        h(
          'button',
          {
            onClick: function () {
              setClusterMode(function (v) {
                // 只在真实存在的核层之间轮转（某门槛不够 5 条时后端不给这层），
                // 从大圈（k 小）转到大圈里更密的核（k 大），最后回「关」
                var avail = coreLevels();
                var order = (avail.length ? avail.slice() : [12, 8, 6, 3])
                  .sort(function (a, b) { return a - b; });
                var cur = v === 'off' ? -1 : parseInt(String(v).slice(1), 10);
                var pos = order.indexOf(cur);
                var next = pos + 1 >= order.length ? -1 : order[pos + 1];
                if (next < 0) setClusterSel(null);
                return next < 0 ? 'off' : ('k' + next);
              });
            },
            title: (function () {
              var ring = coreRingText();
              return '核层 = k-core 分层：一个门槛一层，成员 = 所有 core>=k 的记忆'
                + (ring ? '（' + ring + '）' : '')
                + '。选中一层后只显示该层成员之间真实存在的连线（画成一张网），不做任何圈选——因为节点的位置由可达性与轨道决定，与它属于哪个密度核无关，画圆必然是假象';
            })(),
            style: {
              padding: '4px 9px',
              borderRadius: '8px',
              border: '1px solid rgba(130,150,190,0.5)',
              background: clusterMode === 'off' ? 'rgba(20,28,48,0.55)' : 'rgba(120,180,255,0.25)',
              color: 'inherit',
              fontSize: '12px',
              opacity: coreMissing ? 0.55 : 1,   // 该门槛这层不存在：置灰（点了也照样安全）
              cursor: 'pointer',
            },
          },
          clusterMode === 'off' ? '核层 关' : ('核层 k\u2265' + coreModeK + (coreMissing ? '（无此层）' : '')),
        ),
        h(
          'button',
          {
            onClick: resetView,
            title: '把缩放和平移复位',
            style: {
              padding: '4px 9px',
              borderRadius: '8px',
              border: '1px solid rgba(130,150,190,0.5)',
              background: 'rgba(20,28,48,0.55)',
              color: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
            },
          },
          '重置视图',
        ),
        h(
          'button',
          {
            onClick: function () {
              setEdgeMode(function (v) {
                return v === 'off' ? 'strong' : (v === 'strong' ? 'all' : 'off');
              });
            },
            title: '全部连线都画，但按 score 分四档：>=16 强（亮+粗+光晕）／11-15 中／8-10 弱／<8 极淡底纹。点一次切「强」（只留中档以上），再点关掉',
            style: {
              padding: '4px 9px',
              borderRadius: '8px',
              border: '1px solid rgba(130,150,190,0.5)',
              background: edgeMode === 'off' ? 'rgba(20,28,48,0.55)' : 'rgba(120,180,255,0.25)',
              color: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
            },
          },
          edgeMode === 'off' ? '连线 关' : (edgeMode === 'strong' ? '连线 强' : '连线 全'),
        ),
        h(
          'button',
          {
            onClick: function () { setAnimate(function (v) { return !v; }); },
            title: '有连接的节点会轻微呼吸、孤岛静止；关掉可省 CPU',
            style: {
              padding: '4px 9px',
              borderRadius: '8px',
              border: '1px solid rgba(130,150,190,0.5)',
              background: animate ? 'rgba(120,180,255,0.25)' : 'rgba(20,28,48,0.55)',
              color: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
            },
          },
          animate ? '动效 开' : '动效 关',
        ),
        h(
          'button',
          {
            onClick: function () { setShowGuide(function (v) { return !v; }); },
            title: '按图上的真实数据算出该做什么维护',
            style: {
              padding: '4px 9px',
              borderRadius: '8px',
              border: '1px solid rgba(130,150,190,0.5)',
              background: showGuide ? 'rgba(120,180,255,0.25)' : 'rgba(20,28,48,0.55)',
              color: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
            },
          },
          showGuide ? '收起引导' : '维护引导',
        ),
      );

      var statusBadge = null;
      if (status === 'warming') {
        statusBadge = h(
          'div',
          { style: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', zIndex: 6, pointerEvents: 'none' } },
          h('div', { style: { fontSize: '14px', opacity: 0.85 } }, '正在编织记忆星系…'),
          h('div', { style: { fontSize: '12px', opacity: 0.55, marginTop: 6 } }, '首次约需数秒（后台计算，不阻塞）'),
        );
      } else if (status === 'error') {
        statusBadge = h(
          'div',
          { style: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', zIndex: 6, opacity: 0.85 } },
          h('div', { style: { fontSize: '14px' } }, '无法加载记忆图数据'),
          h('div', { style: { fontSize: '12px', opacity: 0.6, marginTop: 6 } }, errMsg),
        );
      }

      /* ---- 维护操作：两段式确认（第一下只预览，第二下才写盘）---- */
      function runAct(op, node) {
        if (!node || !node.fp) return;
        var confirmed = !!(actPend && actPend.op === op && actPend.fp === node.fp);
        setActMsg('处理中…');
        fetch('/x-memory-starmap/act', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: op, fp: node.fp, confirmed: confirmed }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.ok) {
              setActPend(null);
              setActMsg('失败：' + ((j && j.error) || '未知错误'));
              return;
            }
            if (j.preview) {
              setActPend({ op: op, fp: node.fp });
              setActMsg(
                '预览（还没写任何东西）\n文件：' + j.file +
                '\n轨道：' + j.track + '　' + (j.chars || 0) + ' 字符' +
                '\n' + (op === 'archive' ? '将移入：' + j.archiveTo : '将从原文件永久删除') +
                '\n\n再点一次「' + (op === 'archive' ? '归档' : '删除') + '」才真正执行。'
              );
            } else {
              setActPend(null);
              setActMsg(
                '已执行 ✓\n' + j.file + '：' + j.entriesBefore + ' → ' + j.entriesAfter + ' 条' +
                (j.archivedTo ? '\n已移入：' + j.archivedTo : '') +
                '\n备份：' + j.backup
              );
              load(true);
              setSelected(null);
            }
          })
          .catch(function (e) { setActPend(null); setActMsg('失败：' + e); });
      }

      /* 批量：作用于当前高亮的那一类（先点上方任一条筛出来） */
      function currentFocusFps() {
        var fset = layRef.current && layRef.current.focusSet;
        var nodes = (dataRef.current && dataRef.current.nodes) || [];
        if (!fset) return [];
        var out = [];
        for (var k in fset) {
          var nd = nodes[k];
          if (nd && nd.fp) out.push(nd.fp);
        }
        return out;
      }

      // 哪些筛选允许「一键批量归档」。
      //
      // 收得很死，只有一个：evict（可清理候选）= 孤岛 + 零检索 + 超 7 天 三重交集。
      // 这是系统唯一敢说"明确无用"的一类。其余全部不开放，原因不是保守，是数量级：
      //   · 孤岛 630 条 = 42% 的库，里面绝大多数是有用记忆，只是还没被交叉引用连上；
      //   · 从没被检索过 = 检索词写得太模糊，问题在关键词而不在记忆本身；
      //   · key 轨容量 = 那是全库最硬的事实，满了要挑着删，不能按类别一刀切；
      //   · 失败账本 = 最该复用的东西，删了等于把踩过的坑重踩一遍。
      // 这些类别仍然可以逐条归档（点节点 → 详情里的「归档」），只是不给一键按钮。
      var BULK_FOCUS = 'evict';

      function runBatch(op) {
        // 双保险：按钮本身只在 evict 行渲染，这里再拦一次，
        // 防止将来有人把按钮挪到别处、或者别的代码路径直接调 runBatch。
        if (focus !== BULK_FOCUS) {
          setBatchMsg('只有「可清理候选」能批量处理（它是孤岛+零检索+超7天的交集，系统唯一敢判定为无用的一类）。\n其他类别请逐条处理：点节点 → 详情里用「归档」。');
          return;
        }
        var fps = currentFocusFps();
        if (!fps.length) {
          setBatchMsg('先点上面任一条（如「孤岛」）把范围筛出来，再来批量。');
          return;
        }
        var key = String(focus) + '|' + fps.length;
        var confirmed = !!(batchPend && batchPend.op === op && batchPend.key === key);
        setBatchMsg('处理中…（' + fps.length + ' 条）');
        fetch('/x-memory-starmap/act', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: op, fps: fps, confirmed: confirmed, allowBulk: true }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.ok) {
              setBatchPend(null);
              setBatchMsg('失败：' + ((j && j.error) || '未知错误'));
              return;
            }
            if (j.preview) {
              setBatchPend({ op: op, key: key });
              var bt = [];
              for (var t in (j.byTrack || {})) bt.push(t + ' ' + j.byTrack[t]);
              setBatchMsg(
                '预览（还没写任何东西）\n将处理 ' + j.count + ' 条：' + bt.join(' / ') +
                (j.missing ? '\n跳过：' + j.missing + ' 条找不到' : '') +
                (j.ambiguous ? '\n拒绝：' + j.ambiguous + ' 条指纹重复（无法唯一定位）' : '') +
                '\n\n再点一次同一个按钮才真正执行。'
              );
            } else {
              setBatchPend(null);
              setBatchMsg('已执行 ✓ 处理 ' + j.removed + ' 条，涉及 ' + j.files + ' 个文件\n备份：' + j.backupDir);
              load(true);
              setFocus(null);
            }
          })
          .catch(function (e) { setBatchPend(null); setBatchMsg('失败：' + e); });
      }

      function actBtn(label, color, op, node) {
        var on = actPend && actPend.op === op && actPend.fp === node.fp;
        return h('button', {
          onClick: function () { runAct(op, node); },
          style: {
            padding: '5px 12px',
            borderRadius: '7px',
            fontSize: '12px',
            cursor: 'pointer',
            color: color,
            background: on ? withAlpha(color, 0.30) : withAlpha(color, 0.12),
            border: '1px solid ' + withAlpha(color, on ? 0.95 : 0.5),
          },
        }, on ? label + ' ✓? 再点确认' : label);
      }

      var actBlock = selected ? h(
        'div',
        { style: { marginTop: '16px', borderTop: '1px solid rgba(130,150,190,0.28)', paddingTop: '12px' } },
        h('div', { style: { fontSize: '11px', opacity: 0.6, marginBottom: '7px' } }, '维护操作'),
        selected.fp
          ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              actBtn('归档', '#7fb0d8', 'archive', selected),
              actBtn('删除', '#e05a5a', 'delete', selected),
            )
          : h('div', { style: { fontSize: '11.5px', opacity: 0.6 } }, '这条没有稳定标识（图是旧版），刷新后可用'),
        actMsg ? h('div', {
          style: {
            marginTop: '9px', fontSize: '11px', lineHeight: 1.55,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'rgba(0,0,0,0.28)', borderRadius: '7px', padding: '7px 9px',
            color: 'rgba(210,222,244,0.9)',
          },
        }, actMsg) : null,
        h('div', { style: { marginTop: '7px', fontSize: '10.5px', opacity: 0.45, lineHeight: 1.5 } },
          '归档 = 移进 *-archive.md，不再进图也不再被注入；删除 = 从原文件移除。两者写盘前都会先备份原文件。'),
      ) : null;

      var detail = null;
      if (selected) {
        var strong = selected.strong && selected.strong.length
          ? h('div', { style: { marginTop: 10 } },
              h('div', { style: { fontSize: '11px', opacity: 0.6, marginBottom: 4 } }, '关联标识'),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } },
                selected.strong.map(function (t, k) {
                  return h('span', {
                    key: k,
                    style: {
                      fontSize: '11px',
                      padding: '2px 7px',
                      borderRadius: '6px',
                      background: withAlpha(TRACK_COLORS[selected.track] || '#88a', 0.16),
                      color: TRACK_COLORS[selected.track] || '#88a',
                    },
                  }, t);
                })))
          : null;
        var metaRows = [
          ['连接度', String(selected.degree || 0)],
          ['强度', selected.strength == null ? '-' : selected.strength.toFixed(3)],
          ['清晰度', selected.clarityTarget || '-'],
          ['检索次数', String(selected.recallCount || 0)],
          ['年龄', selected.ageDays == null ? '未知' : selected.ageDays + ' 天'],
        ];
        detail = h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: '320px',
              maxWidth: '80%',
              background: 'linear-gradient(180deg, rgba(16,22,40,0.96), rgba(10,14,26,0.98))',
              color: 'rgba(235,240,255,0.95)',
              borderLeft: '1px solid rgba(130,150,190,0.35)',
              padding: '16px',
              overflowY: 'auto',
              zIndex: 8,
              boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', {
              style: {
                fontSize: '12px',
                padding: '3px 9px',
                borderRadius: '999px',
                background: withAlpha(TRACK_COLORS[selected.track] || '#88a', 0.2),
                color: TRACK_COLORS[selected.track] || '#88a',
              },
            }, TRACK_LABELS[selected.track] || selected.track),
            h('button', {
              onClick: function () { setSelected(null); },
              style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '16px', opacity: 0.7 },
            }, '×'),
          ),
          h('div', { style: { fontSize: '12px', opacity: 0.6, marginTop: 8 } }, selected.date || '无日期'),
          h('div', { style: { fontSize: '12px', opacity: 0.75, marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px' } },
            metaRows.map(function (r, k) {
              return h('div', { key: k }, h('span', { style: { opacity: 0.55 } }, r[0] + '：'), r[1]);
            })),
          h('div', { style: { fontSize: '13px', lineHeight: 1.6, marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, selected.text),
          strong,
          actBlock,
        );
      }

      var guide = null;
      if (showGuide && diag) {
        var pctOf = function (v) { return Math.round((v * 100) / (diag.total || 1)); };
        var rows = [
          {
            lv: '#e0a0a0', title: 'key 轨容量', focus: 'key',
            val: diag.keyCount + ' 条 · ' + (diag.byChars.key || 0).toLocaleString() + ' 字符',
            act: 'key 轨有硬上限，满了新记忆会被挤掉；先归档过时条目',
          },
          {
            lv: '#e8c478', title: '孤岛 · 没有任何连接', focus: 'orphan',
            val: diag.orphan + ' 条 · 占 ' + pctOf(diag.orphan) + '%',
            act: '补交叉引用把它连上；真要清就逐条来（孤岛占全库四成，里面大多是还活着、只是没人引用过的记忆，不许批量）',
          },
          {
            lv: '#e8c478', title: '从没被检索过', focus: 'never',
            val: diag.never + ' 条 · 占 ' + pctOf(diag.never) + '%',
            act: '写了没用到 = 效率问题，检查关键词是否太模糊',
          },
          {
            lv: '#e05a5a', title: '可清理候选', focus: 'evict',
            val: diag.evict + ' 条',
            act: '孤岛+零检索+超7天三类交集；判定极严，数量少说明系统几乎不自动判可清理',
            // 全面板唯一允许一键批量归档的类别：三重交集 = 明确无用
            bulk: true,
          },
          {
            lv: '#7fb0d8', title: '失败账本 · 最该复用', focus: 'failure',
            val: diag.fail + ' 条',
            act: '动手前先搜这里，同一个坑别踩第二次',
          },
        ];
        var patrol = (dataRef.current && dataRef.current.patrol) || null;
        var patrolLine = patrol
          ? h('div', {
              style: {
                marginTop: '6px', paddingTop: '6px',
                borderTop: '1px dashed rgba(130,150,190,0.25)',
                fontSize: '10.5px', lineHeight: 1.55, opacity: 0.75,
              },
            },
              '巡检 ' + (patrol.hoursAgo == null ? '时间未知' : patrol.hoursAgo + ' 小时前') +
              (patrol.mode ? ' · ' + patrol.mode : '') +
              ' · 重复组 ' + patrol.duplicateGroups + ' · 冲突 ' + patrol.conflicts,
              patrol.worstPct == null ? null : h('div', { style: { marginTop: '2px' } },
                '最紧的轨：' + (TRACK_LABELS[patrol.worstTrack] || patrol.worstTrack) +
                ' ' + patrol.worstPct + '%（' + patrol.worstChars + '/' + patrol.worstBudget + '）'),
            )
          : h('div', { style: { marginTop: '6px', fontSize: '10.5px', opacity: 0.5 } },
              '巡检：暂无报告（跑 scripts/memory-patrol.mjs 生成）');

        var batchBlock = focus ? h('div', { style: { marginTop: '8px' } },
          batchMsg ? h('div', {
            style: {
              marginTop: '6px', fontSize: '10.5px', lineHeight: 1.5,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: 'rgba(0,0,0,0.28)', borderRadius: '6px', padding: '6px 8px',
              color: 'rgba(210,222,244,0.9)',
            },
          }, batchMsg) : null,
        ) : null;

        guide = h(
          'div',
          {
            style: {
              position: 'absolute',
              right: '12px',
              bottom: '12px',
              width: '336px',
              maxWidth: '46%',
              zIndex: 5,
              background: 'rgba(12,16,28,0.93)',
              border: '1px solid rgba(120,140,180,0.35)',
              borderRadius: '10px',
              padding: '10px 11px',
              color: 'rgba(214,224,244,0.92)',
              fontSize: '11.5px',
              lineHeight: 1.5,
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
            },
          },
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: '6px',
            },
          },
            h('span', { style: { fontWeight: 600, fontSize: '12px', color: 'rgba(232,240,255,0.98)' } }, '维护引导'),
            (focus || clusterSel != null) ? h('button', {
              onClick: function () { setFocus(null); setClusterSel(null); },
              style: {
                background: 'rgba(120,180,255,0.22)', border: '1px solid rgba(120,180,255,0.5)',
                color: 'inherit', borderRadius: '6px', fontSize: '11px',
                padding: '1px 7px', cursor: 'pointer',
              },
            }, '清除高亮') : h('span', { style: { opacity: 0.45, fontSize: '10.5px' } }, '点一条 → 图上只亮那一类'),
          ),
          rows.map(function (r) {
            var on = focus === r.focus;
            return h('div', {
              key: r.focus,
              onClick: function () {
                // 核层高亮与维护引导高亮共用 focusSet：点引导就退出核层选中，避免两套焦点打架
                setClusterSel(null);
                setFocus(function (v) { return v === r.focus ? null : r.focus; });
              },
              style: {
                display: 'flex', gap: '8px', alignItems: 'flex-start',
                padding: '5px 7px', borderRadius: '7px', cursor: 'pointer',
                background: on ? 'rgba(120,180,255,0.18)' : 'transparent',
                border: '1px solid ' + (on ? 'rgba(120,180,255,0.55)' : 'transparent'),
                marginBottom: '1px',
              },
            },
              h('span', {
                style: {
                  width: '6px', height: '6px', borderRadius: '50%', background: r.lv,
                  marginTop: '6px', flex: '0 0 6px',
                },
              }),
              h('div', { style: { flex: 1 } },
                h('div', { style: { fontWeight: 600 } }, r.title),
                h('div', { style: { opacity: 0.85 } }, r.val),
                h('div', { style: { opacity: 0.6, marginTop: '1px' } }, r.act),
              ),
              // 归档按钮只在「可清理候选」这一行出现（r.bulk）。
              // 其余行不给批量入口：它们起步就是几十上百条（孤岛 42%），一键下去不可逆。
              // 依旧 stopPropagation，防止冒泡回行本身把 focus 切掉
              on && r.bulk ? h('button', {
                onClick: function (ev) {
                  if (ev && ev.stopPropagation) ev.stopPropagation();
                  if (ev && ev.preventDefault) ev.preventDefault();
                  runBatch('archive');
                },
                style: {
                  flex: '0 0 auto', marginTop: '1px',
                  padding: '3px 8px', borderRadius: '6px', fontSize: '10.5px',
                  cursor: 'pointer', color: '#8fc4ea',
                  background: 'rgba(127,176,216,0.18)',
                  border: '1px solid rgba(127,176,216,0.6)',
                },
              }, (batchPend && batchPend.op === 'archive' ? '确认 ✓?' : '归档')) : null,
            );
          }),
          h('div', {
            style: { marginTop: '6px', fontSize: '10px', opacity: 0.55, lineHeight: 1.5 },
          }, '批量归档只对「可清理候选」开放（孤岛+零检索+超7天）。其余类别逐条处理：点节点 → 详情里「归档」。'),
          h('div', {
            style: { opacity: 0.4, marginTop: '6px', fontSize: '10.5px', borderTop: '1px solid rgba(120,140,180,0.2)', paddingTop: '5px' },
          }, '全库 ' + diag.total + ' 条 · ' + diag.totChars.toLocaleString() + ' 字符 · 最老 ' + diag.oldest + ' 天'),
        patrolLine,
        batchBlock,
        );
      }

      return h(
        'div',
        {
          ref: containerRef,
          style: { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: dark ? '#0b0b0d' : '#f7f9fc' },
        },
        h('canvas', {
          ref: canvasRef,
          onMouseMove: onMouseMove,
          onMouseDown: onMouseDown,
          onMouseUp: onMouseUp,
          onMouseLeave: onMouseLeave,
          style: { display: 'block', width: '100%', height: '100%', cursor: 'grab' },
        }),
        h('div', {
          style: {
            position: 'absolute',
            left: '14px',
            bottom: '14px',
            zIndex: 4,
            fontSize: '11px',
            lineHeight: '1.65',
            color: 'rgba(168,178,198,0.82)',
            textShadow: '0 1px 3px rgba(0,0,0,0.85)',
            pointerEvents: 'none',
            userSelect: 'none',
          },
        },
          (function () {
            var d = dataRef.current;
            var cnt = { hub: 0, linked: 0, loose: 0, orphan: 0 };
            var total = 0, evict = 0, vivid = 0, maxDeg = 0, edges = 0;
            // 图例里的真实数字：项目区个数（region key 以 p: 开头）/ 核层各档条数
            var regionN = 0;
            if (d && d.regions) {
              for (var rq = 0; rq < d.regions.length; rq++) {
                var rk = d.regions[rq].key || '';
                if (rk.indexOf('p:') === 0) regionN++;
              }
            }
            // 核层条数一律从 cores 读，不写死；不存在的层直接不念
            var ringTxt = coreRingText();
            if (d && d.nodes) {
              edges = d.links ? d.links.length : 0;
              for (var k = 0; k < d.nodes.length; k++) {
                var nn = d.nodes[k];
                total++;
                if (cnt[nn.status] != null) cnt[nn.status]++;
                if (nn.evictCandidate) evict++;
                if (nn.clarityTarget === 'vivid') vivid++;
                if (nn.degree > maxDeg) maxDeg = nn.degree;
              }
            }
            return h('div', null,
              h('div', { style: { fontWeight: 600, color: 'rgba(214,224,244,0.95)', marginBottom: '2px' } },
                '记忆真实状态 \u00b7 共 ' + total + ' 条 \u00b7 ' + edges + ' 条连接'),
              h('div', null, '\u25cf 实心点 = 有连接 ' + (total - cnt.orphan) + '\u3000\u25cb 空心圈 = 孤岛 ' + cnt.orphan + (cnt.evict ? '\u3000\u25cb 红圈 = 可清理 ' + cnt.evict : '')),
              h('div', null, '结构：枢纽 ' + cnt.hub + '\uff08\u22658条\uff09\u00b7 中等 ' + cnt.linked + ' \u00b7 稀疏 ' + cnt.loose + ' \u00b7 最大度 ' + maxDeg),
              h('div', null, '半径 = 可达性排名百分位\uff08圆心 = 最容易被想起的那批\uff0c外缘 = 最想不起来的\uff09\uff1b每圈 = 排名 20%'),
              h('div', null, '角度 = ' + (groupMode === 'region' ? '隔离区扇区\uff08宽度按该区条数\uff09' : '轨道扇区\uff08宽度按条数\uff09') + '\uff1b线宽/线亮 = 真实相似度分数'),
              h('div', { style: { color: 'rgba(160,200,255,0.95)' } },
                '隔离区 = ' + regionN + ' 个项目区 + 全局轨\uff1bdaily 为跨项目混装区\uff0c不对应单一项目'),
              (stats && typeof stats.largestComponent === 'number' && typeof stats.components === 'number'
                && typeof stats.maxCore === 'number')
                ? h('div', null,
                  '连通: 最大块 ' + stats.largestComponent + ' 条 (占 '
                  + (stats.largestPct * 100).toFixed(1) + '%) · 全图 ' + stats.components
                  + ' 个分量 · 最高 k-core = ' + stats.maxCore
                  + ' \u2014\u2014 连通\u2260聚合\uff0c聚合看 k-core')
                : null,
              ringTxt ? h('div', { style: { opacity: 0.8 } },
                '核层: ' + ringTxt
                + ' \u2014\u2014 门槛越低、纳入的节点越多\uff1b'
                + '顶部「核层」开关一次只画一层\uff0c选中后只显示该层成员之间真实存在的连线（一张网\uff09') : null,
              h('div', { style: { color: 'rgba(232,196,120,0.95)' } },
                '\u26a0 遗忘曲线已接入但尚未生效：' + vivid + '/' + total + ' 仍是 vivid'),
              evict > 0 ? h('div', { style: { color: 'rgba(232,132,132,0.95)' } }, '\u25cb 红圈 = 可清理 ' + evict + ' 条（孤岛 \u00b7 从没被检索 \u00b7 超过7天）') : null,
              h('div', { style: { opacity: 0.55 } }, '红点 = 踩坑账本 \u00b7 空心圈 = 孤岛 \u00b7 滚轮缩放 \u00b7 拖空白平移 \u00b7 点节点看它连了谁 \u00b7 连线四档：亮粗=强(score>=16) 中=可见 淡=弱 极淡=底纹 \u00b7 顶部「连线」可切 全/强/关'),
            );
          })(),
        ),
        h('div', {
          ref: tooltipRef,
          style: {
            position: 'absolute',
            display: 'none',
            maxWidth: '280px',
            padding: '6px 9px',
            background: 'rgba(10,14,26,0.94)',
            color: 'rgba(235,240,255,0.95)',
            border: '1px solid rgba(130,150,190,0.4)',
            borderRadius: '8px',
            fontSize: '12px',
            lineHeight: 1.4,
            pointerEvents: 'none',
            zIndex: 9,
          },
        }),
        topBar,
        statusBadge,
        guide,
        detail,
      );
    }

    /* ------------------------------------------------------------- plugin */

    function apply(ctx) {
      var theme = null;
      try { theme = ctx.theme; } catch (e) { theme = null; }

      function PanelComp() {
        return h(GraphPanel, { theme: theme });
      }

      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: ID }, PanelComp);
        });
      });

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: ID, order: 43, label: function () { return '记忆星图'; } },
            function SidebarIcon(pr) { return h(StarIcon, pr); },
          );
        });
      });
    }

    return {
      name: ID,
      inject: ['slots'],
      apply: apply,
    };
  },
});
