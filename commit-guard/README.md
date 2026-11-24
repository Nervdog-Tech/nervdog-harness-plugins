# @local/nervdog-commit-guard

DeepSeek Harness Host 插件：在主会话即将结束回合（`agent/turn-stopping`）前做两项收尾守卫：

1. **未提交文件守卫（`commitGuard`）**
   - 通过 `tools/result` 与会话日志跟踪本会话（含子代理）通过文件编辑工具改动过的文件。
   - 回合将结束时，对改动文件所属的每个 git 仓库执行 `git status --porcelain -z`，只比对本会话动过的文件（不会混入共用工作区里别人未提交的改动）。
   - 若仍有未提交文件，通过 `agent.steer()` 在同回合内转向提醒代理：已完成则按 pathspec 提交并附短 SHA，若用户要求暂不提交则明确标明「未提交（仅本地修改）」。
   - 同一组脏文件指纹每回合最多转向一次，避免死循环。

2. **推送后 CI 守卫（`ciGuard`）**
   - 仅当目标仓库存在 `.claude/scripts/ci-wait.js` 且本会话执行过 `git push` 时启用。
   - 回合将结束时调用 `ci.look(sha, pushedAt)`；若 Continuous 仍在运行或变红，通过 `agent.steer()` 要求等待/修复（每次推送最多拦截 `maxCiSteersPerPush` 次）。
   - 任何 git 或网络错误均 fail-open，不会卡死会话。

## 配置项（`cordis.patch.yml`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `commitGuard` | `true` | 是否启用未提交文件守卫 |
| `ciGuard` | `true` | 是否启用推送后 Continuous CI 守卫 |
| `maxCommitSteersPerTurn` | `2` | 单回合最多因未提交文件转向几次 |
| `maxCiSteersPerPush` | `2` | 单次推送最多因 CI 未绿转向几次 |
| `gitTimeoutMs` | `5000` | 单次 git 命令超时（毫秒） |
