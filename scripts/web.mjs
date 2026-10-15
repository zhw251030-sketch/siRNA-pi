import { createAppServer } from "../src/server.mjs";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须是有效端口。");
const server = createAppServer();
server.on("error", () => { console.error("网页服务启动失败，请检查端口是否占用。"); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`siRNA-pi 网页已启动：http://127.0.0.1:${port}`));
