# 第 8 步实施计划：上传、归档与执行同步

目标：在第7步的文件查看基础上，允许用户上传自己的资料，并按原仓库方向分离任务归档和容器工作副本。用户已要求按上一轮提出的下一步继续实施；个人仓库只使用 main，不新建分支。设计、实现和验收在本轮完成。

参考：sirna-pi-agent-service-refactor 67d2754，workspace.ts 的 saveWorkspaceInput/synchronizeTaskWorkspace，router.ts 的 POST files，task-message-service.ts 的执行前同步及 workspace_synced/workspace_warning。独立实现，不复制未明确许可的应用源码。

## 设计与边界

1. 项目内 runtime/task-files/<taskId>/input|output 是独立归档；guest 仍看到 /workspace/input|output。不挂载整份归档给 guest。
2. POST /v1/tasks/:id/files 使用 JSON {name,contentBase64}，成功201 {file}。单次一个非空文件，最多600,000字节；名称必须是安全的单文件名；同名409，不覆盖。上传仅保存，已有空闲环境可以同步；未准备环境不启动容器或模型。
3. 运行前：Compose完成环境准备并确认无其他运行后，hydrate 将归档输入放入guest；失败则不调用模型。提示包含输入文件名，文件内容仍由read工具读取。
4. 运行后：collect 将稳定的output收回归档，并发workspace_synced；失败发workspace_warning，保留真实运行状态与回复，不把归档失败伪装成模型失败。结束环境后也要归档成功才向任务层确认结束。
5. GET 列表/内容刷新宿主归档，但不回写guest；旧任务的既有输入按缺失导入，不能覆盖用户已经上传的归档输入。guest缺失时保留的归档可读并明确提示缓存；非法元数据或不安全目录不能静默回退。
6. 单进程的上传、发送、结束相互排斥；服务重启后上传还须确认Compose没有未确认的后台运行。同步文件采用临时文件与原子替换，延续链接和路径保护。
7. 前端增加选择文件、上传按钮与结果提示；选择文件不等于发送。上传不自动重试，断线提示先刷新核对；结束任务仍可查看归档，但不能上传。

不包含：编辑/删除、任务克隆、全文检索、多用户服务、严格guest工具沙箱、系统安装。输出归档保存最新同名结果，不镜像删除，不是版本历史库。

## 任务与接口

- [x] 文件归档层：packages/task-core/task-files.mjs 的 TaskFiles({root,agentRuntime})，实现 list/read/saveInput/hydrate/collect；复用 workspace.mjs 的安全文件访问。hydrate返回{state,synchronization,inputFiles:[metadata]}。测试真实文件、重复、上传上限、恶意链接、同步覆盖方向、归档脱离guest可读和并发。
- [x] 执行协调：TaskMessageService注入workspaceFiles，uploadInput保留任务操作锁；Compose运行在RPC前调用request.prepareWorkspace，RuntimeRouter转发assertWorkspaceIdle。测试上传期间发送/结束拒绝、同步失败不调用模型、运行后warning独立于模型终态、释放后归档失败可以重试。
- [x] HTTP：files POST经TaskMessageService；保存已经完成但即时同步失败返回201附pending/warning，避免误导用户重复上传。归档读取延续原预览/下载限制与安全头，跟踪后台文件操作供正常关闭等待。
- [x] 网页：public/files.mjs + app/index/style；使用原请求契约，限制与错误明确。测试字节编码、任务切换迟到结果、重复名失败不覆盖、不自动重试。
- [x] 离线与文件验收：先红后绿；Windows350通过4跳过，Linux354全部通过。浏览器上传、重复名拒绝、无guest时预览、执行前回填、旧输出归档下载与释放后保留通过。两个旧guest未改动。
- [ ] 新上传文件的真实模型成功验收：两次MiniMax请求均返回529 overloaded_error，0工具调用；未得到3/27/9结果。两个验收guest已释放，证据保留；不继续循环调用，待服务恢复后用新任务补验。
- [x] 文档与审查：docs/12-上传资料与任务文件归档.md逐文件解释，README/AGENTS/学习路线已更新；独立审查三项发现均修复并复核通过。交付时按既定main提交／推送、项目内bundle同步及三处HEAD核对流程完成版本同步；上级RSI项目不修改。

关键验收例子：上传 values.csv，内容 value\n3\n9\n15\n；期待 count=3,sum=27,mean=9。归档输入与guest输入SHA一致，模型原生工具记录确认read指定路径和write输出；网页下载与归档字节一致。

实际证据与待验边界见docs/12；旧任务4/100/25产物只用于验证归档和下载，不作为新模型成功证据。复核后明确历史输入保留50MB读取上限，新上传仍限600KB；预览使用缓存响应头显示警告；未准备目录不发送同步成功事件。
