# dsh-multi-folder

[English](README.md) | **中文**

> 给一个 DSH 项目配置若干**副工作目录**：Agent 的主工作目录不变，但对这些目录拥有同等读写与命令执行权限，还能在输入框用 `@` 直接引用里面的文件。

## 效果

| 场景 | 表现 |
| --- | --- |
| 输入框左下角 **「+」** | 「指令」分组里出现 **「多工作目录」**（草稿是否为空都在）；点击打开**宿主自带选择弹层**（与「模型」选择器同一套 UI） |
| 弹层：添加 | 首行「添加工作目录」→ 原生目录选择器；重复添加同一目录只保留一条并给出提示，可连续添加多个 |
| 弹层：移除 | 每个已配置目录一行 → 点击进**二次确认**（勾选后方可「移除」，取消回到列表） |
| 输入 **`@`** | 副目录里的文件以独立分组「多工作区目录」出现在候选中，选中插入其绝对路径，Agent 可直接 `read` |
| 会话中 | 副目录清单注入系统提示词；配置变更在下一条消息或工具调用边界**不打断地**告知 Agent |
| 多窗口 / 手改配置 | 配置写入宿主自有存储，读取时按文件版本校验——另一个窗口或手工编辑的改动**下一次读取即生效，无需重启** |
| 写文件 / 执行命令 | `write` / `edit` / `pwsh` / `bash` 命中副目录时自动以该目录为沙箱根执行，各模式语义与主工作区一致；`read` / `glob` / `grep` 本就不受限 |

命令式入口（等价能力，也供 Agent 使用）：

```
/multi-folder list
/multi-folder add "D:\path\to\repo"
/multi-folder remove "D:\path\to\repo"
/multi-folder set "D:\a" "D:\b"
```

## 安装

`dsh plugin` 会把参数**原样转发给 pnpm**（在 profile 目录内执行）。因此：

- ⚠️ 裸包名 `dsh-multi-folder` 会命中 npm registry，装到的是**上游原版**（`AngelosZou`，0.2.x），不含本 fork 的功能。本仓库尚未发布到 npm，请**显式指定源**：

```bash
# 从本 fork 的 GitHub 仓库安装（推荐）
dsh plugin --profile web add git+https://github.com/HelloQingTao/dsh-multi-folder.git

# 或从本地已 clone 的仓库安装（开发调试用；路径用正斜杠）
dsh plugin --profile web add file:D:/projects/dsh-multi-folder

# 卸载
dsh plugin --profile web remove dsh-multi-folder
```

安装后需**重启 DSH 后端**（宿主插件在进程启动时装载）**并刷新浏览器页面**（客户端 bundle 即时提供）。若 GitHub 直连不稳定，git 需走代理（本 fork 已针对 `github.com` 单独配置，见 Q&A）。

## 要求

- Node.js >= 20
- DSH profile 由 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 组成（标准 web profile）
- 无构建步骤：宿主半边是纯 ESM，客户端是 DSH client-modules 格式的手写 factory bundle

## DSH 兼容性

| DeepSeek Harness | 可用范围 |
| --- | --- |
| 0.1.7 及更新 | 完整功能：「+」菜单弹层、`@` 引用副目录、跨窗口配置一致（已在 0.1.7-rc.2 实测） |
| 0.1.2-alpha ~ 0.1.6 | 建议用上游 `dsh-multi-folder@0.2.4`：本 fork 依赖 0.1.7 起的 `commandUi` / `inputTriggers` 客户端服务 |
| 0.1.1 及更早 | 用 `dsh-multi-folder@0.1.7` |

降级说明：客户端在缺少 `commandUi` 或 `inputTriggers` 时会跳过对应注册，不报错，`/multi-folder` 命令与权限拦截照常可用。

## 原理

- **权限换根**：监听 `tools/execute` 环绕瀑布，对目标路径（或 `workdir`）落在副目录内的 `write`/`edit`/`pwsh`/`bash` 调用短路，改用**换根后的会话站立策略**执行（`{ ...standing, workspaceRoot: 副目录 }`）。模式不变，所以 `read-only` 仍拒绝、`workspace-write` 放行。匹配前先经 `fs.resolve` + `processPath` 规范化，`..`、符号链接、大小写都能正确判定。后台任务（`run_in_background`）以同一策略注册进通用 jobs 运行时，`job_output` / `job_kill` 照常可用。
- **单一可写根约束**：Windows ACL runner 为每个进程树只授予**一个**可写根，因此留在主工作区的命令无法向副目录建文件（`git -C <副目录>`、脚本内 `cd` 都不行，表现为 OS 级 `Permission denied`）。**创建文件的命令必须把 `workdir` 设为要写入的目录且用绝对路径**；命中此模式时插件会在工具结果上附带一条修正提示。
- **「+」菜单入口**：宿主端把 `/multi-folder` 注册进人机命令表，官方「+」菜单的「指令」分组即由它驱动。两点关键：① 命令**不声明 `input.hint`**——官方分组在非空草稿下会隐藏带提示的行，而这行必须常驻；② 客户端用 `ctx.commandUi.decorate` 给这条宿主命令挂 `popupSelect` 规格，于是点击打开的是**宿主自有的选择弹层**而非填入裸命令。插件只提供数据（条目、文案、`confirmation` 二次确认规格），**不自绘任何弹层**。
- **`@` 引用**：经 `ctx.inputTriggers.registerSource` 注册一个 `@` 触发的**独立来源**（trigger 相同、`name` 不同，故与宿主自带来源共存、各自成组），向宿主 `multiFolder/listFiles` 端点询问每个副目录的直接子项并以绝对路径呈现。该来源整体 try/catch 且限 30 条，失败只退化为空分组，按 `source-failed` 语义不影响宿主结果。
- **配置与安全边界**：per-workspace 配置为 JSON 数组，存于**所有 Agent 沙箱之外**的宿主目录 `<DSH_HOME>/storages/multi-folder/<workspace-key>.json`；对它的直接 `write`/`edit` 一律显式拒绝——**Agent 无法自我授权，配置权只属于用户**。缓存以 `fs.stat` 的版本保持一致：仅当文件仍是"当初读取时那个版本"才复用，否则回盘（版本在读**之前**取戳，避免把较旧内容标成较新版本）；每次读取都做规范化去重。详见 [SECURITY.md](SECURITY.md)。
- **无会话远程 API**：`multiFolder` 命名空间经 `ctx.typert.register` 以手写 `src-json` 描述符注册，并提供同名普通对象服务；`list`/`add`/`remove`/`set`/`listFiles` 以工作区**路径**为键，与命令共享同一套校验核心，因此首个消息之前的新会话界面也能直接配置。

## Q&A

**为什么「+」菜单里看不到这一行？** 若装的是 npm 上的上游版（0.2.x），它没有该入口——请用上一节的 git 源安装并重启。若在 0.1.2~0.1.6 上运行，「指令」分组会把它显示成普通命令行。

**能指定 profile / 多个 profile 吗？** 每条命令都是 per-profile 的：换 `--profile <name>` 即装进那个 profile。

**上游会同步吗？** 本仓库是 [AngelosZou/dsh-multi-folder](https://github.com/AngelosZou/dsh-multi-folder)（MIT，原作者署名保留）的持续维护 fork，保留包身份，可用 `git fetch upstream` 合并上游改动。

## 变更与许可

版本变更见 [CHANGELOG.md](CHANGELOG.md)（0.3.0 起为本 fork 的工作）。架构细节见 [docs/design.md](docs/design.md)。许可 [MIT](LICENSE)。
