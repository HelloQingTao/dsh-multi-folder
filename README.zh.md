# dsh-multi-folder

[English](README.md) | **中文**

> 给一个 DSH 项目配置若干**副工作目录**：Agent 的主工作目录不变，但对这些目录拥有同等读写与命令执行权限，还能在输入框用 `@` 直接引用里面的文件。

## 效果

| 场景 | 表现 |
| --- | --- |
| 输入框左下角 **「+」** | 「指令」分组里出现 **「多工作目录」**（草稿是否为空都在）；点击打开**宿主自带选择弹层**（与「模型」选择器同一套 UI） |
| 弹层：添加 | 首行「添加工作目录」→ 原生目录选择器；**远程 / 桌面壳等没有原生选择器可用时，自动改用插件自绘的目录浏览器**（面包屑返回、逐级进入、可就地新建文件夹）；重复添加同一目录只保留一条并给出提示，可连续添加多个 |
| 弹层：移除 | 每个已配置目录一行 → 点击进**二次确认**（勾选后方可「移除」，取消回到列表） |
| 输入 **`@`** | 副目录里的文件以独立分组「多工作区目录」出现在候选中，选中插入其绝对路径，Agent 可直接 `read`；**目录行可按 Tab 逐级下钻**（与主工作区一致），面包屑可回退上一层 |
| 会话中 | 副目录清单注入系统提示词；配置变更在下一条消息或工具调用边界**不打断地**告知 Agent |
| 多窗口 / 手改配置 | 配置写入宿主自有存储，读取时按文件版本校验——另一个窗口或手工编辑的改动**下一次读取即生效，无需重启** |
| 写文件 / 执行命令 | `write` / `edit` / `pwsh` / `bash` 命中副目录时自动以该目录为沙箱根执行，各模式语义与主工作区一致；`read` / `glob` / `grep` 本就不受限 |

## 效果展示

**「+」菜单入口** —— 输入框自带菜单里的「多工作目录」一行：本地化名称、目录图标、一句话说明：

<img src="docs/images/plus-menu-entry.png" alt="输入框 + 菜单中的多工作目录一行" width="720">

**`@` 引用** —— 输入 `@` 时，已配置的副工作目录以独立分组列出：

<img src="docs/images/at-mention-secondary-dirs.png" alt="@ 选择器中按多工作区目录分组列出的副目录" width="360">

命令式入口（等价能力，也供 Agent 使用）：

```
/multi-folder list
/multi-folder add "D:\path\to\repo"
/multi-folder remove "D:\path\to\repo"
/multi-folder set "D:\a" "D:\b"
```

## 安装

```bash
dsh plugin --profile web add @zfgcta/dsh-multi-folder
```

GitHub 访问不稳定时，上面的 npm registry 方式正是省事的那条路；也可从 git 或本地 clone 安装（路径用正斜杠）：

```bash
dsh plugin --profile web add git+https://github.com/HelloQingTao/dsh-multi-folder.git
dsh plugin --profile web add file:D:/projects/dsh-multi-folder
```

安装后需**重启 DSH 后端**（宿主插件在进程启动时装载）**并刷新浏览器页面**（客户端 bundle 即时提供）。卸载：`dsh plugin --profile web remove @zfgcta/dsh-multi-folder`。

## 要求

- Node.js >= 20
- DSH profile 由 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 组成（标准 web profile）
- 无构建步骤：宿主半边是纯 ESM，客户端是 DSH client-modules 格式的手写 factory bundle

## DSH 兼容性

| DeepSeek Harness | 支持情况 |
| --- | --- |
| **0.1.7 及更新** | ✅ 完全支持：「+」菜单弹层、`@` 引用副目录文件、跨窗口配置一致（已在 0.1.7-rc.2 实测） |
| 0.1.6 及更早 | ❌ 不支持 |

「+」菜单弹层与 `@` 引用依赖 0.1.7 起随宿主提供的 `commandUi` / `inputTriggers` 客户端服务；在更早版本上，宿主不会提供这两个服务，本插件不会报错，但这两项功能无法使用。

本包与同名包 `dsh-multi-folder` **只能装一个**：两者占用同一套运行时标识（`/multi-folder` 命令、`multiFolder` 服务与 `multi-folder` 词条命名空间、副目录配置目录），同时安装会导致其中一个装载失败。请先卸载另一个。

## 原理

- **权限换根**：监听 `tools/execute` 环绕瀑布，对目标路径（或 `workdir`）落在副目录内的 `write`/`edit`/`pwsh`/`bash` 调用短路，改用**换根后的会话站立策略**执行（`{ ...standing, workspaceRoot: 副目录 }`）。模式不变，所以 `read-only` 仍拒绝、`workspace-write` 放行。匹配前先经 `fs.resolve` + `processPath` 规范化，`..`、符号链接、大小写都能正确判定。后台任务（`run_in_background`）以同一策略注册进通用 jobs 运行时，`job_output` / `job_kill` 照常可用。
- **单一可写根约束**：Windows ACL runner 为每个进程树只授予**一个**可写根，因此留在主工作区的命令无法向副目录建文件（`git -C <副目录>`、脚本内 `cd` 都不行，表现为 OS 级 `Permission denied`）。**创建文件的命令必须把 `workdir` 设为要写入的目录且用绝对路径**；命中此模式时插件会在工具结果上附带一条修正提示。
- **「+」菜单入口**：宿主端把 `/multi-folder` 注册进人机命令表，官方「+」菜单的「指令」分组即由它驱动。两点关键：① 命令**不声明 `input.hint`**——官方分组在非空草稿下会隐藏带提示的行，而这行必须常驻；② 客户端用 `ctx.commandUi.decorate` 给这条宿主命令挂 `popupSelect` 规格，于是点击打开的是**宿主自有的选择弹层**而非填入裸命令。列表/移除只提供数据（条目、文案、`confirmation` 二次确认规格），**不自绘弹层**；唯一自绘的是「添加」用的目录浏览器（见下），因为宿主弹层是一次性选择器，无法承载逐级浏览。
- **`@` 引用与下钻**：经 `ctx.inputTriggers.registerSource` 注册一个 `@` 触发的**独立来源**（trigger 相同、`name` 不同，故与宿主自带来源共存、各自成组），向宿主 `multiFolder/listFiles` 端点询问每个副目录的直接子项并以绝对路径呈现。目录行带 `drill: true`，于是 **Tab 逐级下钻**（插入带尾斜杠的目录、空格路径保持引号开放，与宿主 `formatFileMention` 同形），并实现 `header` 面包屑回退上层。查询同时接受别名形态（`@副目录名/余下路径`）与下钻插入的绝对形态，故可连续下钻。该来源整体 try/catch 且限 30 条，失败只退化为空分组，按 `source-failed` 语义不影响宿主结果。
- **自绘目录浏览器**：`uiWorkspace.pickDirectory()` 只有桌面端能用——宿主组的是 browse 后端（局域网绑定、远程客户端、桌面壳）时直接回 `directory-picker/unavailable`。因此「添加」在原生选择器不可用（或拒绝）时，降级为插件自绘的浏览器，数据走新增的 `multiFolder/browse`（列子目录，骑 `fs` seam，全部署通用，单层上限 1000 带 `truncated`）与 `multiFolder/makeDir`（校验单段名后 `mkdir`）。两者都不碰配置存储：选定后仍经本模式的既有通道提交（会话内 `/multi-folder add`，新会话页 `multiFolder/add`）。样式全部取自 `--dsw-alias-*` 令牌，因此跟随主题与换肤。
- **配置与安全边界**：per-workspace 配置为 JSON 数组，存于**所有 Agent 沙箱之外**的宿主目录 `<DSH_HOME>/storages/multi-folder/<workspace-key>.json`；对它的直接 `write`/`edit` 一律显式拒绝——**Agent 无法自我授权，配置权只属于用户**。缓存以 `fs.stat` 的版本保持一致：仅当文件仍是"当初读取时那个版本"才复用，否则回盘（版本在读**之前**取戳，避免把较旧内容标成较新版本）；每次读取都做规范化去重。详见 [SECURITY.md](SECURITY.md)。
- **无会话远程 API**：`multiFolder` 命名空间经 `ctx.typert.register` 以手写 `src-json` 描述符注册，并提供同名普通对象服务；`list`/`add`/`remove`/`set`/`listFiles` 以工作区**路径**为键，与命令共享同一套校验核心，因此首个消息之前的新会话界面也能直接配置。`listFiles` 带**围栏**：目标目录必须落在该工作区已配置的副目录之内，否则返回空——该端点不会退化成通用路径枚举器；`browse`/`makeDir` 以路径为键，只服务浏览器本身。

## 已知问题

- **旧版本（≤0.3.0）在已停止的会话里点「+」，指令分组可能为空**：升级到 0.4.0 即修复（根因是通知写日志时抛错、遗留了会话写句柄）；临时办法是新开会话或重启 DSH。

## 开发与文档

- 测试：`node test/smoke-host.mjs`（宿主 apply + remote API + 缓存一致性 + `listFiles` 围栏 + `browse`/`makeDir`）、`node test/intercept.mjs`（拦截/命令/通知）、`node test/activation.mjs`（可选服务缺失时仍能激活）、`node test/at-source.mjs`（`@` 查询解析、Tab 下钻、面包屑）、`node test/browser.mjs`（自绘浏览器全流程）
- 架构与演进：[docs/design.md](docs/design.md)；安全模型：[SECURITY.md](SECURITY.md)；变更：[CHANGELOG.md](CHANGELOG.md)

## 许可

[MIT](LICENSE)
