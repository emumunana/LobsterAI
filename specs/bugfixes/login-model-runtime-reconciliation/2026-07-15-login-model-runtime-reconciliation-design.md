# 登录后模型运行态同步竞态修复设计文档

## 1. 概述

### 1.1 问题

用户刚完成 LobsterAI 登录后立即发起第一轮 Cowork 对话，可能收到：

```text
model not allowed: lobsterai-server/qwen3.5-plus-YoudaoInner
```

服务端模型接口已经返回该模型且 `accessible=true`，重新启动应用后同一模型又可以正常使用。

该现象容易被误判为账户额度不足、模型权限未开通或服务端推理失败，但本次日志显示错误发生在本地 OpenClaw gateway 的 `sessions.patch` 模型校验阶段，远端 `chat.send` 和模型推理请求尚未开始。

### 1.2 影响

- 新登录、切换账号或退出后重新登录时，第一轮对话存在稳定的竞态窗口。
- 用户看到的是权限含义很强的 `model not allowed`，但实际无法通过充值、重新选择同一模型或检查网络解决。
- 手动重启应用可以恢复，导致问题看起来随机，且掩盖了真实的配置生命周期错误。
- Cowork、IM、定时任务等共用 OpenClaw 模型目录；如果它们在同一窗口内触发 session model patch，也可能遇到相同拒绝。

### 1.3 根因

当前登录后的运行态更新被拆成两个彼此独立的异步链路：

1. `auth:exchange` 保存 token、更新 quota 后，`syncOpenClawConfigIfAuthQuotaGateChanged()` 立即异步触发一次 `restartGatewayIfRunning: true` 的配置同步和 gateway 重启。
2. renderer 随后调用 `auth:getModels` 获取真实服务端模型列表；主进程更新 `serverModelMetadataCache` 后，又异步触发一次 `restartGatewayIfRunning: false` 的配置同步。

由于 `syncOpenClawConfig()` 使用串行队列，第二次模型同步会等待第一次重启完成。新 gateway 已经在等待期间读取旧配置，并使用回退模型：

```text
lobsterai-server/qwen3.5-plus
```

真实模型列表随后虽然写入了 `openclaw.json`，但这次变化只被视为可热加载，没有触发第二次受控重启。当前运行中的 gateway 因此仍保留旧模型目录和 allowlist。

首轮 Cowork 发送会等待 `waitForOpenClawConfigApply()`，但该屏障当前只代表“配置同步 Promise 已结束”，不代表“gateway 已加载包含该模型的运行态目录”。当配置同步走 `NO RESTART, hot-reload only` 分支时，屏障会在运行态仍陈旧的情况下放行。

最终，`OpenClawRuntimeAdapter` 在 `chat.send` 前执行：

```text
sessions.patch(model=lobsterai-server/qwen3.5-plus-YoudaoInner)
```

gateway 根据旧 allowlist 返回 `INVALID_REQUEST`，首轮对话失败。

### 1.4 现场证据链

2026-07-15 诊断日志的关键顺序：

```text
11:23:15.942  auth exchange 开始
11:23:16.125  auth exchange 成功
11:23:16.126  media-entitlement-changed 配置同步开始，要求 hard restart
11:23:16.318  auth:getModels 才开始请求真实模型列表
11:23:16.392  模型列表返回 200，共 18 个模型
11:23:16.396  server-models-updated 同步被加入队列
11:23:19.855  新 gateway 开始加载配置
11:23:38.363  server-models-updated 同步才开始执行
11:23:38.570  models、agents 已写盘，但判定为 NO RESTART
11:23:39.123  gateway 实际模型仍为 lobsterai-server/qwen3.5-plus
11:23:40.955  用户首轮对话开始
11:23:44.623  sessions.patch 返回 model not allowed
```

决定性事实：

- `/api/models/available` 返回成功，不是服务端 entitlement 拒绝。
- `sessions.patch` 失败发生在本地 gateway 内，没有进入远端模型推理。
- gateway 日志打印的实际 agent model 是旧回退模型。
- 重启后恢复，是因为重启进程重新读取了已经写入磁盘的正确模型目录。

### 1.5 目标

1. 登录后的真实服务端模型列表必须先于最终 gateway 启动或重启进入配置。
2. 同一次登录只执行一次有明确顺序的运行态协调，避免 quota sync 和 model sync 互相竞态。
3. 第一轮 Cowork、IM 或定时任务模型调用必须等待登录模型运行态真正完成协调。
4. 正常后台模型轮询不应无条件重启 gateway，继续避免无关中断。
5. 本地模型目录拒绝应得到可诊断、可恢复的错误，不再直接伪装成账户权限问题。

### 1.6 非目标

- 不改变用户在已有会话内通过 `sessions.patch` 切换模型的机制。
- 不因为普通 Agent 默认模型选择变化而重启 gateway。
- 不修改 OpenClaw 自身的模型 allowlist 校验规则。
- 不依赖 OpenClaw 补丁作为首选方案；本问题可在 LobsterAI 的认证和 gateway 生命周期编排层解决。
- 不把所有 `models` 或 `agents` 顶层配置变化一律升级为立即重启。

## 2. 用户场景

### 场景 1：运行中的应用完成登录后立即对话

**Given** OpenClaw gateway 已运行，用户尚未登录或刚退出旧账号  
**When** 用户完成登录，并立即在 Cowork 输入第一条消息  
**Then** LobsterAI 先取得当前账号的真实模型列表并完成运行态协调  
**And** 第一轮 `sessions.patch` 使用的模型已经存在于 gateway allowlist  
**And** 不出现 `model not allowed`

### 场景 2：登录时 gateway 正在启动

**Given** gateway 处于 `starting`，且可能已经读取旧配置  
**When** 登录模型目录与当前磁盘或运行态目录不同  
**Then** 不能把“配置已写盘”当作完成  
**And** 应取消或等待当前启动后执行一次受控重启  
**And** 登录运行态屏障只在新配置对应的 gateway ready 后解除

### 场景 3：模型列表后台刷新但目录未变化

**Given** 用户已正常登录并正在使用 Cowork  
**When** renderer 因窗口聚焦、额度刷新或定时轮询再次调用 `auth:getModels`  
**And** 服务端模型运行配置没有变化  
**Then** 返回最新 UI 元数据  
**And** 不触发 OpenClaw config sync 或 gateway 重启

### 场景 4：后台刷新发现模型目录发生变化

**Given** gateway 正在运行，且可能存在活跃会话  
**When** 服务端新增、删除模型，或模型的 OpenClaw 路由配置发生变化  
**Then** 先写入最新配置  
**And** 在没有活跃 workload 时执行受控重启  
**And** 有活跃 workload 时复用现有 deferred restart 机制  
**And** 新模型在重启完成前不应被当作运行时可用模型提交

### 场景 5：登录后模型接口暂时失败

**Given** token 交换成功，但 `/api/models/available` 超时或返回失败  
**When** 用户进入 Cowork  
**Then** 登录状态仍可保留  
**And** 模型运行态标记为可重试失败，而不是使用未经确认的新模型直接发送  
**And** UI 显示“模型配置初始化失败，请重试”一类明确提示

### 场景 6：用户快速重复登录或切换账号

**Given** 上一次登录的模型协调仍在进行  
**When** 新一轮 auth exchange 成功  
**Then** 新 generation 取代旧 generation  
**And** 旧请求的迟到结果不得覆盖新账号的 token、模型目录或 ready 状态

## 3. 功能需求

### FR-1：主进程统一拥有登录运行态协调

新增单一的登录运行态协调入口，负责：

1. 读取 auth exchange 已返回的 quota gate 信息。
2. 获取当前账号的服务端模型列表。
3. 更新 `serverModelMetadataCache`。
4. 生成 OpenClaw 配置。
5. 根据 gateway 当前 phase 完成必要的启动、重启或延迟重启。
6. 发布最终 ready 或 failed 状态。

renderer 可以触发登录和展示状态，但不能再通过调用顺序承担 gateway 配置正确性的责任。

### FR-2：登录时先加载模型，再执行最终配置应用

登录成功后不得立即单独执行 `media-entitlement-changed` hard restart。

推荐顺序：

```text
save tokens/user
  -> normalize quota
  -> fetch available models
  -> update model metadata cache
  -> one syncOpenClawConfig(auth-login-runtime-reconciled)
  -> start/restart gateway when required
  -> wait until runtime is usable
  -> mark reconciliation ready
```

quota gate 和 server model 变化必须合并到同一轮配置生成中。一次登录不应先用回退目录重启，再依赖后续热更新修正。

### FR-3：区分登录协调与普通后台模型刷新

`auth:getModels` 不再无条件自行安排一个 fire-and-forget 配置同步。

- 登录 generation 进行中：复用该 generation 的模型请求或缓存结果，不创建第二条独立同步链。
- 普通后台刷新：比较模型运行配置后决定无需同步、只同步或延迟重启。
- 多个并发 `auth:getModels`：同一 token generation 只发送一次服务端请求，其余调用复用 Promise。

### FR-4：识别需要重启的模型运行配置变化

需要区分 UI 展示元数据变化和 OpenClaw 运行配置变化。

建议让服务端模型更新返回结构化结果：

```typescript
export const ServerModelUpdateKind = {
  Unchanged: 'unchanged',
  MetadataOnly: 'metadata_only',
  RuntimeCatalog: 'runtime_catalog',
} as const;
```

运行配置指纹至少包含实际写入 OpenClaw 的字段：

- provider id；
- model id；
- API format；
- 输入能力；
- reasoning 标记；
- context window；
- primary model ref；
- `agents.defaults.models` 中与 allowlist 相关的 model key。

处理规则：

| 变化 | 处理 |
|---|---|
| 无变化 | 不 sync，不重启 |
| 仅价格、描述、restriction hint 等 UI 元数据变化 | 更新 renderer，不重启 |
| OpenClaw 运行配置变化，gateway 未启动 | 先写配置，再启动 |
| OpenClaw 运行配置变化，gateway 正在运行 | 写配置后受控重启 |
| OpenClaw 运行配置变化，gateway 正在启动 | 取消当前启动或设置 restart-after-start，屏障不得提前完成 |
| 有活跃 workload | 写盘后复用 deferred restart，暂不把新目录声明为 runtime ready |

本规则不等于“用户切换模型就重启”。已有会话切换模型仍只使用 `sessions.patch`；这里处理的是 gateway 可用模型目录本身发生变化。

### FR-5：首轮发送等待登录运行态屏障

在 `ensureOpenClawRunningForCowork()` 中，等待顺序应为：

```text
waitForAuthRuntimeReconciliation()
  -> waitForOpenClawConfigApply()
  -> ensure/start gateway
  -> return running status
```

必须先等待 auth runtime 屏障，因为它可能继续向 `syncOpenClawConfig()` 队列追加任务。

Cowork 新建、继续会话、steer、goal command，以及通过同一 engine readiness 入口的调用应获得一致保护。

IM 和 scheduled task 若不经过该入口，也必须在模型 session patch 或首个 chat send 前复用同一屏障。

### FR-6：运行态状态可观测

使用集中常量定义状态，不使用散落字符串：

```typescript
export const AuthRuntimePhase = {
  Idle: 'idle',
  LoadingModels: 'loading_models',
  ApplyingConfig: 'applying_config',
  RestartingGateway: 'restarting_gateway',
  Ready: 'ready',
  Failed: 'failed',
} as const;
```

状态至少包含：

- generation；
- phase；
- startedAt；
- modelCount；
- 是否要求 restart；
- 错误码和可重试性；
- 不包含 token、API key 或完整用户身份信息。

renderer 应能查询或订阅该状态，在 `loading_models`、`applying_config`、`restarting_gateway` 阶段显示“正在初始化模型”，避免用户看到输入已提交但长时间无反馈。

所有用户可见文案必须在 `src/renderer/services/i18n.ts` 中同时提供中文和英文。

### FR-7：失败不得退化为误导性的权限错误

如果登录运行态协调失败，首轮提交应返回稳定错误码，例如：

```text
auth_runtime_reconciliation_failed
```

renderer 将其映射为模型初始化失败或仍在初始化的提示，而不是直接展示 `model not allowed`。

服务端明确返回 `accessible=false` 时，仍按真实 entitlement 限制处理；不得把真实权限限制和本地运行态失败合并。

### FR-8：提供一次受控自愈兜底

如果满足以下全部条件：

1. 错误来自本地 `sessions.patch`；
2. 错误文本是 `model not allowed`；
3. `chat.send` 尚未发出；
4. 当前登录 generation 最近刚完成或模型目录刚变化；

则可以执行一次：

```text
force model config reconciliation
  -> restart/ready
  -> retry sessions.patch once
```

最多重试一次。该能力只是防御性兜底，主流程正确性不能依赖错误后重试。

### FR-9：增加关键生命周期日志

建议日志：

```text
[AuthRuntime] reconciliation started. Generation 12. Trigger login.
[AuthRuntime] loaded 18 server models. Update runtime_catalog.
[AuthRuntime] applying OpenClaw config. Restart required true. Gateway phase running.
[AuthRuntime] reconciliation ready. Generation 12. Duration 24310ms.
```

迟到 generation、失败、deferred restart 和一次性自愈也应有明确日志。

日志不得打印 token、API key、完整 `openclaw.json` 或未经脱敏的账号信息。

## 4. 实现方案

### 4.1 提取认证运行态协调模块

`src/main/main.ts` 已经承担大量 IPC 和生命周期职责。该修复会引入 generation、并发去重、失败状态和 gateway 协调，不应继续以内联闭包堆积在大文件中。

建议新增：

```text
src/main/libs/authRuntimeReconciliation.ts
```

模块职责：

- 管理当前 auth runtime generation 和 phase；
- 合并同 generation 的并发调用；
- 编排模型获取、metadata 更新、config sync 和 gateway ready；
- 提供 `waitForAuthRuntimeReconciliation()`；
- 对外发布只读状态；
- 忽略旧 generation 的迟到结果。

建议公开接口：

```typescript
startAuthRuntimeReconciliation(input): Promise<AuthRuntimeReconciliationResult>
waitForAuthRuntimeReconciliation(context): Promise<AuthRuntimeReconciliationResult | null>
getAuthRuntimeReconciliationState(): AuthRuntimeReconciliationState
cancelAuthRuntimeReconciliation(reason): void
```

依赖通过参数注入，便于 Vitest 测试，不直接 import Electron-only API。

### 4.2 提取服务端模型获取 helper

当前模型获取逻辑分别存在于 `auth:getModels` 和 `startupCacheWarmup`。建议抽取可复用 helper，例如：

```text
src/main/libs/serverModelCatalog.ts
```

职责：

- 构造 `/api/models/available` 请求；
- 校验响应结构；
- 返回完整 server model entries；
- 计算 UI metadata 和 OpenClaw runtime fingerprint；
- 不直接触发 config sync 或 gateway restart。

`startupCacheWarmup` 继续用于冷启动，但复用相同的解析和指纹逻辑。登录回调路径不能假设 cold-start warmup 已经执行或仍然有效。

### 4.3 调整 `auth:exchange`

`auth:exchange` 保留 token、user 和 quota 持久化，然后启动新的 auth runtime generation。

推荐行为：

1. token 和 user 保存成功后立即建立 generation。
2. quota 只更新缓存，不再独立 fire-and-forget restart。
3. 主进程主动开始模型获取，不等待 renderer 再调用 `auth:getModels` 才开始。
4. exchange 可以先返回登录成功和 generation id，避免 gateway 重启时间阻塞登录 UI。
5. Cowork 等运行态入口通过 generation 屏障保证正确性。

如果产品选择让 exchange 等待完整协调，也必须提供清晰 loading 状态，并设置合理超时；不能让 UI 无提示等待二十秒以上。

### 4.4 调整 `auth:getModels`

`auth:getModels` 变成模型数据读取入口，而不是独立的 gateway 生命周期触发器：

- 有登录协调进行中：等待或复用其中的模型请求结果。
- 已 ready：按现有刷新策略请求最新列表并执行差异分类。
- 未登录：保持 `{ success: false }`。
- 返回 renderer 所需的完整模型 UI 元数据。

删除当前不受等待的：

```typescript
syncOpenClawConfig(...).catch(...)
```

配置同步应由 reconciliation 模块持有并可被屏障等待。

### 4.5 调整 gateway restart 语义

登录协调中，当前账号模型目录加载完成后执行一次最终 config sync：

```typescript
await syncOpenClawConfig({
  reason: 'auth-login-runtime-reconciled',
  restartGatewayIfRunning: shouldRestart,
  expectedImpact: runtimeCatalogChanged
    ? OpenClawConfigImpact.Restart
    : OpenClawConfigImpact.None,
});
```

对登录场景可以保守地执行一次最终 restart，因为账号切换本身就会改变 quota gate、服务端模型目录和插件能力。关键不是减少这一次必要重启，而是保证它发生在真实模型列表写入之后，并且只发生一次。

需要补正 `syncOpenClawConfig()` 对 `starting` phase 的行为：restart-required 配置变化不能简单记录“gateway not running, skipping”并返回成功。应由 auth runtime 屏障等待到以下任一结果：

- 当前启动在读取配置前安全吸收了新配置，并有明确证明；或
- 当前启动被停止，使用新配置重新启动；或
- 当前启动完成后立即执行一次受控重启。

在无法获得配置加载确认的当前实现下，推荐保守地停止正在启动的进程并用最新配置重新启动。

### 4.6 扩展 engine readiness 顺序

修改 `ensureOpenClawRunningForCowork()`：

```typescript
const authRuntimeStatus = await waitForAuthRuntimeReconciliation('cowork engine startup');
if (authRuntimeStatus?.phase === AuthRuntimePhase.Failed) {
  return buildAuthRuntimeFailureStatus(authRuntimeStatus);
}

const configApplyStatus = await waitForOpenClawConfigApply('cowork engine startup');
if (configApplyStatus) return configApplyStatus;
```

`waitForOpenClawConfigApply()` 继续负责通用配置队列；新的 auth runtime 屏障负责确保登录路径不会在模型获取和最终重启之间放行。

### 4.7 renderer 状态和提示

推荐在 auth preload bridge 中增加只读状态查询和状态事件：

```text
auth:getRuntimeState
auth:runtimeStateChanged
```

IPC channel 必须使用 shared constants。

Cowork 输入框在运行态初始化期间：

- 保留用户已输入内容；
- 发送按钮显示 loading 或暂时不可提交；
- 显示“正在初始化模型”；
- ready 后自动恢复；
- failed 时允许点击重试，不要求用户手动重启整个应用。

### 4.8 一次性自愈

在 `OpenClawRuntimeAdapter.ensureSessionModelForTurn()` 捕获 `sessions.patch` 错误后，仅对登录模型目录竞态特征调用主进程提供的 reconciliation callback。

为避免 adapter 直接依赖认证模块，建议通过构造依赖注入：

```typescript
reconcileModelRuntimeOnAllowlistMiss?: (modelRef: string) => Promise<boolean>
```

返回 `true` 后重新执行一次 `sessions.patch`。其他 `INVALID_REQUEST`、远端 provider 权限错误和第二次失败保持原样抛出。

## 5. 并发与状态规则

### 5.1 generation 规则

- 每次成功 auth exchange 创建一个递增 generation。
- 同 generation 的模型获取、config sync 和 gateway restart 只允许一个主 Promise。
- logout 立即使当前 generation 失效。
- 新登录使旧 generation 失效。
- 旧 generation 的网络结果可以结束，但不得再更新模型缓存或 ready 状态。

### 5.2 屏障完成条件

只有以下条件全部成立时才能标记 `Ready`：

1. 当前 generation 仍有效；
2. 服务端模型列表成功解析；
3. `serverModelMetadataCache` 已更新；
4. OpenClaw 配置已写入；
5. 必要 restart 已完成或无需 restart；
6. gateway 状态可用于 session RPC；
7. 没有该 generation 对应的 deferred restart 尚未执行。

### 5.3 超时

- 模型接口建议沿用 5 秒单次超时。
- 首次失败可进行一次短退避重试。
- gateway restart 使用现有启动超时，不新增无限等待。
- 超时后进入 `Failed`，返回可重试错误；不得静默放行到旧模型目录。

## 6. 边界情况

| 场景 | 处理方式 |
|---|---|
| 登录模型列表与当前运行态完全一致 | 仍更新 auth generation；无需因 metadata 未变重复 sync |
| logout 后配置已清空，但 gateway 尚未重启 | 新登录必须以当前账号模型目录执行最终受控重启 |
| gateway 为 `ready` 但进程未运行 | 写配置后正常启动，无需 stop |
| gateway 为 `starting` 且可能已读旧配置 | 停止并以新配置重启，或使用可证明的 restart-after-start |
| gateway 有活跃 Cowork/IM workload | 延迟重启，新的 runtime model 不对外声明 ready；旧模型可继续已有 workload |
| 模型列表只更新价格或描述 | 更新 UI，不重启 gateway |
| 服务端新增模型 | 配置写入并在安全时重启；重启前 UI 可展示为“初始化中”，不能直接提交 |
| 服务端删除当前模型 | 选择首个 `accessible` 模型作为产品 fallback，并同步 session/agent 的失效提示；不静默请求已删除模型 |
| `/api/models/available` 返回空列表 | 视为可诊断失败，不用内置回退模型伪装成成功 |
| 用户有自定义 provider | 不受登录服务端目录协调影响；已有 session patch 规则保持不变 |
| 同名模型存在于多个 provider | 始终使用完整 provider-qualified ref 比较运行目录 |
| 自愈重试时用户已经停止任务 | 不重试，尊重 stop 状态 |

## 7. 涉及文件

### 核心实现

| 文件 | 预期改动 |
|---|---|
| `src/main/main.ts` | `auth:exchange`、`auth:getModels`、engine readiness 接入新协调模块；移除独立 fire-and-forget 登录同步 |
| `src/main/libs/authRuntimeReconciliation.ts` | 新增登录模型运行态 generation、屏障和 gateway 编排 |
| `src/main/libs/serverModelCatalog.ts` | 新增服务端模型获取、解析和 runtime fingerprint 计算 |
| `src/main/libs/claudeSettings.ts` | 返回结构化模型 metadata/runtime catalog 变化结果 |
| `src/main/libs/startupCacheWarmup.ts` | 复用 server model catalog helper，保持 cold-start warmup |
| `src/main/libs/openclawConfigSync.ts` | 暴露或计算运行目录影响；必要时补充 `starting` phase restart 语义 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 可选接入一次性 allowlist miss 自愈 callback |

### IPC、renderer 和 i18n

| 文件 | 预期改动 |
|---|---|
| `src/shared/auth/constants.ts` | 新增 auth runtime phase、错误码和 IPC channel 常量 |
| `src/main/preload.ts` | 暴露只读状态查询和事件监听 |
| `src/renderer/types/electron.d.ts` | 增加 auth runtime bridge 类型 |
| `src/renderer/services/auth.ts` | 复用 generation 模型结果，接收运行态状态 |
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 初始化阶段 loading/禁用发送和失败重试入口 |
| `src/renderer/services/i18n.ts` | 新增中英文模型初始化状态和错误提示 |

### 测试

| 文件 | 预期改动 |
|---|---|
| `src/main/libs/authRuntimeReconciliation.test.ts` | 新增并发、generation、排序、失败和 gateway phase 测试 |
| `src/main/libs/serverModelCatalog.test.ts` | 新增响应解析和 runtime fingerprint 测试 |
| `src/main/libs/openclawConfigSync.runtime.test.ts` | 覆盖登录模型目录和 restart impact |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` | 覆盖一次性 allowlist miss 自愈，不重复 chat send |
| `src/renderer/services/auth.test.ts` | 覆盖模型结果复用和 runtime 状态更新 |

## 8. 实施步骤

### 阶段 1：建立单一协调链和屏障

1. 提取 `serverModelCatalog` helper。
2. 新增 `authRuntimeReconciliation` 模块和 generation 状态机。
3. 将 quota gate、模型获取和最终 config sync 合并到登录协调链。
4. 让 Cowork engine readiness 等待 auth runtime 屏障。
5. 补充 `starting` phase 的 restart-required 处理。

阶段 1 完成后，应已经消除本次 `model not allowed` 竞态。

### 阶段 2：状态 UI 和可恢复失败

1. 增加 shared IPC constants 和 preload bridge。
2. 在 renderer 展示模型初始化中、失败和重试状态。
3. 将 auth runtime 失败映射为明确 i18n 文案。

### 阶段 3：防御性自愈

1. 为本地 allowlist miss 增加一次 reconciliation callback。
2. 确认重试只发生在 `chat.send` 前。
3. 增加一次性、取消和重复发送测试。

## 9. 测试计划

### 9.1 单元测试

至少覆盖：

1. quota 先更新、模型请求延迟时，不得在模型返回前调用最终 restart。
2. 模型请求完成后只执行一次 config sync 和一次必要 restart。
3. 并发 `auth:getModels` 复用同一服务端请求。
4. 新 generation 创建后，旧 generation 迟到结果被忽略。
5. runtime catalog 变化触发 restart；UI metadata-only 变化不触发 restart。
6. gateway `starting` 时 restart-required 屏障不会提前完成。
7. 模型接口失败时状态为 `Failed`，Cowork 不发送 `sessions.patch`。
8. `model not allowed` 自愈最多执行一次，且不重复 `chat.send`。

建议命令：

```bash
npm test -- authRuntimeReconciliation
npm test -- serverModelCatalog
npm test -- openclawConfigSync
npm test -- openclawRuntimeAdapter
```

### 9.2 编译和 lint

```bash
npm run compile:electron
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <touched-files>
```

如果修改 renderer，再运行：

```bash
npm run build
```

### 9.3 手工验证

#### 场景 A：正常登录后立即发送

1. 启动 gateway。
2. 退出当前账号。
3. 重新登录。
4. 登录成功后立即发送消息。
5. 验证日志顺序必须为：模型加载完成 → 配置应用 → 必要重启 → ready → `sessions.patch`。
6. gateway 启动日志应打印真实服务端模型 ref，不再打印旧回退模型后立即接受新 ref。
7. 不出现 `model not allowed`。

#### 场景 B：人为延迟模型接口

1. 在测试环境将 `/api/models/available` 延迟 5 至 10 秒。
2. 完成登录并立即发送。
3. UI 应显示正在初始化模型，消息不得穿透到旧 gateway allowlist。
4. 模型返回后自动完成协调并允许发送。

#### 场景 C：模型接口失败

1. 模拟连接重置或 HTTP 500。
2. 登录仍成功，但 Cowork 显示可重试的模型初始化失败。
3. 点击重试后恢复，无需重启整个应用。

#### 场景 D：后台模型列表刷新

1. 在已有会话运行时触发 `auth:getModels`。
2. 列表未变化时不得重启。
3. 只改价格/描述时不得重启。
4. 新增模型时应写入配置并在安全时完成 deferred restart。

## 10. 验收标准

1. 登录后立即发送第一条 Cowork 消息不再出现本地 `model not allowed`。
2. `/api/models/available` 返回的 accessible 模型在首轮 `sessions.patch` 前已经进入 gateway allowlist。
3. 同一次登录只执行一次最终配置应用和至多一次必要 gateway 重启。
4. `waitForAuthRuntimeReconciliation()` 未完成时，Cowork、IM 和 scheduled task 不得使用新登录模型启动 session。
5. gateway 在 `starting` 状态读到旧配置时，运行态屏障不会错误地返回 ready。
6. 普通后台模型轮询在无运行配置变化时不触发 config sync 或 gateway 重启。
7. 模型接口失败时给出模型初始化错误和重试能力，不误报账户额度或模型权限。
8. 自愈重试最多一次，并保证远端 `chat.send` 不重复。
9. 登录、退出、快速切换账号时，旧 generation 不会污染新账号运行态。
10. 不修改 OpenClaw runtime 输出或引入版本补丁；修复保持在 LobsterAI 集成边界。

## 11. 风险与回滚

### 11.1 风险

- 登录后等待模型目录和 gateway ready，可能延长“可立即发送”的时间。
- 对 `starting` gateway 执行保守重启会增加一次启动成本。
- deferred restart 期间需要明确区分“磁盘配置已更新”和“运行时已采用”，否则 UI 仍可能提前展示可用。
- 一次性自愈若边界判断不严，可能造成不必要重启；因此必须限定在 `chat.send` 前的本地 allowlist miss。

### 11.2 缓解

- 登录认证结果先展示，模型初始化状态独立显示，避免用户认为登录卡死。
- 模型请求去重，避免 renderer、quota refresh 和窗口聚焦重复请求。
- runtime fingerprint 只覆盖 OpenClaw 实际使用字段，减少无意义重启。
- 第一阶段可以先不启用自动自愈，仅上线确定性的排序和屏障修复。

### 11.3 回滚

该方案不引入数据库迁移。需要回滚时可恢复原 auth IPC 调用链和 config sync 入口，不影响 token、session 或 agent 数据。

回滚不能恢复“登录后先重启、再热同步模型”的旧竞态行为作为长期方案；如果新协调模块出现问题，应临时改为登录后强制等待模型列表并执行一次完整 gateway 重启，保证正确性优先。
