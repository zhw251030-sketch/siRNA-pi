import fs from "node:fs/promises";
import path from "node:path";

const maxBytes = 1024 * 1024;

// SDK 过渡执行器的 read/write 范围检查，不是正式架构的容器沙箱。
export function createWorkspaceOperations(directory) {
  const root = path.resolve(directory);
  async function check(target, { missing = false } = {}) {
    const absolute = path.resolve(target);
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("只允许访问当前任务目录内的文件。");
    }
    // 同时检查根目录、已有父目录及目标；避免通过链接绕过目录边界。
    const ancestors = [];
    for (let current = absolute; ; current = path.dirname(current)) {
      ancestors.push(current);
      if (current === path.dirname(current)) break;
    }
    for (const current of ancestors.reverse()) {
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (missing && error.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
        throw new Error("任务目录不支持链接文件或链接目录。");
      }
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("只支持普通文件。");
    }
    return absolute;
  }
  return {
    read: {
      access: async (target) => { await fs.access(await check(target)); },
      readFile: async (target) => {
        const file = await check(target);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > maxBytes) throw new Error("仅支持不超过 1 MiB 的普通文本文件。");
        return fs.readFile(file);
      },
    },
    write: {
      mkdir: async (target) => { await fs.mkdir(await check(target, { missing: true }), { recursive: true, mode: 0o700 }); },
      writeFile: async (target, content) => {
        if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error("文件不能超过 1 MiB。");
        await fs.writeFile(await check(target, { missing: true }), content, { encoding: "utf8", mode: 0o600 });
      },
    },
  };
}
