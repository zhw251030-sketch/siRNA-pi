# 第10N步：向可信来源任务派发一轮受控修订

承接10M反馈预览，独立实现参考67d2754的来源、sendAutomatedRepair和候选替代关系。采用显式点击、一轮消息、最多三代替代候选；复用原TaskMessageService/Compose/builder/maintenance。新候选仍submitted，验证和批准仍由人显式启动。不做自动循环、Curator或软件安装。

## 来源和替代关系

新网页候选登记时，将宿主lease核验的五项taskContext写入既有proposal_submitted事件details，与proposal行同一SQLite事务。来源不能来自模型参数、HTTP body/header或唯一活跃任务猜测。旧事件和CLI候选不回填来源；缺来源不可自动修订。schema4不迁移，原候选文件不改。

修订候选同时在该事件内写入repair关联：requestId、rootProposalId、previousProposalId、attempt（1..3）。根候选attempt0，正式parent版本独立。一个repair request最多接纳一个替代候选，事务内检查唯一性；不能因为运行结束回调而覆盖已登记的新候选关系。只认正在处理本修订消息的真实任务运行：taskId/executionSessionId匹配，task.currentRunId=lease.agentRunId，当前用户消息clientRequestId等于固定修订requestId。普通后续聊天、同名别的任务、模型伪造字段均不匹配修订票据。

本步程序强制保持toolName/runtime/dependencies/permissions/repeatabilityMode/smokeInput/testCases/baseline/benchmarkCases/minNetGain/parent的原合同，允许description/script和新的runtimeArtifact；必须新buildSessionId。采用深值比较（键顺序无关、数组顺序保留），缺省minNetGain按1。不以改变测试获得通过。此约束比参考原版更严格，文档明确。同轮多余或改名提案拒绝，不降格为新root绕过预算；普通新任务仍可提出新能力，故三次是每条已绑定修订链预算，不是全账号调用预算。

## 派发和持久化

独立runtime/tool-repair/repairs.sqlite保存一候选一份修订请求，路径和普通文件/链接检查沿项目惯例；应用ID和schema识别，私有权限。保存固定requestId=auto-tool-repair:<proposalId>、来源任务、完整原合同/失败反馈生成的消息与摘要、材料/报告绑定、root/attempt、phase及固定安全错误码；不存凭据。消息包含完整候选源码/合同和实际反例，不将10M截断网页预览冒充完整修订上下文。原输入若超过TaskMessageService120000字符或256KiB准备上限，网络前拒绝，不截断派发。

显式POST /v1/tool-proposals/:id/repair仅接受{validationId,reportSha256}且≤4096字节，要求与当前反馈完全相同。不得从浏览器选来源任务/传prompt/成绩。只有完整verification_failed报告、无该候选pending/running验证、队列未halt、可信来源task存在且可继续、attempt<3才可新派发。busy/stopped/unknown拒绝，不偷偷排队或恢复旧任务。

先持久保存dispatching，再经原TaskMessageService.start发固定requestId消息；同键重试返回原记录，不再发模型。不自动重发崩溃时尚未确认的dispatching/running；启动恢复为interrupted，只读查历史。原消息服务的持久请求去重是第二层。正常completion只有保存的assistant和正常终态才能进入awaiting_replacement；失败/取消/缺保存记安全失败。模型文字说提交但无真实新proposal只显示未收到新候选。真实新候选提交事件可独立证明superseded，即使收尾之前崩溃也可核对；新候选不自动验证或批准。

同一可信网页进程提供修订与验证互斥，修订在途不接该旧候选新验证，开始修订前拒绝在途验证。CLI维护仍独立受信，文档要求不与网页并发。GET只投影读取，不能触发运行或业务写入。正常shutdown先停止修订接纳，再等待已接受消息和资源清理；只在成功监听后恢复修订状态，不能端口冲突进程改旧状态。

## 网页与验收

GET /:id/repair-status返回来源taskId（或null）、链root/attempt/maxRepairAttempts3、当前repair安全摘要和canRepair/reason。页面说明“请求修订会运行Agent并消耗模型额度”，明确只启动一轮；原10M查看反馈继续只读。POST前禁用重复点击，未确认回执提示先刷新；来源/报告切换或迟到响应不能改变当前选择。显示新候选编号，仍提示独立验证/人工批准。

真实演示另建可继续网页任务和新名字教学工具，不改10M无来源候选或旧ended任务。先由Pi按人为错误源码构建submitted，网页验证得到失败，再一次显式修订，观察是否实际新构建/新提案，最后显式验证新候选并结束演示任务释放guest。最多一次根构建轮和一次修订轮；不为追求好结果循环付费重试，若模型/服务失败保留如实证据。全程保存旧材料/行/会话/审计/运行容器快照，新增证据私有；不打印凭据。成功与否按独立报告，而非模型最终文字。

个人main持续同步；唯一远端/home/hanwen/Project/project/siNRA-pi；只项目后台空闲重启，不做root/系统变更。Node已有版本，无依赖升级。实际模型用量记录，无法得到账单不虚构免费或精确金额。
