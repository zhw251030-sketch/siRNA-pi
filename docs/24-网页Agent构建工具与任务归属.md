# 第10K步：让网页中的 Pi 实际构建工具，并记录它属于哪个任务

2026-10-21。本步只改个人 siRNA-pi，远端唯一目录仍为 `/home/hanwen/Project/project/siNRA-pi`。原仓库以 `67d275494c50f1e5c205b96b72a7b1623acfbe1d` 为只读参考，接续个人提交 `670150e3765ebb51ff66dbfc27db9fbf3537f6f8`。

## 1. 先理解这一步解决了什么

上一节已经有“制作工具的机器”：可信宿主上的 MCP 客户端能创建构建环境、写源码、调试、打包、提交候选。但网页任务中的 Pi 还没有接通这台机器。

这一步增加了连接，同时回答两个问题：是谁要求构建的？这个人离开以后，没做完的构建环境由谁收拾？

完成后，在网页给 Pi 一份工具草稿，Pi 可以真实调用六个构建工具，得到成品镜像和一份 `submitted` 候选；后台把每个构建会话绑定到发起它的任务和本轮运行，最后回收临时容器。新工具仍然要经过独立验证与人的批准，才会进入正式目录。

这里的“可以制作工具”是工程能力。此次源码和步骤由我们预先提供，Pi 负责阅读、选择并调用接口，不代表它自主发现了新算法，也不代表已经实现了可靠的自进化。

## 2. 原仓库怎样做，我们怎样对齐

参考文件均在相邻 `sirna-pi-agent-service-refactor` 仓库：

| 原文件 | 阅读重点 | 本次对应实现 |
| --- | --- | --- |
| `agent-compose.yml`、`src/mcp-server.ts` | Pi 的 guest 内启动 MCP 子进程；基础构建工具与远程正式工具共同可见 | 个人 `agent-compose.yml`、`apps/mcp/remote-server.mjs` |
| `packages/domain/sirna-tools/sirna-tools.ts` | 六个工具的名称、参数与调用；五个构建操作和提案提交走不同地址 | `tool-builder-tools.mjs` 复用上一节六工具，新增 HTTP client |
| `packages/capability-platform/tool-runtime-client.ts` | 把五个构建操作转成 HTTP 请求 | `apps/mcp/tool-builder-client.mjs` |
| `packages/capability-platform/tool-runtime-controller.ts` | 接收请求，管理构建会话与 Docker | `apps/api/tool-build-api.mjs` 加既有 `tool-build-sessions.mjs` |
| `apps/api/router.ts` 的 `/v1/tool-proposals` | 中央登记候选，后续可接自动化协调 | 本步只调用既有登记服务，停在 submitted |

原版的五个构建操作走独立 `tool-runtime-controller` 服务，提案走中央服务；`/v1/agent-tools` 则是正式工具发现/调用入口，不能把它们混为一谈。本步保留原 HTTP 方法、路径和主要业务参数关系，但将构建控制职责放在现有后台进程的私有 Unix socket 服务中，由 relay 转发；尚未拆成原版的独立控制器容器。返回字段沿用个人10J合同，并非逐字复制原返回 JSON。

我们还增加了原代码这些路径没有的每轮凭证与所有权认证。原版 build session 没有 task/turn owner；本步不能把新增的认证说成原版已有。我们继续限制为单份 Node 源码、无额外依赖、无网络、非 root 调试、只收集申报源码的洁净打包；原版允许的构建范围更广。

## 3. 从网页到 Docker，一条请求经过哪些文件

```text
网页消息
  → Agent Compose 运行独立任务 guest 内的 Pi
  → guest 的 MCP 服务列出六个构建工具
  → tool-builder-client：把一次工具调用翻译成固定 HTTP 请求
  → agent-tools-relay：只转发允许的路径到宿主私有 socket
  → tool-build-api：检查本轮凭证、解析参数、记录调用
  → task-tool-builders：找到这个任务本轮专用的构建服务
  → tool-build-sessions：操作独立构建容器、冻结镜像
  → tool-lifecycle：登记 submitted 候选
```

**Pi 负责选择动作，程序负责执行动作。** 例如模型生成 `create_tool_build_session` 调用，只是提出一个结构化请求；真正调用 Docker 创建容器的是服务器代码。Pi 的任务 guest 不需要挂载宿主 Docker socket，也不用知道宿主项目路径。

### 第一层：向 Pi 提供它能理解的操作

[`packages/domain/sirna-tools/tool-builder-tools.mjs`](../packages/domain/sirna-tools/tool-builder-tools.mjs) 保存六个工具的说明、参数合同和执行适配。上一节已有的业务含义保持，本步把取消信号传给远程客户端。

[`apps/mcp/remote-server.mjs`](../apps/mcp/remote-server.mjs) 仅在显式配置 builder URL 时加入这六个工具；同时保留正式工具动态发现。[`apps/mcp/approved-server.mjs`](../apps/mcp/approved-server.mjs) 承担共同的 MCP 协议适配，不能因为文件名包含 approved 就误以为构建操作已获发布批准。构建工具声明会修改状态，失败时返回固定提示：操作可能已经完成，应检查宿主记录后再决定是否重试。内部异常和凭据不会直接拼进公开错误。

### 第二层：把工具名转换成服务请求

[`apps/mcp/tool-builder-client.mjs`](../apps/mcp/tool-builder-client.mjs) 的主要职责是翻译，业务执行仍在宿主：

| Pi 工具 | 发出的请求 | 含义 |
| --- | --- | --- |
| `create_tool_build_session` | POST `/v1/build-sessions`，`{}` | 申请构建会话 |
| `write_tool_build_file` | PUT `/v1/build-sessions/:id/files` | 写入指定源码 |
| `run_tool_build_command` | POST `/v1/build-sessions/:id/exec` | 在会话中调试 |
| `cancel_tool_build_session` | DELETE `/v1/build-sessions/:id`，无 body | 放弃并清理 |
| `finalize_tool_build` | POST `/v1/build-sessions/:id/finalize` | 冻结可交付运行产物 |
| `propose_exploration_tool` | POST `/v1/tool-proposals`，扁平完整提案 | 登记候选材料 |

客户端复用 [`remote-client.mjs`](../apps/mcp/remote-client.mjs) 的受限身份文件读取，每次取本轮凭证，发送认证头；不自动重放创建/提交，不跟随 HTTP 重定向。网络超时只表示客户端没得到确定结果，不能推断服务器什么都没做。

[`containers/agent-tools-relay/relay.mjs`](../containers/agent-tools-relay/relay.mjs) 是转接器，只接受固定路径和方法。构建请求最多 1 MiB，HTTP 响应最多 300000 字节；正式调用原来的请求上限 262144 字节和30秒等待保持。构建客户端等300秒、relay等310秒，以容纳打包过程。具体调试命令仍受10J的最长30秒约束，不等于任意命令可以跑300秒。

锁定的 Pi MCP 适配器2.11.0还有自己的等待时间，所以新增 [`patch-mcp-builder-timeout.mjs`](../containers/agent-compose-guest/patch-mcp-builder-timeout.mjs)：只对显式启用 builder 的 `sirna-tools` 设置320秒；它校验所修改的源码位置，避免盲目替换。MCP 最终文本仍保留原262144字节限制；大量转义字符可能使 HTTP 成功结果在 MCP 末层被拒绝，不能把 HTTP 上限当整个链路的可用输出上限。

### 第三层：确定“谁有权操作这个会话”

[`apps/api/tool-build-api.mjs`](../apps/api/tool-build-api.mjs) 在读取请求内容前认证一次，读完后再认证一次，避免读请求期间本轮已结束却仍接受操作。它只接固定接口，不让请求体自带或覆盖 owner；每次已接受操作记录宿主生成的调用编号、工具名、运行编号和成功状态。

[`packages/capability-platform/tool-call-leases.mjs`](../packages/capability-platform/tool-call-leases.mjs) 中的 lease 可以理解成“本轮临时通行证”。宿主将它绑定到五项真实身份：网页 taskId、执行环境 executionSessionId、容器 sandboxId、本轮 agentTurnId、实际 agentRunId。模型不填写这五项。

新增的 `ownResource()` 让 lease 还负责“本轮申请的资源”。[`task-tool-builders.mjs`](../packages/capability-platform/task-tool-builders.mjs) 按需为它建立独立构建服务；其他轮的 sessionId 不在该服务的私有会话表中，不能接着用。

当前一个后台进程同时只允许一个网页轮拥有 builder，服务内最多4个占用资源、32个累计会话；这是有意收紧的学习范围。10J独立CLI实例有自己的预算，不能把这里说成所有客户端共享项目级全局上限。会话不能跨轮续用，已完成的镜像和提交材料则持久保留。

### 第四层：继续复用真正的构建内核

[`tool-build-sessions.mjs`](../packages/capability-platform/tool-build-sessions.mjs) 继续负责容器创建、非root调试、取消、洁净打包及源码/产物匹配；本步主要新增可信 taskContext 校验和落盘。每条构建事件、`finalized.json`、`proposal-result.json` 都有所属任务和运行，能从候选反查它的来源。

[`tool-lifecycle.mjs`](../packages/capability-platform/tool-lifecycle.mjs) 为可信调用者增加 `web-agent` 来源标签，原CLI默认 `local-cli` 保持。它只登记，不调用验证器或批准服务。数据库没有新增迁移。

### 第五层：收尾与网页证据

一轮完成、失败或取消后，[`agent-compose-runtime.mjs`](../packages/agent-runtime/agent-compose-runtime.mjs) 关闭 lease：先撤销新请求权限，再等待已接受的操作结束，最后关闭本轮 builder，确认清理后才释放 owner。即使清理失败，也在 finally 移除本轮身份文件；不把不明结果当成成功。清理状态不明会保留 owner 槽与日志，需要调查，尚无进程崩溃自动恢复机制。

[`task-message-service.mjs`](../packages/task-core/task-message-service.mjs) 保存 `builder_tool_call` 事件，[`public/app.js`](../public/app.js) 显示“构建操作完成/失败”和调用编号。这是后台记录的执行事实，与 Pi 自己生成的文字总结是两种不同证据。

[`agent-compose.yml`](../agent-compose.yml)、[`Dockerfile`](../containers/agent-compose-guest/Dockerfile)、[`.dockerignore`](../.dockerignore) 与 [`build-project-guest.sh`](../scripts/build-project-guest.sh) 配置新 project identity 和 `sirna-pi-guest:pi1.2.0-mcp3` 镜像。新文件按白名单进入镜像，宿主构建内核、运行目录和密钥不打包。新能力用于新建任务，旧guest不会被原地替换。

## 4. 这次实际做出的工具

[`examples/07-web-tool-build/proposal.draft.json`](../examples/07-web-tool-build/proposal.draft.json) 是人为准备的小例子，工具叫 `summarize_numeric_range`，输入1至100个有限数，输出数量、最小值、最大值与极差。选这个例子是为了先观察工程链路，不混入生物知识或复杂算法。

浏览器实际上传草稿并发送要求，Pi依次：读取草稿 → 创建A → 原样写源码 → 调试一次 → 冻结A → 提交一次 → 创建B并取消 → 创建C故意留待收尾 → 写结果并读回。

输入 `[6,2,4]`，真实 stdout 为：

```json
{"count":3,"min":2,"max":6,"range":4}
```

草稿内还给出了假定输入有序的教学基线，以及用于以后独立验证的案例。这次没有执行那些基准，也没有比较净增益；不能将一次成功调试写成验证通过，更不能称强基线、性能提升或研究结果。

实际身份与证据：

| 项目 | 结果 |
| --- | --- |
| 网页任务 | `506ee4db-d6c6-4a8c-b1ab-d9bd5b26cb52` |
| 执行环境 | `25c3e1e1-c18e-49f4-a8a4-11d708bf9e29` |
| 实际运行 | `08850a24695c4c625a4f360d28686c95c411f603b7e3fd7f6978fac73a3e3742` |
| Pi 原生会话 | `01a15b2d-9287-7271-ac1d-9540f76754bc` |
| 成品构建会话A | `4022b31c-bc5a-45da-ac15-909a72445ee1` |
| 主动取消B | `6a9350df-ca95-4f37-9d51-3a658ff70491` |
| 自动收尾C | `9d7857a4-709c-4e4b-bd4b-afede80c0767` |
| 新候选 | `26883ce8-5c2e-4a0e-90fb-d96e53270b9c`，仅 submitted |
| 镜像 | `sha256:45b87208b560b36d8424cba95bebf0a4e3f1981c49efbf1d659aba02354bccf1` |
| 源码 SHA-256 | `e91e65dcea8747c0b3698faaec9223c6871585f3386e5c99fde344b8a8f405af` |
| 提案材料包 SHA-256 | `b57eb4bd612e32f26a7287d3867feeb99fb4835823b831a3350364f0bbc18729` |
| 交付文件 | `output/web-build-result.json`；工作区、独立归档与HTTP下载字节一致 |

16次模型响应、19次Pi工具操作，其中8次构建业务操作全部成功。**整个轨迹并非零失败**：开始查询工具说明时，Pi两次把 `describe` 的字符串参数写成对象，Pi在业务请求前拒绝；随后改成字符串成功查询。未创建重复构建或提案。它最终自由总结中的“无失败”不准确，原会话保留，不能用这句话替代轨迹核验。

原生usage合计 input7627、output2628、cacheRead71826、cacheWrite0、totalTokens82081。SDK cost字段为0并非已确认免费；未核对实际账单，不给出确定费用。

宿主独立检查证实A的可变容器及洁净打包容器、B与C共4个临时容器已移除；C有 `close_cleanup` 事件。随后通过网页结束任务，新guest释放，输出仍能预览/下载。旧21份材料、12份正式调用审计、11份会话元数据、两只旧guest及所有旧任务/登记行保持。新增1proposal、1条web-agent提交事件；验证仍2条、版本仍2条，正式 `summarize_target_sequence` 仍active1.0.1，新数值工具不在正式目录。

## 5. 验证过程与真实边界

新增 [`tests/web-tool-builder.test.mjs`](../tests/web-tool-builder.test.mjs) 使用真实HTTP、MCP、临时文件和SQLite，模拟外部Docker/RPC边界；覆盖完整提交、未激活/伪造/已撤销凭证、跨轮会话、在途排空、清理不明禁止下轮、超时不重放、有界响应、事件持久化。新增 [`tests/mcp-builder-timeout.test.mjs`](../tests/mcp-builder-timeout.test.mjs) 实际执行适配器补丁，并检查没有builder时不改变配置；另补充既有relay/runtime/MCP测试。

Windows主实现全套1056项：1043通过、13项平台跳过。独立审查后修复公开错误被错误标成approved工具失败的问题，先见1失败再修正，29项相关测试通过；最后Linux全套1057项：1055通过、2项Windows专属跳过、0失败。没有重复调用模型以“刷到无失败轨迹”。

第一次远程测试命令在PowerShell中错误拼接PATH，测试进程启动前出现 `spawnSync sh ENOENT`；修正SSH命令的引用方式后才运行全套，旧数据保留检查通过。Windows新夹具曾缺少RPC事件且未及时关闭SQLite，诊断时还出现force-exit句柄错误；补齐真实事件序列、先关闭DB后清理后，正常测试通过。三个诊断临时目录经路径检查后用既有受限助手移除，未涉及项目数据或放宽产品权限，诊断记录保留。部署审查发现Docker上下文白名单需要加入新guest模块，构建前已修正；新镜像实际导入成功，确认没有凭据文件与宿主builder代码。

Linux命令使用固定测试列表 `tests/*.test.mjs`，由 `runtime/web-builder-linux-tests.mjs` 显式设置工作目录与项目内TMPDIR，不扫描运行目录或继承真实CLI工作目录。离线测试不能代替本节真实Docker/浏览器验收，两者分别保存证据。

新guest镜像摘要 `sha256:e1132518f9a32c36ead10668419adb8399f5cf9a1885c096290f8ee7fa6f4ca0`。仅在空闲时重建项目controller/relay并重启后台，未动系统服务或管理员配置；两个旧guest及旧镜像保留。保留旧镜像/运行产物是为追溯，不执行全局清理。

当前这一步的只读复核：

```sh
cd /home/hanwen/Project/project/siNRA-pi
export PATH=/home/hanwen/.nvm/versions/node/v24.16.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
node scripts/verify-web-tool-builder.mjs 506ee4db-d6c6-4a8c-b1ab-d9bd5b26cb52 ended
```

它检查原生调用、两次发现参数失败、源码/镜像/提案、五项owner、四容器移除、输出字节与旧登记前缀，不运行模型、候选或构建。依赖私有 `runtime/web-builder-state-before.json`；是本次固定完成状态的复核，未来登记新增提案后数量断言可能不适用，不应改写旧证据以追求始终通过。

私有证据主要在 `runtime/web-builder-{state-before,completed,ended,linux-01-result,build,recreate,restart}.json`、`runtime/web-builder-linux-01.log`、`runtime/tool-builds/<会话ID>/`；浏览器截图为本机 `runtime/web-builder-browser.png`。原生Pi记录位于该sandbox的 `state/agents/providers/pi/sessions/`，任务记录在现有SQLite。凭据内容未输出、复制或提交。最终提交相关核验写入忽略的 `runtime/web-builder-sync.json` 和 `web-builder-post-sync.json`，避免把提交自身哈希写回形成循环。

## 6. 下一步怎样继续学习

现在分别有了正式工具使用、受控构建、候选登记、独立验证、人工发布与回退；本步把构建接到了真实网页Pi。还缺一个明确协调这些动作的角色：原仓库的 tool-curation / Curator。

下一步先按原代码实现最小协调流程：读取候选与证据，决定何时请求独立验证，整理失败反馈与待人工批准的结果。不要一步跳到无限自动改写、自动发布或“自进化有效”。现有两份数值候选仍submitted，这正是后续学习协调器时可见的待处理对象。
