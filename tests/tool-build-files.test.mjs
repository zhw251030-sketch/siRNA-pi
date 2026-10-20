import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBuildProposal, createBuildEvidence } from '../scripts/lib/tool-build-files.mjs';

const runtime = path.resolve('runtime');
function fixture(t) {
  fs.mkdirSync(runtime, {recursive:true});
  const root = fs.mkdtempSync(path.join(runtime,'build-files-test-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test('proposal reader returns exact source data without changing the original file', t => {
  const root = fixture(t);
  const file = path.join(root,'proposal.json');
  const raw = '{"name":"sequence","script":"never execute me"}\n';
  fs.writeFileSync(file,raw);
  assert.deepEqual(readBuildProposal(file,{root}), {name:'sequence',script:'never execute me'});
  assert.equal(fs.readFileSync(file,'utf8'),raw);
});

test('proposal reader rejects out-of-root files, directories, empty and oversized data', t => {
  const root = fixture(t);
  assert.throws(() => readBuildProposal(path.join(root,'..','outside.json'),{root}), /project|root|outside/i);
  assert.throws(() => readBuildProposal(root,{root}), /file/i);
  const file = path.join(root,'bad.json');
  for (const text of ['', ' '.repeat(1048577)]) {
    fs.writeFileSync(file,text);
    assert.throws(() => readBuildProposal(file,{root}), /size|empty|MiB/i);
  }
});

test('malformed UTF-8 and JSON errors do not echo source text', t => {
  const root = fixture(t), file = path.join(root,'bad.json');
  for (const bytes of [Buffer.from([0xc3,0x28]), Buffer.from('{PRIVATE_SENTINEL')]) {
    fs.writeFileSync(file,bytes);
    assert.throws(() => readBuildProposal(file,{root}), error => {
      assert.doesNotMatch(error.message,/PRIVATE_SENTINEL/);
      return /UTF-8|JSON/.test(error.message);
    });
  }
});

test('proposal reader rejects linked source files', t => {
  const root=fixture(t), file=path.join(root,'proposal.json'), alias=path.join(root,'alias.json');
  fs.writeFileSync(file,'{}');
  fs.linkSync(file,alias);
  assert.throws(() => readBuildProposal(file,{root}), /link/i);
});

test('evidence separates failure records from proposals and gives sessions unique directories', t => {
  const root=fixture(t), id=randomUUID();
  const evidence=createBuildEvidence(root,id);
  assert.equal(evidence.directory,path.join(root,'runtime','tool-builds',id));
  evidence.write('source-proposal.json',{script:'original'});
  evidence.appendEvent({type:'container-created',containerId:'owned-test-id'});
  evidence.write('failure.json',{error:'smoke failed'});
  assert.equal(fs.existsSync(path.join(evidence.directory,'proposal.json')),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence.directory,'events.jsonl'),'utf8')),
    {type:'container-created',containerId:'owned-test-id'});
  assert.throws(() => createBuildEvidence(root,id), /exist/i);
});

test('evidence refuses overwrites and escaping names, and writes owner-only files on Linux', t => {
  const root=fixture(t), evidence=createBuildEvidence(root,randomUUID());
  evidence.write('result.json',{ok:true});
  assert.throws(() => evidence.write('result.json',{ok:false}), /exist/i);
  assert.throws(() => evidence.write('../outside.json',{}), /name/i);
  assert.equal(fs.existsSync(path.join(root,'outside.json')),false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(evidence.directory).mode & 0o777,0o700);
    assert.equal(fs.statSync(path.join(evidence.directory,'result.json')).mode & 0o777,0o600);
  }
});

test('evidence cannot follow a redirected parent directory', t => {
  const root=fixture(t), outside=fixture(t);
  fs.symlinkSync(outside,path.join(root,'runtime'),process.platform==='win32'?'junction':'dir');
  assert.throws(() => createBuildEvidence(root,randomUUID()), /redirect|link/i);
  assert.deepEqual(fs.readdirSync(outside),[]);
});
