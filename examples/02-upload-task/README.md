# 上传文件练习

新建任务并上传 `values.csv`，此时上传本身不会调用模型或创建任务容器。发送：

> 读取 input/values.csv，计算 value 列的 count、sum、mean，把只含这三个数值字段的 JSON 写入 output/upload-result.json，然后重新读取该结果文件核对。仅使用 read/write。

独立核算结果为 count=3、sum=27、mean=9。上传后、运行完成后、结束任务后分别执行验收（不调用模型）：

```sh
node scripts/verify-compose-upload.mjs <taskId> uploaded
node scripts/verify-compose-upload.mjs <taskId> completed
node scripts/verify-compose-upload.mjs <taskId> ended
```

发送消息会消耗模型额度；验收脚本不会调用模型或启动容器。验收的 GET 文件请求可以刷新宿主归档，但不能改变对话历史或执行元数据。
