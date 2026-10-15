# 第 1 步 B：连接 MiniMax-M3，完成首次文件任务

日期：2026-10-15。此步骤已经在指定服务器完成真实模型调用和文件任务。

## 这次新增了什么

上一阶段只有可以启动的 Pi 程序。这次让它连接 MiniMax 国内平台的 `MiniMax-M3`，读取一个小文件，计算结果，再把结果写回服务器。

Pi 原本就有模型调用、工具执行和继续对话的能力。我们新增的是启动配置、练习材料和结果检查，还没有使用 SDK 创建自己的 Agent 会话，也没有新增网页或后端。

## 唯一远端工作目录

所有本阶段的远端配置、运行记录和练习产物都位于：

```text
/home/hanwen/Project/project/siNRA-pi/
```

已有的 Node.js 24 运行环境继续作为系统工具使用。本阶段不向项目外新建配置、缓存或临时目录。

| 路径 | 内容 | 是否进入 Git |
| --- | --- | --- |
| `docs/auth.json` | 用户提供的一行 MiniMax Key；尽管扩展名为 json，当前内容不是 JSON | 否；权限已改为 600 |
| `scripts/pi-minimax.mjs` | 读取密钥、设置项目内运行目录、启动原生 Pi CLI | 是 |
| `config/pi/models.json` | 国内接口地址和本练习的响应长度上限 | 是 |
| `config/pi/settings.json` | 默认模型、关闭自动重试和自动压缩等练习设置 | 是 |
| `examples/01-file-task/numbers.csv` | 四个样例数：10、20、30、40 | 是 |
| `examples/01-file-task/prompt.txt` | 要求 Pi 读取、计算、写入、重新读取的任务说明 | 是 |
| `scripts/verify-first-task.mjs` | 独立检查事件、工具路径和计算结果，不调用模型 | 是 |
| `runtime/pi/` | 启动时从 config/pi 复制的运行配置，以及 Pi 的运行状态 | 否 |
| `runtime/tmp/`、`runtime/cache/` | 本阶段的临时文件和缓存 | 否 |
| `runtime/first-task.events.jsonl` | 本次执行事件，每行一个 JSON 对象 | 否 |
| `runtime/first-task.stderr.log` | 本次运行的诊断输出 | 否 |
| `workspaces/first-task/result.json` | 模型调用 write 工具生成的结果文件 | 否 |

启动脚本只读取原始密钥文件，把 Key 放入 Pi 子进程的 `MINIMAX_CN_API_KEY` 环境变量；不打印它，也不把它复制到运行配置或源码中。`docs/auth.json` 已加入 `.gitignore`。

## 怎样连接到模型

Pi 1.2.0 自带 `minimax-cn / MiniMax-M3`，所以不用自己实现 MiniMax 网络协议。我们把内置模型的接口地址覆盖为当前官方国内地址：

```json
{
  "providers": {
    "minimax-cn": {
      "baseUrl": "https://api.minimax.cn/anthropic",
      "modelOverrides": {
        "MiniMax-M3": { "maxTokens": 4096 }
      }
    }
  }
}
```

这里的 Anthropic 是接口格式名称，实际使用的服务商和模型仍然是 MiniMax。4096 限制的是每次模型响应的输出 token 数，不是整个任务的累计预算。

`PI_CODING_AGENT_DIR` 指向项目里的 `runtime/pi/`。`PI_OFFLINE=1` 关闭启动时自动更新模型目录等操作，但不会禁止我们主动发出的模型任务。本练习另关闭遥测、自动重试和自动压缩，使用 `--thinking off`。

## 实际发生的四轮交互

1. **第一次模型响应**：要求调用 `read`，读取 `examples/01-file-task/numbers.csv`。Pi 执行读取，把文件内容交还模型。
2. **第二次模型响应**：给出计算结果，要求调用 `write`，写入 `workspaces/first-task/result.json`。Pi 执行写入。
3. **第三次模型响应**：要求调用 `read`，重新读取刚写出的结果。Pi 执行读取。
4. **第四次模型响应**：给出最终回复，任务结束。

其中，选择工具和生成工具参数的是模型，实际读写文件的是 Pi。这里的平均值由模型算出；我们再用独立 JavaScript 程序重新计算并比较。

结果文件的实际内容：

```json
{
  "count": 4,
  "sum": 100,
  "mean": 25
}
```

验收发现 3 次工具调用均成功，所有路径都只涉及项目内这两个样例与结果文件。4 次模型响应的 `usage.totalTokens` 合计为 5801，包含各轮重复上下文和缓存读取；它不是实际账单金额。本轮没有核查这把 Key 的订阅或按量计费归属。

## 怎样查看和重新运行

登录服务器后，在项目内选用 Node 24：

```bash
cd /home/hanwen/Project/project/siNRA-pi
source /home/hanwen/.nvm/nvm.sh
nvm use
```

只检查已经完成的任务，不产生新模型调用：

```bash
npm run verify:first-task
```

预期输出包含 `verified: true`、`count: 4`、`sum: 100`、`mean: 25`。

若需要重新执行本练习，下面命令会再次调用模型，并替换这次练习的事件日志和结果文件：

```bash
mkdir -p runtime workspaces/first-task
timeout --kill-after=10s 180s node scripts/pi-minimax.mjs --mode json --print \
  < examples/01-file-task/prompt.txt \
  > runtime/first-task.events.jsonl \
  2> runtime/first-task.stderr.log
npm run verify:first-task
```

`<` 把文件内容作为标准输入传给 Pi，文件结束时也会通知 Pi 输入已结束。第一次通过非交互 SSH 传递 `@文件` 参数时，SSH 输入仍保持打开，Pi 一直等待输入结束，未产生执行事件。改用上面的输入重定向后完成任务；保留标准输入也方便以后在终端交互。

启动器只允许 `--version`、`--help`、`--print` 和 `--mode json` 这些显示参数，避免意外改写模型、工具或目录设置。

## 我们怎样确认它真的完成了

检查程序同时验证：运行目录、模型与服务商、正常结束事件、每次工具调用及其成功记录、工具路径与调用顺序，以及磁盘上的实际结果。它独立计算 CSV 的数量、总和、平均值，再与模型生成的 JSON 比较。

没有只凭进程退出码判定成功：Pi 1.2.0 的 JSON 模式可能在事件包含错误时仍以 0 退出。

实际检查结果：

- 原始执行记录与结果通过验证。
- 在项目内的临时副本中把平均值改成 26，检查程序拒绝通过。
- 把工具路径改成凭据路径，检查程序拒绝通过；测试没有读取凭据内容。
- 删除任务结束事件，检查程序拒绝通过。
- 尝试通过启动参数改成 bash 工具，启动器拒绝执行。

工作目录和工具白名单并不是操作系统级文件沙箱；本次使用自建的可信样例，并在执行后核对所有工具路径。网页历史、多用户隔离、停止机制等仍需在对应学习阶段另做设计和验证。

## 与参考仓库和下一步的关系

参考仓库的 `package.json` 负责依赖；`packages/agent-runtime/chat.ts` 展示通过 SDK 创建和使用 Pi 会话的路径。当前这个启动脚本只是启动原生 CLI，不是那一层 SDK 封装。

下一步用最少程序创建一个 Pi 会话、发送任务、接收事件。届时对比这次原生运行，就能看清我们自己写的封装究竟增加了哪些职责。

官方依据：[MiniMax 国内 Anthropic 兼容接口](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)、[Pi 1.2.0 模型配置](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/models.md)、[Pi JSON 事件说明](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/json.md)。
