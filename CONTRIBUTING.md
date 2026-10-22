# 贡献指南

欢迎。这个项目刻意保持小：**一个检索引擎 + 一个协议壳**，不追求成为
记忆系统的全家桶。提 PR 前先确认你的想法和这个定位一致。

## 环境

Node ≥ 18，无任何 npm 依赖，克隆即开发。

## 提交前

```bash
node --test tests/engine.test.mjs tests/state.test.mjs tests/search.test.mjs engine/ingest.test.js   # 全绿
node scripts/audit.mjs                                    # 脱敏零命中
```

## 约定

- **纯函数进 `engine/lib.mjs`**，编排进 `engine/core.mjs`，IO/CLI 在
  `surface.mjs`、`ingest.mjs`、`mcp/server.mjs` 与 `hooks/`——测试跟着纯函数走
- 新功能必须带测试（node:test）；修 bug 先写复现测试再修
- 提交信息用中文或英文均可，格式：`type(scope): 摘要`
- 遵守 [行为边界](SECURITY.md)——逆向/绕过类用途的 PR 与讨论不受欢迎

## 不接受的贡献方向（与项目定位冲突）

- 向量库/嵌入模型/图数据库依赖（违背纯本地铁律）
- 任何形式的"自动改写记忆"（违背只浮线索哲学）
- 遥测、账号系统、云同步
