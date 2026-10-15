import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function fixture(t) {
  const parent = path.resolve("runtime", "file-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "case-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(root, "secret.txt"), "outside-content");
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const { createWorkspaceOperations } = await import("../src/workspace-files.mjs");
  return { root, workspace, ...createWorkspaceOperations(workspace) };
}

test("workspace operations read and write actual files in the task directory", async (t) => {
  const { workspace, read, write } = await fixture(t);
  const file = path.join(workspace, "nested", "result.json");
  await write.mkdir(path.dirname(file));
  await write.writeFile(file, '{"mean":25}');
  await read.access(file);
  assert.equal((await read.readFile(file)).toString(), '{"mean":25}');
});

test("workspace operations reject parent traversal, absolute external paths and large writes", async (t) => {
  const { root, workspace, read, write } = await fixture(t);
  await assert.rejects(read.readFile(path.join(workspace, "..", "secret.txt")));
  await assert.rejects(write.writeFile(path.join(root, "secret.txt"), "changed"));
  await assert.rejects(write.mkdir(path.join(root, "outside")));
  await assert.rejects(write.writeFile(path.join(workspace, "huge.txt"), "a".repeat(1024 * 1024 + 1)));
  assert.equal(await fs.readFile(path.join(root, "secret.txt"), "utf8"), "outside-content");
});

test("workspace operations reject linked files and linked directories", async (t) => {
  const { root, workspace, read, write } = await fixture(t);
  const hardlink = path.join(workspace, "hardlink.txt");
  await fs.link(path.join(root, "secret.txt"), hardlink);
  await assert.rejects(read.readFile(hardlink));
  await assert.rejects(write.writeFile(hardlink, "changed"));
  const link = path.join(workspace, "linked");
  await fs.symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(read.readFile(path.join(link, "secret.txt")));
  await assert.rejects(write.mkdir(path.join(link, "new-directory")));
  assert.equal(await fs.readFile(path.join(root, "secret.txt"), "utf8"), "outside-content");
});
