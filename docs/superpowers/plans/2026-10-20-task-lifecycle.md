# 任务停止与环境释放实施计划

用户已要求继续上一轮明确的下一步：停止本轮、结束任务/释放容器，并保留文件及历史。沿既有 main 工作，不建分支或修改系统配置。

**Goal:** 新容器网页任务可以停止一轮后续聊，或结束任务并确认释放容器；保存过程与运行状态不互相覆盖。

**Architecture:** 保持参考 POST /v1/tasks/:id/cancel、DELETE /v1/tasks/:id/runtime。Task Core 管同任务的开始/停止/结束互斥；Runtime 管取消信号与真实环境状态；RPC 通过 StopRun + 最终流/GetRun 确认终态；前端保持 SSE 至 task_saved。

**Tech Stack:** 既有 Node24/Pi1.2/AgentCompose v2609.3.0/SQLite/SSE，无新增依赖。

**Spec:** 本文接口及验收约束，承接 docs/09-网页接入AgentCompose.md 的下一步。

## 关键语义

- cancel 取消本轮执行，保留环境。StopRun 返回可能还在 running，不能把请求成功等同于实际停止。
- 初始化期间锁存取消请求，允许固定无模型初始化收尾，然后禁止发出新模型 prompt。
- remove 名称沿运行时接口，但本版只执行 sandbox stop --graceful 并检查 stopped_runtime_state=released；当前 stopped_runtime_policy=remove 会释放容器。禁止 sandbox rm：官方本版本会 os.RemoveAll 删除 workspace/nativePi 数据。
- 结束后任务 stopped，禁止新消息；历史、执行关系、文件和会话保留。
- 先等待本轮结果和消息保存，再结束任务。停止失败/状态未知不得假报 canceled/released。
- 仅 Compose 支持本轮生命周期功能，旧 SDK 保持原行为并禁用新按钮。
- 取消不保证回滚文件写入，也不保证首轮过早中止时已保存完整Pi上下文；缺上下文时拒绝静默新建。

## 文件与接口

- RPC：agent-compose-rpc.mjs：run(request,{callbacks,signal})、getRun(runId)、stopRunAndWait(runId)。预取消不提交；已提交且编号未到时等待 started；已知编号发 StopRun；最终 canceled 可不含正常 turn/eof。
- Runtime：agent-compose-runtime.mjs：run(request,emit,signal)、cancel(id)、remove(id)；内存 active Map 保存本轮 AbortController，release 锁阻止同时启动；取消后记录 canceled，任务仍可继续；释放后永久 stopped。
- Executor：compose-executor.mjs：release(id) 调官方温和停止并 inspect 验证；文件目录保留。
- Router：runtime-router.mjs 转发信号与方法，拒绝旧SDK；describe返回 supportsLifecycle。
- Task Core：每轮 AbortController、完成Promise、结束锁；cancelTask/endTask返回参考API格式；数据库停止状态不被迟到保存改回idle。
- HTTP：router.mjs 注册两个接口，复用本机同源限制与安全错误；关闭服务等待生命周期操作。
- UI：独立 lifecycleBusy，流式发送期间可停；结束后只读；迟到HTTP/SSE消息不能复活stopped状态。

## 分项验证

- [x] RPC：本机真实gRPC服务测试预取消、started延迟、StopRun只确认请求、终态查询、自然完成竞争、失败保留编号。
- [x] Runtime：真实临时文件状态配合传输边界，先失败后实现取消/释放；中断不要求成功投影器、取消后原会话续问、初始化取消不调用模型、结束后不能重启、失败释放不假报成功。
- [x] Task Core/HTTP：真实SQLite与HTTP，停止请求不提前释放任务锁，结束等待保存，重复结束去重，失败可重试，历史保留，旧SDK拒绝。
- [x] UI：控件状态及迟到事件行为测试；真实浏览器验证发送期间可停、停止后续问、结束后只读且刷新仍保留。
- [x] 服务器：只使用新建专用验收任务，不中断此前用户任务；记录原生会话、真实运行状态、guest进程/释放状态和文件保留。沿用前两步已验证的固定命令初始化/释放，本步用授权MiniMax任务验证真实停止和网页链路。
- [x] 本机/服务器239项Node测试、4项Linux凭据测试、独立审查、中文逐文件解释。

验收结果：任务36ba635d-8b5c-44d2-a4fe-ec272564f5d6的四轮业务状态为succeeded/canceled/succeeded/canceled；最后后台原始状态为failed/context canceled，保留raw字段并按明确用户中断解释。最终released/graceful、guest0、8条消息，统计文件和Pi原始JSONL前缀不变。详细证据见docs/10-停止运行与结束任务.md。

交付同步：只提交本步项目文件到main并推送GitHub，服务器通过项目内bundle快进同步。最终核对三处HEAD和工作树，不把私有证据与凭据加入Git。

核心验收断言示例：

```js
assert.equal(finalEvent.status, 'canceled');
assert.equal(savedSession.status, 'idle');
assert.equal(savedSession.sandboxId, originalSandboxId);
assert.equal(releasedSandbox.stopped_runtime_state, 'released');
assert.equal(savedTask.status, 'stopped');
assert.equal(fs.readFileSync(resultFile, 'utf8'), originalResult);
```

官方源码核对：run_handler.go的StopRun仅确认请求；docker_exec_lifecycle.go负责TERM/KILL；sandboxstore/sandbox_metadata.go的RemoveSandbox会删除目录。因此使用已验证的stop/released接口，而不是照搬参考版本的rm实现。
