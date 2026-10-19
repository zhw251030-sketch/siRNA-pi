# Agent Compose 协议来源

`agentcompose/v2/agentcompose.proto` 原样取自官方仓库
[chaitin/agent-compose](https://github.com/chaitin/agent-compose)，版本 `v2609.3.0`，
提交 `493af1c16a7c84ac8ab3bdfdaf1419ed19d0a9d8`：

- [原始协议文件](https://github.com/chaitin/agent-compose/blob/493af1c16a7c84ac8ab3bdfdaf1419ed19d0a9d8/proto/agentcompose/v2/agentcompose.proto)
- [上游 LICENSE.txt](https://github.com/chaitin/agent-compose/blob/493af1c16a7c84ac8ab3bdfdaf1419ed19d0a9d8/LICENSE.txt)，GNU Affero General Public License version 3，原文保存在 `LICENSE.agent-compose.txt`。

协议和许可证均由该提交的 `git show` 原文保存，未删字段或修改协议。
上游 `runtime/agent-compose-runtime-sdk/LICENSE` 是另一个目录的许可，不能用来替代本协议的上游根目录许可。
这里记录被收录文件的来源与许可，不对整个学习项目的许可归属作法律判断。

`packages/agent-runtime/agent-compose-rpc.mjs` 使用该完整协议加载正式 `RunService`，
通过 gRPC over HTTP/2 明文连接仅在服务器本地监听的控制服务。
鉴权使用后端读取的管理令牌，通过 `authorization: Bearer …` 元数据发送。
令牌不是模型 API key，不写入此目录。

正常单轮流程是：`start → started → agentEvent* → agentTurnCompleted → stdinEof + half-close → result`。
三个回调按收到顺序等待完成；只有最终 `result` 才决定运行成功或失败。
客户端采用上游 `DETACH` 语义，连接中断不会自动取消已接受任务。
因此已知 runId 的超时、传输错误或回调失败会另发带独立截止时间的 `StopRun`；
停止失败通过错误对象的 `stopError` 返回，调用方应保留运行编号并检查控制服务实际状态。
客户端不自动重试；关闭前由调用方等待已接受任务保存完毕。
新一轮提交前通过 `hasActiveRuns(sandboxId)` 分别查询同一 sandbox 的 pending 和 running 运行，
查询失败直接报错，不能将失联误判为空闲。这是提交前检查，不是跨多个网页服务进程的原子锁。

协议行为核对位置（均为同一固定提交）：

- `cmd/agent-compose/cli_daemon.go:273`：h2c 服务。
- `cmd/agent-compose/daemon_auth.go:18`：Bearer 管理鉴权。
- `proto/agentcompose/v2/agentcomposev2connect/agentcompose.connect.go:1149`：支持 gRPC 的 RunService handler。
- `pkg/agentcompose/app/run_supervisor.go:134`：DETACH 使用 daemon 生命周期。
- `pkg/runs/controller.go:471`：DETACH 下 half-close 不等于 stdin EOF。
- `pkg/runs/prompt_projection.go:86`：Agent 事件及一轮结束投影。
- `pkg/runs/run_attach.go:30`：保存最终状态并发送 result。

参考项目仅用于理解回调边界与分层，没有复制其应用代码。
