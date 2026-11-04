# 测试记录

本文件按时间记录每一轮的实测证据：命令、退出码（一律重定向后取命令本身的退出码）、关键输出。真机冒烟只记会话号前 8 位。

- 三层测试：`npm test`（单元 + 假 runner 中间档，不调用模型）、`npm run smoke`（真机，产生费用，不进 CI）、`npm run scan`（个人信息扫描）。
- CI（`.github/workflows/ci.yml`）在 Node 20 与 22 上依次跑：`npm ci` → `npm test` → `node bin/hub.mjs roles build --hub . && git diff --exit-code agents/` → `npm run scan`。

## v0.1（2026-10-14）

环境：macOS，Node.js 22（项目要求 Node.js 20+）。

### 自动测试

`npm test` 覆盖元数据解析与生成、安装与锁、手改保护、重复安装零写入、自定义 Claude 入口、其他 Skill 保留、runner 参数与事件解析、runner 错误事件提取（Codex `error` / `turn.failed`、Claude `result` 的 `is_error`/`subtype` 优先于 stderr）、Git/非 Git 快照、环境去密钥、run 记录，以及假 runner 的 run/status/report/resume/cancel、失败 run 的 report 错误展示和双 run 时间重叠。

最终原始摘要：

```text
1..11
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7584.496709
NPM_TEST_EXIT=0
```

### README 路径复跑

在全新临时目录复制当时的 `examples/hub`（0.2.0 已删除，改用 `hub init`）与 `examples/project`，逐条执行 README 的角色生成、`install`、`check`、后台派单、`status`、`report` 与 `resume`（runner 用同形 JSONL 的本地替身，避免重复计费）。首次与续派均为 `completed`，原生会话号保持相同，命令末尾为 `README_WALKTHROUGH_EXIT=0`。真实 runner 结果如下。

### 真实 CLI 冒烟

命令：`npm run smoke`。脚本为 Claude 的 PM 和 Codex 的 Dev 分别创建临时 hub/项目，首次任务各写一个只有一行的 Markdown 文件，再 resume 读取；输出只记录退出码、耗时和原生会话号前 8 位。

在普通终端（非受管沙箱）执行的结果（整体退出码非 0，因 Codex 未完成）：

```text
Claude / PM:
  first_exit: 0
  resume_exit: 0
  elapsed_ms: 约 15000
  first_session: <id>
  resumed_session: <id>
  same_session: true

Codex / Dev:
  结果: 未完成（runner 返回错误事件，与适配器无关）
  native session: 未生成
```

- **Claude Code：通过。** 首轮与续派退出码均为 0，续派恢复到同一原生会话。
- **Codex CLI：未完成，待复跑。** runner 在首轮就返回错误事件，不是适配器问题，但也因此当时没有真机证据证明 Codex 的 run/resume 链路可用；需在普通终端复跑 `npm run smoke`。
- 更早一次在受管执行沙箱里的冒烟（Claude resume 报 `No conversation found`、Codex 初始化报 `Operation not permitted`）是沙箱禁止 CLI 写自身状态目录造成的执行环境限制，已由上面的普通终端复跑排除。

这次失败时，旧版 report 只显示 stderr 里的 `Reading additional input from stdin...`，真正原因被埋掉。现已改为优先展示 runner 流式 JSON 里的错误事件消息，stderr 作补充附在 `[stderr]` 段。

真实冒烟不属于 `npm test`，因为会产生模型调用。

## v0.2 R1（2026-10-30）：只用 AGENTS.md、GM 入口、PROJECT.md、派单小改

`npm test` 从 11 组增到 19 组（新增 8 组，改写 2 组旧断言：原来断言「AGENTS.md 与 CLAUDE.md 字节相同」「缺失时写 `@AGENTS.md`」，现已反过来）。原始摘要（输出重定向到文件，退出码取自 `npm test` 本身）：

```text
1..19
# tests 19
# pass 19
# fail 0
NPM_TEST_EXIT=0
```

验收逐项（临时目录 `$(mktemp -d)`，命令输出里的临时路径已替换为 `<tmp>`）：

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 仓库内无 CLAUDE.md 角色卡 | `find agents -name CLAUDE.md` | 空（0 个） |
| 新项目不写 CLAUDE.md | `hub install`（项目原无 CLAUDE.md） | 退出 0；项目内 `find . -name CLAUDE.md` 为空 |
| 预置 `@AGENTS.md` 被删 | 项目根预置一行 `@AGENTS.md` 后 `hub install` | 退出 0；输出 `delete CLAUDE.md`；文件消失 |
| 预置自定义内容保留 | 项目根预置 `# Mine` 后 `hub install` | 退出 0；输出 `preserve CLAUDE.md (…merge it into AGENTS.md by hand)`；文件原样 |
| `hub init` 两次 | `hub init --hub <tmp>/hub` ×2 | 第一次退出 0，创建 `AGENTS.md`、`.project-root`、`roles/{dev,gm,pm,qa}.md`、`skill/SKILL.md`、`.gitignore` 与 4 张角色卡；第二次退出 0，输出 `already up to date (zero writes)` |
| GM 不可派发 | `hub run --role gm …` | 退出 1；`hub: gm: entry roles are not dispatchable; open a session in the hub root instead`；不生成 run 记录 |
| v0.1 → v0.2 升级 | 用 v0.1 提交的代码装一个项目（产生根 `CLAUDE.md` 与 3 个 `agents/*/CLAUDE.md`），手改其中 qa 一份，再用新代码 `hub install` | 退出 0；`delete agents/dev/CLAUDE.md`、`delete agents/pm/CLAUDE.md`、`delete CLAUDE.md`、`preserve agents/qa/CLAUDE.md (edited since install; no longer tracked)`；锁里 CLAUDE 条目 0 个；`hub check` 7 项全 `ok`；再装一次 `already up to date (zero writes)` |
| 角色卡与角色源一致 | `node bin/hub.mjs roles build --hub .` | 退出 0；`roles already up to date` |

未做：真机冒烟（`npm run smoke`）本轮没跑，R1 未改 runner 参数；派发提示文本变了，真机 V1 标记验证留给 R4。

## v0.2 R2（2026-10-30）：`hub board` 与 `hub run --worktree`

`npm test` 从 19 组增到 23 组（新增：board 单元、worktree 位置与提示单元、worktree 全链中间档、同项目并发警告中间档）。连跑 3 次均 23/23。最后一次原始摘要（重定向到文件，退出码取自 `npm test` 本身）：

```text
1..23
# tests 23
# pass 23
# fail 0
NPM_TEST_EXIT=0
```

手工验收（临时目录，假 runner 在 cwd 写一个 `from-runner.txt`；临时路径与 run 号已替换为 `<tmp>` / `<id>`）：

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| worktree run 完成 | `hub run … --role dev --worktree` | 退出 0；状态 `completed` |
| 主仓干净 | `git -C <project> status --porcelain` | 空输出 |
| 改动在 worktree | `git -C <tmp>/demo-wt/<id> status --porcelain` | `?? from-runner.txt` |
| 分支存在 | `git log hub/<id> --oneline` | `base` 一条（假 runner 不提交，改动留在 worktree） |
| report 有 Worktree 行 | `hub report` | `- Worktree: <tmp>/demo-wt/<id> (branch hub/<id>)` |
| board 不含 `%` | `hub board > board.txt; grep -c '%' board.txt` | board 退出 0；`%` 计数 0（假 runner 的回答里带了 `100%`，没有被打印） |
| prune 拒绝脏 worktree | `hub worktree prune` | 退出 1；`refused … (has uncommitted changes; commit them or use --force)` |
| prune 强删 | `hub worktree prune --force` | 退出 0；`removed … (branch hub/<id> kept)`；目录消失，分支仍在 |

中间档测试另外覆盖：非 Git 项目加 `--worktree` 报错；`resume` 复用同一 worktree 与 cwd；worktree 里提交后 prune 不需 `--force`，`git log hub/<id>` 能看到该提交；prune 后 `resume` 报 `parent worktree no longer exists`；不加 `--worktree` 的第二个 run 在 stderr 打警告但照常启动。

未做：真机冒烟 V2（真实 Claude / Codex 在 worktree 里跑）留给 R4。

## v0.2 R3（2026-10-30）：双语首页、图、LICENSE、CI、个人信息扫描

`npm test` 从 23 组增到 25 组（新增 `test/scan.test.mjs` 两组；另在既有用例里补了「角色卡未提交时 worktree run 打警告」与「父 run 未结束 / 没有会话号时拒绝续派」的断言）。

### CI 步骤手工复跑

把暂存内容用 `git checkout-index` 导出到一个全新临时目录（没有本地专属词表，相当于 CI 没配 Secret），逐条执行 `.github/workflows/ci.yml` 的命令：

| 步骤 | 命令 | 退出码 | 输出要点 |
| --- | --- | --- | --- |
| 安装 | `npm ci` | 0 | 无依赖 |
| 测试 | `npm test` | 0 | 25 pass / 0 fail |
| 角色卡一致性 | `node bin/hub.mjs roles build --hub . && git diff --exit-code agents/` | 0 | `roles already up to date` |
| 扫描（无 Secret） | `HUB_SCAN_PATTERNS="" npm run scan` | 0 | `0 hits; no private word list (…): generic rules only` |
| 扫描（假 Secret） | `HUB_SCAN_PATTERNS="example-secret-word" npm run scan` | 0 | `0 hits; 1 private patterns from HUB_SCAN_PATTERNS` |

GitHub Actions 本身没有在 GitHub 上跑过（本轮不建远端）；本地也没有用 `act`。

### 首页快速上手复跑

分别从 `README.md` 与 `README.zh-CN.md` 抽出快速上手的 bash 块（去掉 `git clone` 与 `cd` 两行，在本仓库根执行），runner 换成同形 JSONL 的本地替身：两份都退出 0；首轮与续派 report 均为 `Status: completed`，续派会话号与首轮相同。

第一次复跑发现：快速上手把 `run` 与 `resume` 连着写，复制粘贴时父 run 还没结束、会话号还没拿到，`resume` 悄悄开了新会话（report 显示 `Native session: (not captured)`）。已改两处：`hub resume` 遇到未结束或没有会话号的父 run 直接报错；两份首页在 `run` / `resume` 后加了等待循环。改后复跑结果如上。

### 图

两份首页各 5 张 Mermaid 图（图 1–5），`docs/how-it-works.md` 4 张（含图 6 加载顺序）。本机没有 `mmdc`，在仓库外临时目录安装 mermaid-cli 的尝试被本机权限策略拦下，所以**没有做真实渲染**。替代校验：仓库外的结构检查脚本（引号与括号配平、subgraph/end 配对、边引用的节点均有定义、class 均有定义、sequence 参与者均已声明、消息里无 ASCII 分号与尖括号），14 张图 0 问题；同一脚本对故意写坏的样例报出 7 个问题，证明检查有效。GitHub 上能否渲染要等推送后或在 PR 预览里确认。

### 隐私扫描

`npm run scan`（读本地专属词表）退出 0，0 命中。扫描只打印 `文件:行号:规则`；扫描器和它的测试里的假敏感串都在运行时拼出，两份文件本身也过扫描。

## v0.2 R4（2026-10-30）：QA 真机验收摘要

环境：Node.js 22，Claude Code 2.1.314，Codex CLI 0.162.1。被测提交为 R3 提交。只记命令、退出码、耗时与是否同一会话。

| 项 | 命令 / 做法 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 自动测试 | `npm test` | 0 | 15s | 25/25 |
| 隐私扫描 | `npm run scan`（带本地词表） | 0 | <1s | 0 命中 |
| 英文首页走通 | 全新临时目录，照 `README.md` 逐条执行（克隆改为本地克隆），真实 Claude Code | 每步 0 | 首轮 21s，续派 35s | 续派与首轮同一原生会话；report 分别列出 Added / Modified |
| 中文首页走通 | 同上，照 `README.zh-CN.md` | 每步 0 | 首轮 21s，续派 30s | 同一原生会话；另加 Codex Dev 一轮 run（25s）+ resume（20s），同一会话 |
| 真机冒烟 | `npm run smoke` | 0 | 53s | PM（Claude Code）18.1s、Dev（Codex CLI）34.1s；两者首轮与续派退出码均 0，均为同一原生会话 |
| V1 原生读角色卡 | 角色源注入随机标记后 `hub roles build`，在 `agents/<role>/` 直接启动 CLI，问题不含标记、不许用工具 | 4 组均 0 | 4–8s | Claude Code 与 Codex CLI 在 PM、Dev 两个目录下（含交叉）都答出该目录角色卡的标记；在 `agents/` 上一级启动的对照组答不出 |
| V2 真机 worktree | Codex Dev 与 Claude PM 同时 `hub run --worktree` | 0 / 0 | Dev 35s | 两条 run 并行；主仓 `git status --porcelain` 派发前、完成后、续派后均为空；`resume` 回到同一 worktree 与同一原生会话 |
| Mermaid 渲染 | 仓库外安装 mermaid-cli 12，逐张 `mmdc` | 14 张均 0 | 每张 1–3s | 无语法错误（GitHub 内置版本仍需推送后确认） |

R4 发现并留给 R5 的问题：

1. 派出的 run 里 git 全部退出 128（`missing config key GIT_CONFIG_KEY_0`）：环境过滤按名字删掉了 `GIT_CONFIG_KEY_<n>`，却留下 `GIT_CONFIG_COUNT` 与 `GIT_CONFIG_VALUE_<n>`。父环境不带这组变量时不触发，所以普通终端里的 `npm test` 与冒烟都没测到。
2. Codex 默认沙箱不允许在 worktree 里 `git commit`（不经 hub、干净环境下直接复现：无法创建 `index.lock`）。这是 Codex 沙箱行为，不是 hub 缺陷；首页已写明提交和合并由用户来做。
3. 首页文案：已知限制里「真机验证还没做」已过时；亮点「根会话就是 GM」的派单行为没有真机证据；架构图把 run 记录写成 `run.json`。

## v0.2 R5（2026-10-30）：修 R4 问题

- `src/env.mjs`：`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` 整组保留（取舍写在代码注释里）。
- 新增测试：`environment keeps the GIT_CONFIG_COUNT/KEY/VALUE group together`（单元）、`runs keep the parent's GIT_CONFIG_* group so git works inside a worktree run`（中间档，假 runner 在 worktree run 里执行 `git log`）。修复前这两条红（25 pass / 2 fail，报错与 R4 相同：`missing config key GIT_CONFIG_KEY_0`），修复后 27/27。
- 手工验收：在带 5 个 `GIT_CONFIG_*` 变量（`GIT_CONFIG_COUNT=2`）的会话 shell 里，用假 runner 派一个 `--worktree` run：`hub run` 退出 0；run 里看到全部 5 个变量；`git log` 退出 0，stderr 为空，输出了基线提交。
- 首页：已知限制改为 V1 / V2 实测结论，并单列「worktree run：提交和合并由你来做」；亮点 2 收窄到有证据的范围，注明 GM 在真实会话里的行为留给下一轮 QA；架构图的 run 记录改为 `<id>.json`，how-it-works 补了文件布局一句。中英两份同步：各 15 个章节、8 条亮点、8 条已知限制、5 张图。

## v0.2 R6（2026-10-30）：QA 复验 R5 + GM 真机走通摘要

只记命令、退出码、耗时与判定。

| 项 | 命令 / 做法 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 自动测试 | `npm test` | 0 | 15s | 27/27 |
| 隐私扫描 | `npm run scan` | 0 | <1s | 0 命中 |
| R5 复验：Codex Dev worktree run（父环境带 5 个 `GIT_CONFIG_*`） | `hub run --role dev --worktree` | 0 | 26s | completed；run 里 `git log` 退出 0（R4 时 128） |
| R5 复验：Claude QA worktree run | 同上，`--role qa` | 0 | 10s | completed；run 里 `git log` 正常输出 |
| R5 复验：Claude PM（home 工作区） | 同上，`--role pm` | 0 | 15s + 16s | completed；run 内命令被本机 Claude 权限拦下，没跑成 `git log`（CLI 权限问题，不是 hub 缺陷） |
| Claude GM 第 1 轮（默认权限） | 在 hub 根 `claude -p` 提需求 | 0 | 57s | 没派出 run：`hub` 调用全被权限拒绝；GM 没有代做、没有编结果，按卡里的格式把放行选项带回给用户 |
| Claude GM 第 2 轮（`--allowedTools "Bash(hub:*)"`，续同一会话） | `claude -p --resume … --allowedTools "Bash(hub:*)" --add-dir <project>` | 0 | 111s | 自己 `hub run --role pm` → completed → 读 report；PM 的 3 个开放问题逐条带回，没有替用户作答 |
| Codex GM 第 1 次 | 在 hub 根 `codex exec` 提需求 | 0 | 86s | 派 PM → completed → 读 report；**漏报**：PM 报告有 2 个开放问题和 1 个阻碍，GM 说「当前无阻塞」 |
| Codex GM 第 2 次（全新目录、同一需求） | 同上 | 0 | 87s | 派 PM → completed → 读 report；2 个开放问题逐条带回 |
| Mermaid 渲染 | 仓库外 mermaid-cli 12，14 张图逐张 `mmdc` | 14 张均 0 | 每张 1–3s | 无语法错误 |

判定：R5 修复通过；GM 派单、读 report、不编答案两引擎都通过；开放问题 3 次里带回 2 次（Codex 漏 1 次），按契约判 FAIL，留给 R7。

## v0.2 R7（2026-10-30）：收尾 GM 体验

- `roles/gm.md` 新增「Relaying a finished run (hard rule)」：run 结束先读完整 `hub report`；开放问题、待用户决定的事项、阻碍逐条转述，不合并、不删减；没有就原话说 "The report has no questions waiting for your decision."；不得概括成 "no blockers"，不得替用户作答。重新生成 `agents/gm/AGENTS.md`。
- 新增测试 `the built-in GM card requires relaying every open question from hub report`：检查 `roles/gm.md` 含上述规则，且 `agents/gm/AGENTS.md` 与源一致。重新生成卡片前这条是红的（27 pass / 1 fail），生成后 28/28。
- 新增 `bin/hub`（指向 `bin/hub.mjs` 的相对软链；`hub.mjs` 权限 755、首行 `#!/usr/bin/env node`）。首页快速上手改为 `export PATH="$PWD/bin:$PATH"` + `command -v hub`，不再用 shell 函数；`npm link` 作为另一种方式写在下面。
- 首页走通：把暂存内容导出成全新的 `AgentHubCore` 目录（模拟克隆），在 `env -i` 的干净环境里（PATH 里只有 node、`/usr/bin`、`/bin`，执行前 `command -v hub` 找不到）照中英两份首页的 bash 块逐条执行，runner 用假的：两份都退出 0；`command -v hub` 找到了 `bin/hub`；首轮与续派都 completed，续派在同一会话。
- 首页：亮点 2 改为带限定的已验证版本（证据写真机 GM 走通，开放问题 3 次带回 2 次）；「日常用法」写明 Claude Code 怎么放行 `Bash(hub:*)`（项目 `.claude/settings.json` 或 `--allowedTools`）；已知限制加 3 条（GM 需要 `hub` 在 PATH、Claude Code 要放行 `hub`、GM 可能漏报开放问题）。中英同步：各 15 章、8 条亮点、5 张图、11 条已知限制。

## v0.2 R8（2026-10-30）：QA 复测 GM 新规则摘要

| 项 | 命令 / 做法 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 自动测试 | `npm test` | 0 | 15s | 28/28 |
| 隐私扫描 | `npm run scan` | 0 | <1s | 0 命中 |
| 英文首页照抄执行 | 从 `README.md` 抽 bash 块逐行执行，只换克隆地址 | 17 条全 0 | 等待 25s / 21s | 两次 report 均 completed；`command -v hub` 指向克隆内 `bin/hub`；续派同一会话 |
| 中文首页照抄执行 | 同上，`README.zh-CN.md` | 17 条全 0 | 等待 20s / 31s | 同上 |
| Claude GM（c1） | 在 hub 根 `claude -p --allowedTools "Bash(hub:*)" --add-dir <project>` | 0 | 113s | 派 PM（用 `hub resume` 续了快速上手留下的 PM 会话）→ completed → 读 report；5 条开放问题全部逐条带回 |
| Codex GM（x1–x3，各自全新环境） | 在 hub 根 `codex exec --skip-git-repo-check` | 0 / 0 / 0 | 56s / 69s / 64s | 每次新 `hub run` 派 PM → completed → 读 report；开放问题 4/4、5/5、5/5 带回 |

判定 PASS：加入转述规则后 4 次 GM 都派对角色、读了 report，开放问题 19/19 逐条带回，没有替用户作答（R6 规则前是 3 次带回 2 次）。「报告没有问题时说规定原话」本轮没有样本，没测到。

QA 观察（R9 处理了第 1、3、4 条，第 2 条没改）：1. Claude GM 把新需求当成对旧问题的回答，用了 `hub resume`；2. GM 用 `until … | grep` 循环或其他工具等待 run 时，`Bash(hub:*)` 不覆盖，会多出权限拒绝；3. `hub --help` / `hub run --help` 退出 1；4. 首页 `until` 等待循环没有超时。

## v0.2 R9（2026-10-30）：最后收尾

- `hub --help`、`hub -h`、`hub help`、`hub <command> --help` 都打印用法并退出 0；作为参数值的 `-h`（如 `--task -h`）仍当值处理。新增测试 `--help and -h print usage and exit 0 for hub and for every command`。手工：`hub --help`、`hub -h`、`hub run --help`、`hub worktree list --help` 都退出 0（改前 `hub run --help` 退出 1）。
- GM 卡新增「New run or resume」：新需求默认 `hub run` 开新 run；只有用户明确在回答某个角色之前的问题时才 `hub resume`；拿不准先问用户。新增测试 `the built-in GM card starts a new run for new requests and resumes only for answers`；重新生成 `agents/gm/AGENTS.md`。
- 首页：亮点 2 与已知限制改用 R8 报告第 3 节的中英措辞（删掉了「3 次里 2 次」）；快速上手的等待改成最多 10 分钟的 `wait_run`，超时打印提示并返回 1；「日常用法」注明 `codex exec` 在非 Git 的 hub 里要加 `--skip-git-repo-check`。中英各 15 章、8 条亮点、5 张图、11 条已知限制。
- 首页走通：把暂存内容导出成全新的 `AgentHubCore` 目录，在 `env -i` 的干净环境里照中英两份的 bash 块执行（runner 用假的）：两份都退出 0，各 2 份 completed report。超时分支：把 `seq 120` 临时改成 `seq 2`、runner 改成一直不结束，两份都退出 1，并打印「请看 `hub status`」的提示。
- `npm test`：30/30（R7 时 28/28）。

## v0.2 R10（2026-10-31）：GitHub CI 上两组超时

**现象**：GitHub Actions 首跑，Node 20（Ubuntu）上 30 组里 2 组在 `waitRun` 的 8 秒处超时；macOS 本机全过。

**根因**：`executeRunner` 在 `spawn` 之后先 `await onSpawn(child)`（写 run 记录），然后才挂 stdout/stderr 的 `data` 监听和 `close` / `error` 监听。runner 如果在这次 await 期间就退出，Node 会把没人读的输出排掉，`close` 事件也在没人监听时发出；worker 等的 promise 永远不会兑现，事件循环空了，worker 以 0 退出。run 记录停在 `running`，`runner.log` 0 字节。Linux 上 fork/exec 快、写盘相对慢，更容易输掉这场竞争。spawn 失败时的 `error` 事件同样会漏掉。

**证据**：

| 环境 | 提交 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- | --- |
| Docker `node:20`（Debian，`/bin/sh` 为 dash，非 root，无 git 全局身份） | 修复前 | `npm test` | 1 | 24 pass / 6 fail，6 组全是 `waitRun` 超时 |
| 同上，手工派一个 run | 修复前 | `hub run` 后 4 秒查看 | — | run 记录 `status: running`，`runner.log` 0 字节，worker 进程已不在 |
| 同上，前台直接跑这个 run 的 worker | 修复前 | `hub __worker --hub … --run …` | 0 | worker 退出码 0，但 run 仍是 `running`：promise 没兑现，事件循环空了 |
| macOS，新增的确定性测试（`onSpawn` 故意慢 300ms，runner 立即退出） | 修复前 | `npm test` | 1 | 30 pass / 1 fail：`executeRunner never settled` |
| macOS | 修复后 | `npm test` | 0 | 31/31 |
| Docker `node:20` | 修复后 | `npm test` ×3 | 0 / 0 / 0 | 每次 31/31 |
| Docker `node:22` | 修复后 | `npm test` | 0 | 31/31 |

**修复**：`src/runners.mjs` 在第一次 await 之前就挂好全部监听器，再 `await onSpawn`；spawn 失败（如 runner 不存在）现在会让 run 进入 `failed`，不会再让 worker 静默退出。测试的超时值没有调大。

新增测试：`executeRunner keeps output and exit status when the runner exits before onSpawn returns`（含 runner 不存在时 `executeRunner` 以 `ENOENT` 拒绝的断言）。

## v0.3 R11（2026-11-01）：派发与回收、跨项目记忆、自测脚本

`npm test` 从 31 组增到 46 组（macOS 与 Docker `node:20` 都是 46/46）。新增：

- 单元：`hub wait exit codes: 0 all completed, 1 some failed or canceled, 2 still running, error for unknown runs`；`hub wait prints one line per run and a summary, without prompt or answer text`；`--worktree-of rejects a source without a worktree, a still-active worktree, and --worktree together`；`dispatch prompt reads hub memory by absolute path, then project memory, and asks for memory proposals`；`hub memory add writes one dated line, ignores duplicates, and lists entries`；`hub memory add refuses personal data by rule name and writes nothing`；`hub memory add restores the hub .gitignore line for memory files`；`the built-in GM card plans serial or parallel work, collects batches, and records confirmed corrections`；`built-in dev, pm, and qa cards ask for memory proposals instead of editing memory`。
- 中间档（假 runner）：`fan-out: 8 worktree runs start back to back, overlap, and are all collected by one hub wait`；`relay: QA continues on the Dev run's worktree and branch with --worktree-of`；`mixed batch: hub wait exits 1 with a failed run, 2 on timeout, 1 after cancel`；`memory recorded once in the hub reaches the same role in another project, in place and in a worktree`；`hub memory CLI: exit 3 names the rule without echoing the text; list prints entries`；`npm run parallel-check --fake --n 4 reports 4 completed, real overlap, and cleans up`。

扇出用例的墙钟断言用的是「< 7 秒」（8 个各 1 秒的 run，若串行至少 8 秒），不是方案里的「< 4 秒」：8 次 `hub run` 各起一个 Node 进程，CI 慢机上留出余量；并行的主要证据是 8 个 runner 进程的存活区间有公共交点。

### `npm run parallel-check`（假 runner，N=100）

| 命令 | 退出码 | 派出 100 个 | 等全部结束 | 峰值并发 | 单个 run 耗时 min / 中位 / max | 完成 / 失败 | 清理后剩余 worktree |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `npm run parallel-check -- --n 100`（每个 run 2 秒） | 0 | 9.6 s | 3.1 s | 28 | 2 / 2.1 / 2.3 s | 100 / 0 | 0 |
| `npm run parallel-check -- --n 100 --sleep 15`（每个 run 15 秒） | 0 | 9.8 s | 15.1 s | 100 | 15 / 15.1 / 15.3 s | 100 / 0 | 0 |

逐个派出 100 个要约 10 秒，所以 2 秒的 run 在派发过程中就陆续结束了，峰值只有 28；把单个 run 拉长到 15 秒后，100 个同时存活。这之前还跑过三次 N=100：两次每个 run 2 秒（峰值 27、25），一次 15 秒（峰值 100），全部 0 失败。索引锁（`runs.jsonl` 的 `mkdir` 锁，等待上限 5 秒）在这些压测里没有出错，所以 `src/store.mjs` 这一轮没有改。数字来自一台普通笔记本；真实 CLI 的上限取决于电脑和模型额度，首页只引用假 runner 的结果与脚本本身。

### 其他

- `node bin/hub.mjs --help` 列出 `hub wait`、`hub memory add|list`、`--worktree-of`。
- Mermaid：两份首页各 6 张、`docs/how-it-works.md` 5 张，共 17 张，用仓库外已有的 mermaid-cli 12.0.0 逐张渲染，17/17 成功、SVG 里没有 "Syntax error"。
- 首页：中英各 18 章、7 条亮点、6 张图、12 条已知限制。需要真机证据的句子（GM 批量走通、两个项目跑同一角色、项目 A 纠正项目 B 生效、GM 的批量与记忆规则）标为「待 QA 真机验证」。

## v0.3 R12（2026-11-01）：QA 真机验收（部分结果）

被测提交为 R11 提交。部分项稍后复验；下面只记已有结果，只写命令、退出码、耗时与判定。

| 项 | 命令 / 做法 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 自动测试 | `npm test` | 0 | 41s | 46/46 |
| 隐私扫描 | `npm run scan`（本地词表已加载） | 0 | <1s | 0 命中 |
| 角色卡一致性 | `node bin/hub.mjs roles build --hub .` 后 `git diff --exit-code agents/` | 0 / 0 | — | 一致 |
| 推送前五项隐私检查 | 全部跟踪文件、待推送提交、间接泄露、不该跟踪的文件、汇报方式 | — | — | 五项通过 |
| 压测 | `npm run parallel-check -- --n 100 --sleep 15` | 0 | 26s | 峰值并发 100，100 完成 / 0 失败，清理后 0 个 worktree |
| Mermaid 渲染 | 仓库外 mermaid-cli 12，17 张逐张渲染 | 17 张均 0 | — | 无语法错误 |
| 英文首页照抄执行 | 从 `README.md` 抽 bash 块逐行执行，只换克隆地址 | 17 条全 0 | `hub wait` 24s / 22s | 两份 report 均 completed |
| 中文首页照抄执行 | 同上，`README.zh-CN.md` | 17 条全 0 | `hub wait` 26s / 30s | 同上 |
| Claude GM 批量（第 1 次） | 在 hub 根 `claude -p --allowedTools "Bash(hub:*)" --add-dir <project>`，需求为三个文件各由一个 Dev 并行写、QA 接力检查 | 0 | 147s | 见下 |

Claude GM 第 1 次的判定（这次 3 个 Dev run 都失败，正好检验失败路径）：

- 派发前写了计划文件（3 个并行 + 3 个 `--worktree-of` 接力，附理由），但派发前给用户的文字只有一句，计划摘要到最终回答里才出现：部分通过。
- 并行：3 个 `hub run --worktree` 背靠背派出；因为 Dev 几秒就失败，这次不能判定是否真正重叠，等正常路径复验。
- 等待：一次 `hub wait <3 个 run>`，没有 shell 轮询：通过。
- 总表：每个 run 一行，状态、退出码、分支、改动计数、问题数与 report 一致：通过。
- 开放问题：3 份报告都没有问题；GM 的意思对，但没有用卡里规定的原话：部分通过。
- 失败处理：原样引用 Runner error，停止新派发、不重试，给出选项和推荐：通过。
- 不合并、不清理 worktree，主工作区干净：通过。
- 权限拒绝 6 次：3 次是 `HUB=<path> hub run …` 这种带环境变量前缀的写法匹配不上 `Bash(hub:*)`，3 次是 GM 卡允许的 `git log` / `git status` 只读检查。

## v0.3 R13（2026-11-01）：按 R12 已有结果修措辞与权限

- GM 卡：派发前必须先把计划摘要（任务、谁做、哪些并行、哪些接力、为什么）以文字发给用户，`claude -p` / `codex exec` 一次性模式也要先输出这段再派，只出现在最终回答里不算；调用 `hub` 不加环境变量前缀。新增测试 `the built-in GM card prints the plan summary before dispatching and calls hub without env prefixes`；`npm test` 46 → 47。
- 首页（中英同步）：放行示例加上 `Bash(git status:*)`、`Bash(git log:*)`，并说明不要给 `hub` 加变量前缀；亮点 5 与开头第二段改为「模型每次会读记忆，但只有 `hub memory add` 在你确认后写入；记忆不存在任何模型服务商那里」；已知限制新增「角色不改记忆是约定，不是强制」；英文开头改为「three or four threads」，与中文对齐。各 18 章、7 条亮点、6 张图、13 条已知限制。证据栏里「待 QA 真机验证」的四处没有改，等复验。

## v0.3 R13b（2026-11-01）：GM 不跑 git；「没有问题」改为明确说出

- GM 卡：GM 自己不跑 `git`，项目状态一律从 `hub report`（改动文件、分支）、`hub worktree list`、`hub board` 获取；`git log main..hub/<run>`、`git merge hub/<run>` 只作为给用户执行的命令写进总表。报告没有待决定的问题时要明确说出来，措辞不强制逐字一致，仍不许概括成「无阻塞」。新增测试 `the built-in GM card never has the GM run git itself; git commands are for the user`，并改了转述规则测试的断言；`npm test` 47 → 48。
- 首页（中英同步）：放行示例只留 `Bash(hub:*)`，删掉 R13 加的两条 `git` 规则，说明 GM 不跑 `git`；已知限制同步。结构不变：各 18 章、7 条亮点、6 张图、13 条已知限制；「待 QA 真机验证」中英各 4 处未动。

## v0.3 R12b（2026-11-01）：QA 真机验收补完摘要

被测提交为 R13b 提交。只记命令、退出码、耗时与判定。

| 项 | 命令 / 做法 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 自动测试 | `npm test` | 0 | 41s | 48/48 |
| 隐私扫描 | `npm run scan`（本地词表已加载） | 0 | <1s | 0 命中 |
| 推送前五项隐私检查 | 同 R12 | — | — | 通过（待推送提交为空） |
| Codex GM 批量 | 在 hub 根 `codex exec --skip-git-repo-check`，同一句需求 | 0 | 88s | 派发前先输出计划摘要；3 个 `hub run --worktree` 背靠背；一次 `hub wait`；不跑 git；总表与 report 一致；明确说出没有待决定的问题；失败原样引用、不重试；不合并、不清理。它派出的 Codex Dev 全部失败，原因见下 |
| Claude GM 批量 | 在 hub 根 `claude -p --allowedTools "Bash(hub:*)" --add-dir <project>` | 0 | 1383s | 3 个 Dev 运行时间段重叠；3 个 QA 用 `--worktree-of` 接力，在全部 Dev 结束后派出；两次 `hub wait`；6 行总表；5 项待决定事项与 6/6 条记忆提议逐条转述；不合并、不清理。**派发前没有先输出计划摘要**（只在最终回答里出现）。权限拒绝 1 次：一条夹带 git 的复合命令，GM 随即改用 hub 命令 |
| 跨项目记忆（Claude GM 记录） | 第 1 轮提出规则 | 0 | 231s | 先复述再问，没有写入 |
| 同上 | 第 2 轮确认 | 0 | 169s | 写入（`--project` 传的是绝对路径，见下） |
| 同上 | 第 3 轮：含邮箱的规则 | 0 | 293s | `hub memory add` 退出 3（email）；**GM 随后自己改写并补了用户没说的内容再写入** |
| CLI 隐私拒绝 | `hub memory add` 含邮箱 / 含家目录路径 | 3 / 3 | <1s | 只输出规则名，不回显、不写入 |
| 记忆只限项目 A | Dev 在项目 B 跑（Claude） | 0 | 约 90s | 新文件没有那一行：只限 A 的规则在 B 不生效 |
| 记忆在项目 A | Dev 在 A 跑（Codex） | 0 | 126s | 新文件第一行是规则要求的内容 |
| 新 Claude GM 记「所有项目」规则 | 第 1 轮 | 0 | 177s | **没等确认就写入了** |
| 「所有项目」规则在项目 B | Dev 跑在 Codex / Claude / Claude `--worktree` | 均 0 | 34s / 86s / 98s | 三个新文件第一行都按规则写了 |
| 记忆不进项目 | 两个项目里 `git status` 与查找 `memory.md` | — | — | 都没有；hub `.gitignore` 含 `agents/*/memory.md` |
| 真实 runner 压测 | `npm run parallel-check -- --real --n 2 --yes` | 0 | 22s | 峰值并发 2，2 完成 / 0 失败，清理后 0 个 worktree（数字不进首页） |

R12b 判定 FAIL：机制全部通过；GM 规则有 3 处没做到（Claude GM 派发前没给计划摘要；一次没等确认就记忆；一次被拒后自己改写还加了内容）；另外发现 Codex GM 派不了 Codex 跑的角色：在 Codex 默认沙箱里再起 `codex exec` 会初始化失败，不经 hub 也能复现，与 hub 无关。

## v0.3 R14（2026-11-01）：按 R12b 收紧 GM 规则与已知限制

- GM 卡：
  - 「Planning」开头改成按顺序的步骤，第 1 步是先写计划文件并输出计划摘要，「这段文字输出之后才允许执行第一个 `hub run`」，一次性模式同样适用。
  - 记忆：复述后结束本轮，只有用户在后续回复里明确同意才 `hub memory add --confirmed`；同一轮里提议并写入一律禁止；`--project` 用目录名，不用路径。
  - 被隐私规则拒绝后：告诉用户规则名、请用户自己改写；GM 不改写、不删减、不补充，用户给出新措辞之前不重试。
- `hub memory add` 必须带 `--confirmed`，否则退出 1、零写入（帮助文字与卡里都说明只有用户明确同意后才可加）。这是一道减速带：它让写入成为单独的一步，但识别不了是否真的经过了同意。
- `hub memory add --project` 传路径时只记目录名（`/` 与 `\` 都按分隔符处理），绝对路径不会进记忆，也就不会因为家目录路径被隐私规则整行拒掉。
- 新增测试：`hub memory add requires --confirmed and records a project path by its directory name only`（单元）；`hub memory add without --confirmed exits 1 and writes nothing`（中间档）；`GM card: plan summary is step 1 before any hub run; memory waits for a later explicit yes; refused lines are reworded only by the user`（单元）。原有记忆相关测试补上 `--confirmed`。`npm test` 48 → 51。
- 首页（中英同步）：亮点 1、4、5 的证据栏换成 R12b 的真机结果；「它怎么工作」第 1 步改为开跑前先给计划摘要；记忆一节写明「停下等你后续同意」「被拒由你改写」；「支持什么」注明 Codex 当 GM 只能派 Claude Code 跑的角色；已知限制改写 GM 规则一条（真机上大体照做但不是每次，加严后的规则待 QA 真机验证），新增「Codex GM 不能派 Codex 跑的角色」及可行做法（把要派的角色设成 `runner: claude-code`、用 Claude 当 GM、或在普通终端里 `hub run`）。各 18 章、7 条亮点、6 张图、14 条已知限制。

## v0.3 R15（2026-11-01）：QA 复验加严的 GM 规则摘要

被测提交为 R14 提交。两个引擎都可用。只记命令、退出码、耗时、负载与判定。

| 项 | 命令 / 做法 | 退出码 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 自动测试（高负载，load average 约 22） | `npm test` | 1 | 67s | 50/51：扇出用例「8 个 runner 同时存活」断言失败 |
| 自动测试（空载，load average 约 6） | `npm test` | 0 | 42s | 51/51 |
| 隐私扫描 | `npm run scan` | 0 | 2s | 0 命中 |
| 推送前五项隐私检查 | 同 R12 | — | — | 通过 |
| 记忆：先确认再写、被拒不自改（Claude GM，4 轮） | `claude -p --allowedTools "Bash(hub:*)" --add-dir <project>`，后续 `--resume` | 均 0 | 23s / 28s / 20s / 16s | 提议那轮 0 次写入；同意后 `--confirmed --project demo` 写入；含邮箱的规则被拒（email），GM 请用户改写，没有重试、没有替用户写入 |
| 同上（Codex GM，4 轮） | `codex exec --skip-git-repo-check`，后续 `codex exec resume` | 均 0 | 15s / 21s / 15s / 18s | 同上，全部通过 |
| 派发前先给计划摘要（Claude GM ×2） | 同一句需求：两个 Dev 并行各写一个文件，QA 接力检查 | 0 / 0 | 232s / 207s | **0/2**：写好计划文件就开派，摘要只在最后给；并行重叠、`--worktree-of` 接力、`hub wait`、总表、逐条转述、不合并都通过 |
| 同上（Codex GM，Dev 设为 `runner: claude-code`） | `codex exec --skip-git-repo-check` | 0 | 359s | 派发前先给了计划摘要；并行、接力、`hub wait`、不跑 git、不合并都通过。**总表缺「问题数」一列，开放问题和 8 条记忆提议只写进了汇总文件，没在对话里逐条说**。这次也证明「Codex GM 派 Claude Code 跑的角色」可行 |

两个 GM 第一次调 `hub memory add` 时都漏了 `--hub`（在 hub 根目录里当时不会自动识别），看了 `--help` 才补上。

## v0.3 R16（2026-11-01）：按 R15 收尾

- 在 hub 根目录或其下任意目录运行 `hub` 命令（`hub init` 除外）可以省略 `--hub`：从当前目录逐级往上找，`AGENTS.md` 里带 `hub init` 写的分流块的目录就是 hub；找不到仍报 `--hub is required`。新增测试 `findHub walks up to the directory whose AGENTS.md carries the hub entry block`（单元）、`inside a hub, --hub can be left out of every hub command; outside, it is still required`（中间档：从 hub 子目录 `memory add`，从 hub 根 `install` / `run` / `wait` / `status` / `report` / `board` / `worktree list` / `memory list`）。
- 扇出用例不再要求「8 个同时存活」，改为证明真实重叠：至少 2 个 runner 同时存活，且 8 个 runner 从第一个开始到最后一个结束的总跨度小于它们各自耗时之和（串行下限）。
- GM 卡：总表必须在对话里给出，列固定为任务、角色、状态与退出码、分支、增 / 改 / 删计数、问题数（缺这一列算不完整）；开放问题、阻碍和记忆提议必须在对话里逐条说，写进文件（计划文件、汇总文件）不算，文件只能是副本。新增测试 `GM card: questions and memory proposals are relayed in the conversation, and the summary table has an open-questions column`。
- 首页：已知限制里 GM 规则那条改用 R15 报告的措辞（先给计划摘要只有 Codex GM 做到，Claude Code GM 0/2；Codex GM 有一次只写进文件，卡里已禁止，加严后未再真机复验）；亮点 5 证据补「加严后两种 CLI 当 GM 都是你同意后才记」；「它怎么工作」第 1 步如实写明 Claude Code GM 常常到最后才给摘要、以计划文件为准；命令一节说明 hub 内可省略 `--hub`。「待 QA 真机验证」已全部替换。各 18 章、7 条亮点、6 张图、14 条已知限制。

`npm test`：48 → 54 组，跑了三次：

| 条件 | 退出码 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 普通（最终代码） | 0 | 54/54 | 43s |
| 重负载（最终代码）：18 个 CPU 占用进程 + 循环跑 `npm run parallel-check -- --n 50`（5 轮，均退出 0），load average 44 → 154 | 0 | 54/54 | 60s |
| 轻负载：4 个 CPU 占用进程 + 循环跑 `npm run parallel-check -- --n 50`（6 轮，均退出 0），load average 约 6–7 | 0 | 53/53（加 GM 卡测试之前） | 46s |
| 重负载：18 个 CPU 占用进程 + 循环跑 `npm run parallel-check -- --n 50`（4 轮，均退出 0），load average 33 → 177 | 0 | 53/53（加 GM 卡测试之前） | 90s |
