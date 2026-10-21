# 第11B步：冻结证据与独立工具审查

用户已要求继续按原仓库逐步复建；本设计落实上一轮明确的下一步。只在个人 main 和指定服务器项目内实现，不另建分支。参考仓库固定 67d275494c50f1e5c205b96b72a7b1623acfbe1d，只读参考其职责与协议，独立实现。

## 行为

网页先读取11A预览，再显式提交审查。提交带 runId/sourceSha256/previewSha256，后台同一次读取源事件与正式目录，重算并核对，拒绝陈旧预览。只接受已结束且至少一条完整触发线索的轮次；无信号或仅窗口不完整均409且无模型调用。不自动观察所有历史任务、不恢复付费请求、不自动构建/发布。

同一 taskId/runId 最多一条审查，重复相同摘要返回同一条；不同摘要409。独立 SQLite 保存 request/冻结trace/状态/模型身份/结果。采用原版 waiting→running→skipped|candidate|error 状态；启动时将旧waiting/running标error且注明执行结果未确认，不重试。单实例单消费者，正常关闭停止接收并等待已接受审查及释放落盘。

冻结trace使用原版 sirna-tool-curation-trace/v1 和 result/v1 主字段，附加学习版证据完整性/源摘要元数据。同一次目录快照按11A既有规则去sirna_tools_前缀、去重并排序，完全相同的规范名称进入trace和source摘要；原始前缀与重复项不作为不同能力。只纳入完整触发线索所对应的已配对业务调用。调用时间来自保存事件，输入输出形状由可解析预览推导或明确unknown；不得把截断文本当完整原始输入。64KiB最终trace上限，超限拒绝，不再裁掉触发依据。hash计算排除traceSha256字段。冻结后任何状态更新均不得改变trace或hash。

结果必须为单个JSON对象，整体≤48KiB；拒绝未知顶层/候选字段、错误id/hash/protocol、skip夹带candidate、未知能力key、缺失或越界证据、既有工具同名、无效权限/超长合同与指令。候选必须引用其完整触发组中的事件；permission只是最小权限建议，不授予权限。结构校验不证明建议有价值。JSON.parse不额外实现通用重复键解析器，此语义在说明中如实记录。

## 独立执行

通过既有 AgentComposeRuntime 生命周期复用取消/终态/释放；增加固定 designer/tool-curator 角色选择，Curator独立session/log目录，session绑定角色，禁止互读。designer默认行为保持。executor对tool-curator固定选择 agent-compose-curator.yml，不接受用户任意命令/文件。

独立Compose项目与tool-curator agent使用既有MiniMax-M3。新增派生镜像从本项目mcp4镜像构建，仅加入专用wrapper和Pi guard，不安装依赖，不修改旧镜像/容器。wrapper固定无工具，显式加载guard；guard拦截所有tool_call，包含read/MCP。不配置MCP、不授予host工具lease；不挂载原任务资料。只通过prompt给予脱敏冻结trace。单次180秒，零重试；异常停止/保留身份，finally graceful stop保留原生会话。没有确认释放不能显示完整成功。

最终实现补充：为复用现有管理容器挂载，公开profile首次独占复制到runtime/agent-compose/data/curator-config/agent-compose.yml，CLI从/data读取，已存在内容必须一致。guard在message_end先拒绝工具意图，保留原内容并标aborted，避免未知工具绕过tool_call后再请求模型。Curator使用独立180秒RPC，适配器180秒发出取消；启动/清理另外等待，不把180秒描述为整个生命周期的绝对耗时上限。

## 网页与证据

保留11A预览；新增明确标注可能调用模型的送审按钮和手动刷新审查记录。显示等待/审查/跳过/建议/错误，理由、能力边界、引用事件、输入输出/权限草案、trace hash。纯文本渲染，切任务取消显示旧响应；POST中断不意味着服务端取消，刷新读取已有记录，服务端唯一约束防重复付费。

当前历史轮次无合格线索，真实业务验收应如实得到拒绝且零业务模型调用。独立模型链使用单独标记的合成验证证据、最多一次真实审查，保留原始记录；不把合成证据写入业务任务库或称自动发现。不生成/批准工具。离线测试覆盖candidate/skip及负例；真实无模型guard验证和Docker隔离核验后再进行有界模型验收。

## 保护范围

唯一远端根 /home/hanwen/Project/project/siNRA-pi；不改变系统权限/服务。保全四个旧业务数据库、旧证据目录/原生会话、正式catalog与四个旧容器。只允许新curation状态、独立Curator guest及其受控记录/镜像、新API进程发生变化。凭据只沿用既有内存鉴权，不显示或复制。检查通过后提交推送main并通过项目内bundle同步服务器，不覆盖未知改动。
