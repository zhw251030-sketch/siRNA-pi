import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import {listenToolSocket} from '../apps/api/tool-api-socket.mjs';

test('private tool listener creates only a private Unix socket and never deletes an existing path', {skip:process.platform==='win32'}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tool-socket-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const server=http.createServer((_req,res)=>res.end('private'));
  const socket=await listenToolSocket(server,{root});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  assert.equal(server.address(),socket);assert.equal(fs.statSync(socket).mode&0o777,0o600);
  assert.equal(fs.statSync(path.dirname(socket)).mode&0o777,0o700);
  const before=fs.lstatSync(socket);const other=http.createServer();
  await assert.rejects(listenToolSocket(other,{root}),/already exists/);
  assert.equal(fs.lstatSync(socket).ino,before.ino);
  const data=await new Promise((resolve,reject)=>http.get({socketPath:socket,path:'/'},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve(text));}).on('error',reject));
  assert.equal(data,'private');
});
