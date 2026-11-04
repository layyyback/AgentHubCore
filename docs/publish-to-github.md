# 发布到 GitHub

AgentHubCore 不会替你创建远端或推送。

## 发布前检查

```bash
npm test
npm run scan          # 本地读 .local/scan-patterns.txt（不进 Git）里的专属词表
node bin/hub.mjs roles build --hub . && git diff --exit-code agents/
git status --short
git diff --check
```

`npm run scan` 只扫当前被跟踪的文件。历史提交、提交信息、作者、分支名和 tag 也会随推送公开，推送前另行检查（例如对 `git rev-list --all` 逐个提交用同一词表做 `git grep -c`，只看计数不看原文）。再人工检查：示例是否只用占位符；`docs/testing.md` 是否只有会话号前 8 位。许可证为 MIT（见 `LICENSE`）。

推送后在 GitHub 仓库设置里添加 Actions Secret `HUB_SCAN_PATTERNS`（逗号分隔的正则），CI 的扫描步骤才会带上专属词表；没有它时只跑通用规则，并在日志里说明。公开仓库后，历史里的秘密无法靠删除当前文件彻底移除，发现凭据应先轮换再清理历史。

## 用 GitHub CLI

先在本地完成提交，然后在仓库根运行：

```bash
gh auth status
gh repo create <owner>/<repo> --public --source . --remote origin --push
```

如需先私有复核，把 `--public` 改为 `--private`，确认后再在 GitHub 设置中公开。

## 手动添加远端

先在 GitHub 网页创建一个空仓库，不要勾选自动生成 README、LICENSE 或 `.gitignore`，然后：

```bash
git remote add origin <git-remote-url>
git push -u origin main
```

推送前可用 `git remote -v` 再核对目标；本项目的交付过程只做本地提交，不执行以上远端操作。
