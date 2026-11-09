# dsh-memory-starmap

> Renders the machine's memory tracks as an interactive force-directed galaxy in the DeepSeek Harness left sidebar.

## 这是什么

记忆库里躺着几百上千条条目，但只有两种看它的方式：按文件翻（`MEMORY.md` 一天一截），
或者凭关键词搜（`memory_search`）。这两种方式都回答不了「我的记忆长什么样」——
哪一片很密、哪些条目孤零零挂着、哪个项目几乎是空的、哪条从来没被检索过。

记忆星图把这件事变成一张图：**每条记忆是一个点，共享"有辨识度的词"的两条之间连一条边**，
用 2D Canvas 力导向布局摊开，挂在左侧栏（`sidebar.panellist`，也可单独开一个主面板）。
点可以拖、可以缩、可以按轨/项目筛选、可以搜；点开一条能看到正文摘录、重要度、清晰度、
被召回次数，以及"它和谁连着、为什么连着"。

它同时还是一张**体检表**：孤岛（没有任何连接的条目）、从未被检索过的条目、按清晰度衰减到
`trace` 的条目，都在同一张图上直接看得见。维护动作（归档 / 删除）也从这里发起，
但默认**只预览不写盘**（见「对外能力」）。

不是装饰：图上的每一层信息都来自磁盘上的真实文件（`memories/` 下的九个源 + 侧车
`entry-meta.json` / `recall-stats.json`），没有一项是编的。

## 前置条件

**诚实说明**：这是 DeepSeek Harness Desktop 的插件（宿主 + 客户端两半），不是独立 npm 库。
它需要：

- 宿主侧：cordis 运行时的 `ctx`，并且 `webServer` 服务可用（图数据与维护动作都走 HTTP）；
- 客户端侧：`@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-ui-layout`
  （左栏面板与主面板的插槽），见 `dsh.client.inject`；
- 记忆库目录存在：`<dsh-home>/memories/`（`DSH_HOME` 缺省 `~/.dsh-beta`）。
  目录不存在时不会崩，只会得到一张空图。

可选依赖（**有就用、没有就降级**，不是硬依赖）：`dsh-memory-evolve` 的
`lib/entry-meta.js#entryFingerprint` 与 `lib/decay.js#targetClarity`。装上时用它的算法算指纹与清晰度，
没装时用本插件内的复刻实现——两者对**带 `[标签]` 头部**的条目结果不同，见「已知限制」。

## 安装

```powershell
$dsh   = "$env:USERPROFILE\.dsh-beta"                    # <dsh-home>
$repo  = "D:\path\to\dsh-memory-starmap"                 # 本仓库
$prof  = "$dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$prof\node_modules\dsh-memory-starmap" -Target $repo
```

在 `<dsh-home>\profiles\desktop\cordis.patch.yml` 里加一条：

```yaml
- insert:
    - id: memory-starmap
      name: dsh-memory-starmap
```

**必须整 App 重启**：客户端 bundle 是启动时拍的快照，改的是 `client.js` 就必须重启；
只换宿主侧可以用刷新按钮，但左栏面板不会跟着重建。
不要用 `pnpm add` / `pnpm install` 装本地插件：它会重解析依赖树并顶掉钉死的核心包版本。

## 配置

**无配置项。** 所有行为由环境变量与运行期常量决定。

| 项 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh-beta` | 记忆库根，缺省回退到用户目录下的同名目录 |
| `DSH_STARMAP_PATROL_DIR` | `<cwd>/docs` | 巡检报告目录；目录不存在就没有水位数据 |
| 缓存文件 | `%TEMP%/memory-starmap-cache.json` | 图数据落盘缓存，TTL 30 分钟 |
| 时间窗 | 90 天 | 建边时只比较日期相差 90 天以内的两条 |
| 批量闸门 | 5 条 | 超过这个条数的批量写操作必须显式 `allowBulk:true` |

## 对外能力

### HTTP（前缀 `/x-memory-starmap`）

| 端点 | 方法 | 行为 |
|---|---|---|
| `/graph.json` | GET | 返回 `{status:"ready", generatedAt, stats, nodes, links}`；后台正在建图时返回 `{status:"warming"}`。`?refresh=1` 触发后台重建（不阻塞请求，仍先发旧缓存） |
| `/act` | POST | 维护动作。body 形如 `{op:"archive" 或 "delete", fp, confirmed?, allowBulk?}`（单条）或 `{op, fps:[...], confirmed, allowBulk}`（批量）。**`confirmed` 不为 `true` 时只预览、一个字节都不写**；返回里带 `preview:true` 与实际会动的文件 |

写盘三件事必做：先建备份目录把原文件复制一份（返回里的 `backup` 就是路径）、受保护条目拒绝、
批量超过 5 条要 `allowBulk`。归档目标是 `<memories>/_archive/ARCHIVED-daily.md`（daily 轨）
或同名 `_archive` 区（其它轨）。

### 界面

- 左栏图标面板：`slots.register({ name:'sidebar.panellist', id:'memory-starmap', order:43 })`；
- 主面板：`slots.register({ name:'main', key:'memory-starmap' })`；
- 面板内提供拖拽 / 缩放 / 按轨与项目筛选 / 关键词搜索 / 点开详情 / 维护按钮。

### 模型可调工具

**无。** 这个插件不注册任何 `tools`，模型看不到它——它是给人看的界面。
唯一的模型侧影响是它会写 `memories/` 下的文件，之后由记忆插件照常读取。

## 值得一看的实现

- **O(n²) 建边不在请求里跑。** 相似度连线是两两比较，条目上千时是百万级运算。
  实现把建图切成块，用 `setImmediate` 让出事件循环，结果写进 `%TEMP%` 缓存（TTL 30 分钟）；
  请求期间永远先发旧缓存，重建在后台完成——宿主的事件循环不会被这张图噎住。
- **指纹要与写入端同源。** 侧车里记的是 `entryFingerprint`，星图要在几百条里认出"同一条"，
  就必须用同一个函数；两套算法对带 `[标签]` 头部的条目结果不同，会让**守卫静默失效**
  （一条"不可归档"的条目能被归档掉）。所以解析 `dsh-memory-evolve` 的真实位置来 import 它，
  而不是"抄一份差不多"。
- **保护判定有两个来源**：侧车 `entry-meta.json` 里的 `protected:true`，以及正文里的 `【保留】` 标记。
  两处都是"说了不许动就不许动"。

## 已知限制

- **归档不是减压。** 归档 = 移进 `_archive/`，召回按日期拼路径读 `daily/YYYY-MM-DD.md`，
  于是被归档的条目对检索**不可见**（不是"更少被检索"，是搜不到）。
  把归档/清理当维护手段时，要想清楚这是"从模型眼前撤走"而不是"腾地方"。
- **批量写只对「可清理候选」开放**（孤岛 + 零检索 + 超过 7 天三个条件的交集）。
  别的类别——孤岛 41%、从没被检索、key 轨容量、失败账本——一律逐条人工确认。
  闸门在 `allowBulk:true` 上：界面只给候选那一行带这个旗标，脚本要一次动几十条得自己写出来。
- **可选依赖缺失时守卫会变弱。** 找不到 `dsh-memory-evolve` 的 `entryFingerprint` 时用本地复刻，
  而复刻会剥掉头部任意 `[标签]`，原生实现不会——于是带 `[git master]` 这类头条目的指纹两边对不上，
  侧车的 `protected` 位会被**静默漏判**。装记忆插件是推荐配置，不是可选项。
- **图只建在 90 天时间窗内比较日期**，超出窗口的两条不连边（避免"同一个月"这种弱证据）。
  视窗外的老条目仍然是点，只是边更少。
- **下划线 / 点开头的目录不进图**（`daily/_archive` 这类归档区、隐藏区），
  所以归档后条目会从图上消失——这是有意的，但不是"删了"。
- **`process.cwd()` 在 DSH Desktop 里是 `C:\Windows\System32`。**
  巡检报告目录用 `DSH_STARMAP_PATROL_DIR` 显式指定，别指望 cwd 指向工作区。
- **写盘前先备份，但备份不是版本管理**：同一条目反复归档会在备份目录里堆若干份，
  系统不会自动清理；要找旧版本请自己看 `backup` 返回的路径。

## 开发

```bash
node --check index.js && node --check client.js   # 本插件没有测试套件，这是唯一自检
```

目录结构：

```
index.js       宿主侧：读 memories/ → 建图（分块 + 后台）→ HTTP 路由 → 维护动作
client.js      客户端侧：Canvas 力导向布局、拖拽缩放、筛选搜索、详情面板、维护按钮
locale/*.json  面板标题与描述（zh / en）
icon.svg       左栏图标
```

调试：起 DSH 后打开左栏「记忆星图」，或在 DevTools 的 Network 里看图数据请求。
端口不要写死（DSH 的 webserver 是 `port: 0`，每次启动随机），页面侧只用同源路径。

## 许可

MIT，见 `LICENSE`。
