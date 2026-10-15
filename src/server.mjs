import { createServer } from "node:http";
import fs from "node:fs/promises";
import { runWebTask } from "./web-task.mjs";

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function reply(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

// runTask 可替换，离线 HTTP 测试因此无需调用收费模型。
export function createAppServer({ runTask = runWebTask } = {}) {
  let busy = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    // 学习服务仅供本机/SSH 隧道访问；防止外部网页把本机服务当作调用入口。
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
        (request.headers.origin && request.headers.origin !== `http://${host}`)) {
      request.resume();
      return reply(response, 403, { error: "请从本机网页访问此服务。" });
    }
    let pathname;
    try { pathname = new URL(request.url, `http://${host}`).pathname; }
    catch {
      request.resume();
      return reply(response, 400, { error: "请求地址格式不正确。" });
    }
    if (request.method === "GET" && pathname === "/health") return reply(response, 200, { ready: true, busy });
    if (request.method === "GET" && staticFiles.has(pathname)) {
      const [name, type] = staticFiles.get(pathname);
      try {
        const content = await fs.readFile(new URL(`../public/${name}`, import.meta.url));
        response.writeHead(200, { "Content-Type": type });
        return response.end(content);
      } catch { return reply(response, 500, { error: "网页文件尚未就绪。" }); }
    }
    if (request.method !== "POST" || pathname !== "/v1/tasks") {
      request.resume();
      return reply(response, 404, { error: "没有这个页面或接口。" });
    }
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      request.resume();
      return reply(response, 415, { error: "任务需要使用 JSON 格式。" });
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) {
          reply(response, 413, { error: "输入过长，请缩短任务。" });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reply(response, 400, { error: "无法读取任务内容。" }); }
      if (typeof body?.message !== "string" || !body.message.trim() || body.message.length > 4000) {
        return reply(response, 400, { error: "请输入 1 到 4000 字的任务。" });
      }
      if (busy) return reply(response, 409, { error: "已有任务正在运行，请等它完成后再发送。" });
      busy = true;
      try {
        const result = await runTask(body.message.trim());
        reply(response, 200, result);
      } catch {
        reply(response, 502, { error: "本次任务未完成。请检查服务器配置、网络和 runtime/web 中的任务记录，然后重试。" });
      } finally { busy = false; }
    } catch {
      if (!response.headersSent) reply(response, 400, { error: "请求已中断，请重试。" });
    }
  });
  server.requestTimeout = 15000; // 限制上传正文的时间，不是模型执行时间。
  server.headersTimeout = 10000;
  return server;
}
