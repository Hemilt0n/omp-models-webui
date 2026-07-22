# OMP Models Web UI

一个面向 [OMP（Oh My Pi）](https://omp.sh/) 的本地 `models.yml` 配置管理器。

它把 Provider、凭证、模型发现、模型级参数和连接自检集中到一个轻量 Web UI 中，同时保持 OMP 原生配置语义：界面最终读写的仍然是 `~/.omp/agent/models.yml`，不会引入专有配置格式或后台数据库。

它既能作为独立 Web 服务运行（`bun run start`），也可以安装为 OMP 插件，在 OMP 会话中通过 `/models-ui` 命令启动（见[作为 OMP 插件运行](#作为-omp-插件运行)）。两种形态共用同一套配置、发现和安全逻辑。

> 本项目默认只监听 `127.0.0.1`。它是本地管理工具，不应直接暴露到公网。

## 项目定位

OMP 的 `models.yml` 能表达 Provider 覆盖、自定义模型、模型级 API、Thinking、Compat、Header 和远程压缩等高级能力，但手工维护复杂 YAML 容易出现以下问题：

- API Key 或 Header 意外写入不安全的位置；
- Provider 的模型列表端点不标准，自动发现经常失败；
- 同一个网关中的模型可能分别使用 OpenAI 和 Anthropic 协议；
- Registry 已有的 `contextWindow`、Thinking、Compat 信息没有被复用；
- 手写复杂模型对象容易丢字段、重复 ID 或覆盖他人修改。

本项目的总体目标是：

1. **以 OMP 为事实来源**：优先复用 OMP Registry 和 `models.yml`，不维护第二套模型规范。
2. **安全管理凭证**：普通 API 不返回已保存凭证明文；仅在用户主动点击眼睛时显式读取 API Key，Header 始终脱敏。
3. **允许自动与手动并存**：自动发现失败时仍可手动添加模型；自动数据不完整时可以继续编辑。
4. **覆盖高级模型配置**：常用字段提供结构化表单，完整模型 JSON 保留 OMP 的全部高级能力。
5. **可预测地写回 YAML**：使用修订号、锁文件和原子写入，尽量保留 YAML 注释与节点结构。

## 核心能力

### Provider 管理

- 新建、编辑、删除 Provider；
- 支持 OMP 当前的八种 Provider API：
  - `openai-completions`
  - `openai-responses`
  - `openai-codex-responses`
  - `azure-openai-responses`
  - `anthropic-messages`
  - `google-generative-ai`
  - `google-gemini-cli`
  - `google-vertex`
- 可编辑 `authHeader`、`headers`、`disableStrictTools` 等常用 Provider 字段；保存时保留现有 `auth`、`compat`、`modelOverrides`、`remoteCompaction` 等高级 Provider 配置；
- 已配置 Provider 选中后立即显示当前 `models.yml` 模型，不要求先执行发现。

### 模型发现

模型发现与连接自检是两个独立流程：

- `POST /api/discover`：获取用于配置的模型目录；
- `POST /api/probe`：执行 Endpoint、认证、发现和可选推理检查。

发现流程会在同一 Origin 内尝试常见兼容路径：

- `<baseUrl>/models`
- 去掉 `/messages`、`/chat/completions` 或 `/responses` 后的 `/models`
- 去掉 `/anthropic` 或 `/coding` 后的 `/models`
- `/v1/models`
- `/models`
- Ollama、LiteLLM 等专用端点

远程失败后依次回退到：

1. OMP 模型 Registry；
2. 当前 `models.yml` 中已配置的模型。

界面会明确标记结果来自远程、OMP Registry 还是当前配置，不会把回退伪装成远程成功。

### OMP 元数据复用

远程 `/models` 经常只返回模型 ID。本项目会使用 OMP 的模型缓存补全：

- `api`
- `baseUrl`
- `contextWindow`
- `maxTokens`
- `reasoning`
- `thinking`
- `cost`
- `compat`
- `remoteCompaction`

合并优先级为：

1. 用户在当前界面中的编辑；
2. 当前 `models.yml` 的显式配置；
3. OMP Registry 元数据；
4. 手动添加时的可编辑默认值。

因此已有的定制参数不会被 Registry 覆盖，而 Registry 可以补齐当前配置缺失的信息。

### 手动添加和模型参数编辑

自动发现失败时，可以点击“手动添加模型”，填写模型 ID 和名称。手动模型的初始回退值为：

```yaml
contextWindow: 128000
maxTokens: 8192
reasoning: false
input: [text]
```

这些值只是可编辑起点，不代表服务端真实限制。

已选模型旁边提供“配置”按钮。常用字段有结构化控件：

- 模型级 `api` 和 `baseUrl`
- `contextWindow`、`maxTokens`
- `reasoning`、`supportsTools`
- `thinking.mode`
- `thinking.efforts`
- `thinking.defaultLevel`
- `thinking.effortMap`

“完整模型 JSON”可编辑 OMP 支持的其他字段，例如：

- `cost`
- `premiumMultiplier`
- `omitMaxOutputTokens`
- `headers`
- `compat`
- `contextPromotionTarget`
- `compactionModel`
- `remoteCompaction`

上方结构化字段会覆盖完整 JSON 中的同名值。旧式 `thinking.minLevel` / `thinking.maxLevel` 会在编辑器中展开为 Effort 列表。

### 同一 Provider 的混合 API

OMP 支持模型级 `api` 和 `baseUrl`。因此同一个 Provider 可以同时包含 OpenAI-compatible 和 Anthropic 模型：

```yaml
providers:
  gateway:
    baseUrl: https://gateway.example/v1
    api: openai-completions
    apiKey: GATEWAY_API_KEY
    models:
      - id: openai-model
        api: openai-completions
        baseUrl: https://gateway.example/v1
        contextWindow: 128000
        maxTokens: 8192

      - id: anthropic-model
        api: anthropic-messages
        baseUrl: https://gateway.example/anthropic
        contextWindow: 200000
        maxTokens: 8192
```

这适用于 `opencode-go` 一类网关：大多数模型走 OpenAI-compatible，而个别模型走 Anthropic Messages。

### 模型选择和同步

- 搜索模型；
- 单独勾选；
- 全选或全不选；
- 未勾选模型从 `models.yml` 排除，但保留在当前页面目录中，可以重新勾选；
- 重新打开页面后可再次执行“发现模型”恢复完整目录；
- 同步固定显式 `models` 数组，并移除运行时 `discovery`，避免 OMP 在运行时重新加入被排除模型。

## 安全模型

### API Key

新 API Key 不直接写入 YAML，而是：

1. 写入 `models.yml` 相邻的 `.env`；
2. `.env` 权限设为 `0600`；
3. YAML 只保存环境变量名。

环境变量名直接包含大写 Provider ID；分隔符分别编码为 `_DOT_`、`_DASH_` 和 `_UNDERSCORE_`，既便于辨认，也避免 `foo.bar`、`foo-bar`、`foo_bar` 发生碰撞。例如 `my-gateway.prod_v2` 对应 `OMP_CUSTOM_MY_DASH_GATEWAY_DOT_PROD_UNDERSCORE_V2_API_KEY`。表单会显示当前读取的环境变量名，以及用户输入新 Key 后将写入的目标环境变量名。

已配置的 API Key 输入框默认显示掩码点，不再使用空值提示表达配置状态。只有用户点击输入框旁的眼睛按钮时，页面才会通过显式 `POST` 请求读取当前值；该值优先来自服务进程中的对应环境变量，其次来自 `models.yml` 相邻的 `.env`。普通 Provider 列表和保存响应不会携带明文，所有响应均禁止缓存。隐藏按钮只改变当前页面中的显示状态，已读取的值仍存在于当前页面 DOM 中，因此不要在不受信任的设备上操作或在显示时共享屏幕。

显示既有 Key 不会把它当成用户修改，也不会在保存时改写凭证。只有用户实际编辑 API Key 输入框时，保存请求才携带新值，并继续使用上述 `.env` 与 YAML 引用分离存储。

### Header

Provider 和模型级 Header 在返回浏览器前统一替换为：

```text
__OMP_MODELS_WEBUI_SECRET__
```

保存时，该哨兵值会恢复为磁盘中的原值。浏览器不会收到已保存 Header 的明文。

### `!command` 凭证

OMP 可以通过 `!command` 动态解析凭证。本项目不会执行这些命令，因为 Web UI 不应静默执行任意本地程序。此类 API Key 无法通过眼睛按钮显示；认证检查会标记为无法确定，而不是错误地报告密钥无效。

### 文件一致性

- `models.yml` 与相邻 `.env` 共同计算修订号；
- PUT 请求必须携带当前修订号；
- 写入由相邻锁文件串行化；
- 支持陈旧锁恢复；
- 使用临时文件和原子重命名写入；
- 尽量保留 YAML 注释和已有节点。

## 安装与运行

### 前置要求

- [Bun](https://bun.sh/) 1.3 或更新版本；
- 已安装并配置 [OMP](https://omp.sh/)；
- 本地存在或准备创建 OMP agent 配置目录。

### 启动

```bash
git clone https://github.com/Hemilt0n/omp-models-webui.git
cd omp-models-webui
bun install
bun run start
```

打开：

```text
http://127.0.0.1:4380
```

开发模式：

```bash
bun run dev
```

### 环境变量

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MODELS_WEBUI_PORT` | `4380` | 本地监听端口 |
| `MODELS_YML_PATH` | `${PI_CODING_AGENT_DIR}/models.yml` | 显式指定配置文件 |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | OMP agent 配置目录 |

示例：

```bash
MODELS_WEBUI_PORT=4390 \
MODELS_YML_PATH="$PWD/.local/models.yml" \
bun run start
```

服务器始终绑定 `127.0.0.1`，环境变量不能将其改为公网地址。

## 作为 OMP 插件运行

本项目在 `package.json` 中声明了 `omp.extensions` 入口（`src/plugin.ts`），因此可作为 OMP 扩展安装。插件是现有 Web 服务的“薄壳”：只负责命令注册、服务生命周期和会话退出清理，不复制任何配置、发现或安全实现。OMP 退出时，由插件启动的服务会被关闭；独立 `bun run start` 启动的进程不受影响。

### 安装

从本地仓库链接（开发或本地使用，推荐）：

```bash
cd omp-models-webui
omp plugin link .
```

从 Git 安装：

```bash
omp plugin install github:Hemilt0n/omp-models-webui
```

安装后重启 OMP，使用 `/models-ui` 即可发现命令。用 `omp plugin list` 确认已安装并启用。

### 启动与控制

在任意 OMP 会话中：

```text
/models-ui            启动（或复用）本地管理服务并打开浏览器
/models-ui 4390       使用 4390 作为首选端口启动
/models-ui status     查看正在运行的服务地址
/models-ui stop       停止由插件启动的服务
/models-ui help       显示用法
```

行为说明：

- 默认监听 `127.0.0.1`，首选端口 `4380`；端口被占用时自动选择下一个可用端口，输出中显示实际地址。
- 重复执行 `/models-ui` 会复用已在运行的服务，不会启动多个实例。
- 服务确认监听成功后才会尝试打开浏览器；宿主无打开能力时仅输出 URL，请手动复制。
- OMP 会话退出时，插件启动的服务会被自动关闭。

### 卸载

```bash
omp plugin uninstall omp-models-webui
```

### 故障排查

- **命令不可见**：重启 OMP；运行 `omp plugin list` 确认已安装且未被禁用；查看当天日志 `~/.omp/logs/omp.$(date +%F).log` 中的扩展加载诊断。
- **端口被占用**：`/models-ui` 会自动换到下一个可用端口并在输出中显示实际地址；也可用 `/models-ui <端口>` 指定首选端口。
- **浏览器没有自动打开**：插件调用系统 `open`（macOS）或 `xdg-open`（Linux）打开 URL，调用失败时仅输出地址。手动复制地址访问即可。
- **服务没有随会话退出关闭**：确认该服务是通过 `/models-ui` 启动的（受插件生命周期管理），而非独立 `bun run start`（独立进程，不在插件控制范围内）。
- **仍想用独立方式**：`bun run start` 不受影响，继续按[安装与运行](#安装与运行)的说明使用。

## 推荐工作流

1. 选择已有 Provider，检查当前已配置模型。
2. 点击“发现模型”，让远程端点和 OMP Registry 补全模型目录。
3. 勾选需要的模型。
4. 对已选模型点击“配置”，检查 API、Base URL、Token 上限和 Thinking 参数。
5. 自动发现失败时使用“手动添加模型”。
6. 点击“更新 models.yml”。
7. 必要时运行自检；推理检测默认关闭，因为真实请求可能产生费用。
8. 在 OMP 中运行 `omp models <provider> --json` 确认最终解析结果。

修改真实配置前建议自行备份 `models.yml`。

## 实现方式

项目刻意保持依赖和部署简单：

- 后端：`Bun.serve`
- 前端：原生 HTML、CSS、JavaScript
- YAML：[`yaml`](https://eemeli.org/yaml/)
- 模型缓存：Bun 内置 SQLite，只读访问 OMP `models.db`
- 测试：`bun:test`
- 类型检查：TypeScript

没有 React、前端构建链、CDN、图标库或图表依赖。

### 目录结构

```text
public/
  index.html       页面结构和模型编辑器
  app.js           Provider、发现、选择、编辑和同步交互
  styles.css       本地 UI 样式
src/
  config-store.ts    YAML/.env 脱敏、修订、锁和原子写入
  discovery.ts       多端点发现、OMP Registry 补全和回退
  probe.ts           分层连接与可选推理检查
  server.ts          Bun HTTP API、校验、静态资源和端口选择
  plugin.ts          OMP 扩展入口，注册 /models-ui 命令与服务生命周期
  omp-extension.d.ts OMP 扩展 API 的本地类型声明
test/
  *.test.ts          配置、安全、发现、Probe、API 与插件生命周期测试
```

### HTTP API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/providers` | 读取脱敏 Provider 快照和修订号 |
| `PUT` | `/api/providers/:id` | 创建或更新 Provider |
| `DELETE` | `/api/providers/:id` | 删除 Provider |
| `POST` | `/api/providers/:id/api-key` | 用户显式操作时读取可解析的 API Key |
| `POST` | `/api/discover` | 获取可选择模型目录 |
| `POST` | `/api/probe` | 执行分层连接检查 |

所有 API 响应均使用 `Cache-Control: no-store`。

## 开发与验证

安装依赖后执行：

```bash
bun run check
```

等价于：

```bash
bun test
bunx tsc --noEmit
```

UI 行为修改还应在浏览器中实际完成对应流程，而不仅是运行单元测试。

## 相关资源

- [OMP 官网](https://omp.sh/)
- [OMP GitHub 仓库](https://github.com/can1357/oh-my-pi)
- [OMP `models.yml` / Provider 配置文档](https://github.com/can1357/oh-my-pi/blob/HEAD/docs/models.md)
- [OMP npm 包](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
- [Bun HTTP Server 文档](https://bun.sh/docs/api/http)
- [`yaml` 文档](https://eemeli.org/yaml/)

本项目参考 OMP 自身轻量本地工具的实现思路，但 UI 和配置工作流为独立实现。

## 许可证

[MIT](LICENSE)
