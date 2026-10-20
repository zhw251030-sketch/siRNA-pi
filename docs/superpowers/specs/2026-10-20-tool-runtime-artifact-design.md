# 第10B步：真实工具运行产物

## 目标与范围

沿参考checkout67d2754/application965c53f的工具构建容器→写入/测试→停止→commit→按ImageID新建运行容器流程，给第10A步教学提案生成真实runtimeArtifact。用户已授权沿此方向继续，个人main不建分支；仅修改siRNA-pi，远端唯一根/home/hanwen/Project/project/siNRA-pi。无模型请求、系统安装、服务重启或凭据读取。

这是工具控制器内核和可信宿主CLI，不是已向Agent开放的构建服务。HTTP/MCP构建会话入口、任意安装/联网、持久登记数据库、完整验证门槛、审批与激活暂缓。工具构建与Agent Compose任务容器分开，沿原职责边界，不把Docker socket交给Agent。

## 实现

- DockerEngineClient：Node内置HTTP连接显式项目Unix socket，无共享socket或环境变量回退。固定API v1.43，有限时间/响应大小，非TTY输出严格解帧。实现create/start/stop/remove/inspect/exec/commit/wait/logs，参数通过JSON传输。
- tool-build-service：只接受node、dependencies=[]、no_external_access、exact的完整草稿，拒绝已有runtimeArtifact。输入必须包含一项与smokeInput一致且有预期输出的案例；本阶段最多10个案例。基线只保存在提案，不写入候选镜像。使用固定已存在基座ImageID、固定/usr/bin/node及/opt/tool/main.mjs，源码哈希与镜像标签绑定。
- build-tool-artifact CLI：只在指定Linux项目目录由hanwen运行。有界读取项目内普通JSON文件；创建runtime/tool-builds/<UUID>私有目录，保存源快照、事件和构建结果。成功后保存proposal.json；失败保留诊断，不生成成功提案。

## 隔离与证据

基座固定sha256:e34a8f3fe6b2b74a3fa7f1a6143a126ae1e5414fa8a334c7bba82fe57d28971b，linux/amd64，禁止继承Volumes。构建无网络、无宿主bind、无Docker socket、无模型凭据，显式清空Entrypoint；构建写入以root执行，候选冒烟以65534:65534执行。构建和运行Memory=1GiB、PidsLimit=64、no-new-privileges、CapDrop=ALL。CPU配额在现有服务器不可用，不设置也不声称限制；已有网页guest配额不变。

完成构建前检查语法、候选源码哈希和真实smoke。停止后commit设置固定Cmd、User65534:65534、WorkingDir/tmp、源码/基座/会话/时间标签；从inspect真实读取OS/Architecture。Docker commit返回本地ImageID，不能称注册表manifest digest，也不上传注册表。

成品镜像按ImageID启动全新容器：只读根文件系统、64MiB/tmp、无网络/挂载、非root，参数用sirna-approved-tool-call/v1信封经stdin传入。逐项实际执行本提案testCases并匹配字面预期；每次核对镜像标签、命令、User及platform。此阶段输出为构建验收记录，不伪造filesDigest，不标verified/approved，不计算baseline净增益。

只清理本次创建且标签归属吻合的容器，保留镜像和私有记录；失败/超时同样精确清理，清理未确认必须报错并保留ID。不扫描/删除旧容器或镜像。进程被SIGKILL/主机崩溃时可能留下资源，日志及唯一标签用于后续核查；当前无后台TTL服务。

## 验收

单元/协议测试先失败后实现，覆盖真实HTTP边界、失败/超时/输出上限、严格镜像归属、构建案例失败不返回成功、精确清理。服务器实际构建教学草稿，从成品镜像对ACGT与单条FASTA RNA均得到length4/gcFraction0.5；完整提案预检通过但仍未登记/批准。核查容器安全设置和源码哈希，原10份会话元数据、3个运行容器及凭据元数据保持。完整Windows/Linux回归、独立审查、main推送及bundle同步。
