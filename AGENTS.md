# AGENTS.md

本文件适用于仓库根目录及全部子目录。

## 项目目标

本项目是 OMP `models.yml` 的本地 Web 管理器。实现必须保持 OMP 原生配置语义，不得引入只有本项目能理解的持久化格式。

优先级：

1. 凭证安全和配置正确性；
2. 与 OMP 当前模型/Provider schema 兼容；
3. 保留 YAML 注释和用户已有配置；
4. 简单、无构建链的本地运行体验；
5. UI 便利性。

## 技术栈

- Bun + TypeScript 后端；
- `Bun.serve` HTTP 服务；
- 原生 HTML、CSS、JavaScript 前端；
- `yaml` 负责 YAML AST 读写；
- `bun:sqlite` 只读访问 OMP 模型缓存；
- `bun:test` 测试。

除非需求无法用现有栈可靠完成，不要引入 React、前端框架、打包器、CSS 框架、CDN 依赖或新的运行时包。

## 代码结构

- `src/config-store.ts`：配置路径、YAML AST、凭证脱敏、`.env`、修订号、锁和原子写入。
- `src/discovery.ts`：兼容端点发现、OMP Registry 元数据补全和回退。
- `src/probe.ts`：Endpoint、认证、发现和可选推理检查。
- `src/server.ts`：HTTP 路由、输入校验、静态资源。
- `public/app.js`：浏览器状态、Provider 表单、模型目录、模型编辑和同步。
- `test/`：可观察行为和安全边界测试。

## 不可破坏的安全约束

- 服务必须只绑定 `127.0.0.1`。
- 普通 API、日志和测试快照不得包含已保存 API Key；仅允许用户主动操作触发的 `POST /api/providers/:id/api-key` 返回可解析值，且响应必须 `no-store`。
- 已保存 Provider/模型 Header 必须以 `__OMP_MODELS_WEBUI_SECRET__` 返回。
- 浏览器提交哨兵值时必须恢复磁盘原值，不能把哨兵写入最终配置。
- 新 API Key 必须写入相邻 `.env`，文件模式为 `0600`；YAML 只保存环境变量引用。
- 不得执行 `!command` API Key 或 Header resolver；显式读取端点必须拒绝不可解析的命令凭证。
- 发现候选必须保持与用户 Base URL 同 Origin。
- 网络请求必须保持超时和响应大小限制。
- `/api/discover` 与 `/api/probe` 必须保持独立。

涉及这些约束的改动必须添加或更新回归测试。

## 配置写入约束

- 写入前检查 `models.yml + .env` 组合修订号。
- 保持锁文件串行化、陈旧锁恢复和原子重命名。
- 使用 YAML 节点级修改；不要通过普通对象完整重写用户文件。
- 保留未知但合法的 Provider/模型字段，避免前端编辑导致字段丢失。
- 已有模型显式配置优先于 OMP Registry；Registry 只补齐缺失字段。
- 模型级 `api` 和 `baseUrl` 必须保留，以支持同 Provider 混合协议。

## 模型目录语义

区分三个概念：

1. 当前 `models.yml` 中已配置模型；
2. 远程或 OMP Registry 发现的可选目录；
3. 用户在当前页面的选择和自定义对象。

“更新 models.yml”只写入已选模型。未选模型可从 YAML 排除，但不应立即从当前页面目录消失。重新发现时，应保留尚未保存的手动模型、自定义参数和选择状态。

## UI 约束

- 已配置 Provider 被选中后立即显示当前模型，不要求先发现。
- 自动发现失败时仍可手动添加模型 ID 和名称。
- 已选模型必须能编辑常用字段，并能通过完整模型 JSON 编辑高级字段。
- 自动元数据、回退来源和可能产生费用的推理检查必须明确标注。
- UI 改动必须在真实浏览器中执行对应流程验证；单元测试不能替代浏览器验证。

## 开发命令

```bash
bun install
bun run dev
bun run start
bun run check
```

`bun run check` 必须在提交前通过：

```bash
bun test
bunx tsc --noEmit
```

不要通过放宽类型、删除断言或隐藏错误来让检查通过。

## 测试原则

测试可观察合约，而不是源代码文本：

- 修订冲突和原子写入；
- YAML 注释/未知字段保留；
- 普通 API 不泄露 API Key，Header 始终脱敏；
- 显式 API Key 读取仅支持环境变量和相邻 `.env`，且不执行 `!command`；
- 发现路径、认证回退和 Registry 元数据投影；
- 模型级 API、Thinking、Compat 等高级字段持久化；
- `/api/discover` 与 `/api/probe` 的独立行为。

测试必须使用隔离目录，不得修改真实 `~/.omp/agent/models.yml`。

## 风格

- 优先小而直接的修改，复用现有函数和 DOM 模式。
- 不做与当前任务无关的重构或格式化。
- 面向用户的界面文案使用简体中文；代码标识符、API 字段和提交信息使用英文。
- 保持依赖最少，避免可省略的对象复制、重复网络请求和大响应读取。
- 新功能应同步更新 `README.md` 中的行为、限制和使用方式。

## OMP 兼容来源

以 OMP 官方文档和实际安装版本为准：

- https://github.com/can1357/oh-my-pi/blob/HEAD/docs/models.md
- https://github.com/can1357/oh-my-pi

OMP schema 变化时，应先更新输入校验、Registry 投影、编辑器字段和测试，再更新文档。
