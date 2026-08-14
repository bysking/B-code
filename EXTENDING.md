# 扩展 b-code —— 三步模板

> 内核（`agent.ts` 主循环）一旦稳定几乎不改。任何新能力 = **实现一个接口 + 注册一行**。
> 本文档是"加东西"的施工手册；接口定义集中在 `src/types.ts`。

## 0. 地图

```
agent.ts 主循环（L2 内核——不动）
   │  通过 registry.resolve(name) 拿工具
   │  通过 ModelBackend.call() 拿模型回复
   │  通过 PermissionPolicy.check() 放行/拦截
   ▼
能力层：Registry（工具/MCP/子Agent/Plan 全挂这里）
基础设施：backend / permissions / context / memory（各是 1 接口 + N 实现）
```

## 1. 加一个新能力（工具）

**三步：**

```ts
// ① 实现 handler（src/tools.ts 或新文件）
import { registry } from "./bootstrap"; // 或传入的 registry
registry.register({
  name: "my_tool",
  description: "Do my thing.",
  inputSchema: { type: "object", properties: { /* ... */ }, required: [] },
  mode: "read",            // read=放行 / write|shell=需确认 / external=未知权限默认确认
  handler: async (input) => "done",
});
```

| 步 | 做什么 |
|----|--------|
| ① | 实现/包装一个 async `(input) => string` 函数 |
| ② | `registry.register({...})` 一行（名称/描述/schema/mode/handler） |
| ③ | `pnpm typecheck && pnpm test` |

> **MCP 工具不需要第 ① 步**：`.claude/mcp.json` 加个 server，启动自动前缀注册 `mcp__server__tool`，模型立即可用（零代码扩展）。

## 2. 换一个模型后端 / 加一个新 Provider

**三步：**

```ts
// ① 实现接口（src/backend.ts 内新增类）
import { ModelBackend, ModelInput, ModelOutput } from "./types.js";
export class MyBackend implements ModelBackend {
  readonly kind = "mine";
  async call(input: ModelInput): Promise<ModelOutput> { /* 调你的 API，归一成 Anthropic 形状 */ }
}

// ② 注册选择（createBackend 里加分支；env 切换）
export function createBackend(): ModelBackend {
  if (process.env.MY_API_KEY) return new MyBackend();
  return useOpenAI() ? new OpenAIBackend() : new AnthropicBackend();
}
```

| 步 | 做什么 |
|----|--------|
| ① | 实现 `ModelBackend`（1 方法 `call`），返回归一化为 Anthropic content 形状 |
| ② | `createBackend()` 按 env 加分支 |
| ③ | `pnpm dev "hello"` 冒烟 + 回归 |

## 3. 换记忆 / 上下文 / 权限策略

**三步（同类）**：

```ts
// 记忆：实现 Memory 接口（src/types.ts）
import { Memory } from "./types.js";
export class VectorMemory implements Memory {
  save(...) { /* 向量库写入 */ }
  recall(query, limit, cwd) { /* 向量召回 */ }
  dir(cwd) { return "..."; }
}
```

| 步 | 做什么 |
|----|--------|
| ① | 实现接口：`Memory` / `ContextPolicy` / `PermissionPolicy`（各 1-2 个方法） |
| ② | 在引用点替换默认实现（`new FileMemory()` → `new VectorMemory()`） |
| ③ | 回归 + 行为验证 |

现有实现作参考：`FileMemory`（memory.ts）、`TruncateContext`（context.ts）、`rulePermission`（permissions.ts）。

## 4. 加一个技能（零代码）

```markdown
.claude/skills/my-skill.md:
---
name: my-skill
description: 一句话说清什么时候用
user-invocable: true
---
技能正文…… 用户请求: $ARGUMENTS
```

搜索链：项目 `.claude/skills` > `$B_CODE_SKILLS_DIR` > `$B_CODE_HOME/skills` > `~/.claude/skills`。
写文件即生效，`/my-skill 参数` 即用。

## 5. 完成后必跑

```bash
pnpm typecheck && pnpm test          # 契约与回归
pnpm dev "冒烟指令"                    # 端到端
```

> **写完 EXTENDING.md 本身暴露了一个事实**：加能力最贵的不再是代码，而是"描述清楚干什么 + 权限 mode 想清楚"——这两样写对了，其余全是模板。