# Pi 1.2.0 容器模型任务设计与实施计划

用户已确认沿原仓库正式架构继续；本轮落实上一轮提出的下一步，直接在 main 工作。

## 目标和设计

保留 Agent Compose v2609.3.0 的控制服务、guest 运行协议和任务生命周期。在固定摘要的官方 guest 中按个人 package-lock 安装 Pi 1.2.0，使用一个薄包装器限制 read/write 并关闭本阶段不需要的自动发现、重试、压缩与遥测。包装器不改变上游 session 参数，不覆盖上游生成的 models.json。

公共模型目录配置使用 minimax-cn/MiniMax-M3、anthropic_messages、现有已验证的国内 api.minimax.cn 域名，输出上限 4096。controller 只读挂载现有 docs/auth.json，由入口程序读取后放入其进程环境；Docker 配置中不出现原始 key。官方会把解析后的 key 保存到控制服务数据库，因此整个 runtime/agent-compose/data 都是私有敏感状态，不能称为“密钥仅在内存”。guest 仅取得官方签发的沙箱/运行受限令牌，通过 controller facade 请求模型。

按原 executor 的 up → 固定命令初始化 workspace → 同 sandbox 提交 prompt 流程验收。输入 CSV 由程序准备，模型自主选择 read/write；独立验收器核对 Pi 原生会话中的真实工具调用及磁盘结果，并再做一次同会话续问。最后仅停止本次 sandbox，检查容器释放、文件保留。

## 文件与执行顺序

- [x] `containers/agent-compose-guest/`、`.dockerignore`、`config/pi/compose-settings.json`、构建脚本：固定依赖及小范围构建上下文，构建并核对版本。
- [x] `containers/agent-compose/entrypoint.py` 及行为测试：只读单行凭据，拒绝异常文件，错误不显示密钥；测试先失败再实现。
- [x] `config/agent-compose-models.json`、两种 compose 配置：接通 facade，保留独立管理鉴权、loopback 和项目 socket。
- [x] 文件任务验收模块及测试：不相信模型口头声称，核对输入、输出、实际工具与正常结束。
- [x] 真实容器测试：固定命令/模型运行、续问、凭据范围、停止释放与持久化；保存私有证据。
- [x] 全部离线测试、独立审查及中文学习讲解：96 项 Node 测试、4 项 Linux 凭据测试通过；独立审查无阻断问题。真实证据为 model-verify-IT2dgw。

交付使用既定 main 提交推送及服务器 Git bundle 同步；以最终三端 HEAD 和干净工作树核对为准。

## 边界

不改系统配置、共享 Docker、原仓库或网页执行器；无需新增管理员操作。网页本轮仍 local-pi。CLI detached 与正式网页的 RPC 共享 PiRunner，但不同事件传输方式，本轮不声称已验证网页 RPC。保留本轮证据与历史数据；不做 prune。默认 guest 没有资源配额。所有远端新增内容位于用户指定的唯一项目目录。

## 验收

Pi 实际版本 1.2.0；模型来源可追溯到 controller catalog；真实 CSV 统计 count=4、sum=100、mean=25；成功 read→write→read；续问沿用原 JSONL 并正确回忆随机标记；guest 没有原始 key、管理 token 或 Docker socket；未鉴权管理接口 401；停止后 released、容器移除且产物仍在。按实际结果更新此计划及学习文档，不预写成功。
