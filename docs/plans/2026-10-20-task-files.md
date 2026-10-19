# 第 7 步实施记录：任务文件查看

目标：按参考仓库的任务文件 HTTP 契约，实现输入／输出列表、UTF-8 文本预览和下载。沿用个人仓库 main；不调用模型、不创建新容器、不改变系统配置。

参考：相邻 sirna-pi-agent-service-refactor，提交 67d275494c50f1e5c205b96b72a7b1623acfbe1d；应用代码基准 965c53fba4eaa23996f54aa0532c7f6e1064bfd8。阅读 workspace.ts、router.ts 和 public/app.js 后独立实现；参考仓库没有明确应用代码许可证，不复制源码。

接口与职责：

- packages/task-core/workspace.mjs：根据任务的 executionSessionId 读取已有 Compose 元数据，只开放对应 workspace 的 input/output；列举、校验、哈希与受限读取。
- apps/api/router.mjs：GET /v1/tasks/:id/files 和 GET /v1/tasks/:id/files/:kind/:encodedName，返回 JSON 或文件字节，设置安全响应头。
- public/files.mjs 及现有页面：分组列表、刷新、文本预览和下载；切换任务时使旧请求失效。
- 未准备任务返回空状态，不启动执行环境；旧 SDK 扁平目录明确暂不支持；结束任务仍可访问保留的文件。

本轮适配差异：原仓库会在 task-files 和 sandbox 之间同步；本项目当前已经保留宿主绑定目录，本轮直接读取。上传、编辑、删除、独立归档层、图片和 PDF 预览后续学习，不声称已完整复刻文件管理。

实施与验证顺序：

1. 先写真实文件行为测试与 HTTP 契约测试，观察缺少实现时失败，再实现。
2. 前后端并行，分别拥有独立文件；集成后运行完整 Node 测试。
3. 在指定服务器项目目录运行 Linux 测试，核对服务空闲后重启本项目网页服务。
4. 浏览器打开已有结束任务：列出 numbers.csv/result.json、预览、下载并核对字节；切换不同任务、未准备任务，检查隔离与空状态。不发送新的模型消息。
5. 独立只读代码审查，修复实际问题；补充学习文档，提交 main、推送 GitHub，通过项目内 bundle 同步服务器并核对三处提交。

限制：运行中目录可能变化，单次稳定读取不等于整个目录的原子快照；仅支持单用户 SSH 隧道使用，不能把它当作多用户鉴权或 guest 内工具的严格路径沙箱。
