import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Proposal packages intentionally become read-only on POSIX. Unlock only our
// canonical direct mkdtemp roots; never traverse a linked entry during teardown.
export function removeBuildTestRoot(root){
  const temporaryRoot=fs.realpathSync(os.tmpdir());
  assert.equal(typeof root,'string');assert.equal(path.isAbsolute(root),true);
  root=path.resolve(root);
  assert.equal(path.dirname(root),temporaryRoot,'Builder fixture must be directly inside os.tmpdir()');
  assert.match(path.basename(root),/^(?:sirna-builder-|sirna-mcp-builder-)[A-Za-z0-9]+$/);
  const initial=fs.lstatSync(root);
  assert.equal(initial.isDirectory()&&!initial.isSymbolicLink(),true,'Refusing linked fixture root');
  assert.equal(fs.realpathSync(root),root,'Refusing redirected fixture root');
  function unlock(target){
    const stat=fs.lstatSync(target);
    if(stat.isSymbolicLink())return;
    if(stat.isDirectory()){
      assert.equal(fs.realpathSync(target),target,'Refusing redirected fixture directory');
      fs.chmodSync(target,0o700);
      for(const name of fs.readdirSync(target))unlock(path.join(target,name));
    }else{
      assert.equal(stat.isFile()&&stat.nlink===1,true,'Refusing linked or non-file fixture material');
      fs.chmodSync(target,0o600);
    }
  }
  unlock(root);
  fs.rmSync(root,{recursive:true});
}
export const BASE='sha256:e34a8f3fe6b2b74a3fa7f1a6143a126ae1e5414fa8a334c7bba82fe57d28971b';
export const COMMAND=['/usr/bin/node','/opt/tool/main.mjs'];
export function proposal(script='console.log("{}");'){
  return {name:'Builder example',toolName:'builder_example',description:'A deterministic builder example.',runtime:'node',script,
    repeatabilityMode:'exact',smokeInput:{n:2},dependencies:[],testCases:[{name:'two inputs',input:{n:2},expectedOutput:{n:2}}],
    baseline:{runtime:'node',script:'console.log("{}");'},benchmarkCases:[{name:'one input',input:{n:1},expectedOutput:{n:1}}],permissions:{profile:'no_external_access'}};
}
// Only Docker is doubled. Trusted controller upload/hash programs really run
// against this isolated virtual container filesystem; candidate shell never runs on host.
export class BuildDocker {
  containers=new Map();images=new Map();calls=[];sequence=0;commits=0;failAt;debug={exitCode:0,stdout:'{"n":2}',stderr:''};
  constructor(){this.images.set(BASE,{Id:BASE,Os:'linux',Architecture:'amd64',Config:{Volumes:null}});}
  hit(method,...args){this.calls.push({method,args:structuredClone(args)});if(this.failAt===method){this.failAt=null;throw new Error('private /host/diagnostic '+method);}}
  async inspectImage(id){this.hit('inspectImage',id);return structuredClone(this.images.get(id));}
  async createContainer(name,config){this.hit('createContainer',name,config);const id=`container-${++this.sequence}`;
    this.containers.set(id,{Id:id,Image:config.Image,Config:structuredClone(config),HostConfig:structuredClone(config.HostConfig),Mounts:[],files:new Map()});return id;}
  async inspectContainer(id){this.hit('inspectContainer',id);if(!this.containers.has(id))throw Object.assign(new Error('absent'),{statusCode:404});return structuredClone(this.containers.get(id));}
  async startContainer(id){this.hit('startContainer',id);this.containers.get(id).State={Running:true};}
  async stopContainer(id){this.hit('stopContainer',id);this.containers.get(id).State={Running:false};}
  async removeContainer(id,force){this.hit('removeContainer',id,force);this.containers.delete(id);}
  async exec(id,command,options){this.hit('exec',id,command,options);const c=this.containers.get(id);
    if(command[1]==='--check')return {exitCode:0,stdout:'',stderr:''};
    if(command[1]==='-e'){
      let stdout='';vm.runInNewContext(command[2],{Buffer,process:{argv:[command[0],...command.slice(3)],stdout:{write:s=>stdout+=s}},require:name=>{
        if(name==='node:crypto')return crypto;assert.equal(name,'node:fs');return {mkdirSync(){},chmodSync(){},writeFileSync:(p,b)=>c.files.set(p,Buffer.from(b)),readFileSync:p=>c.files.get(p)};
      }});return {exitCode:0,stdout,stderr:''};
    }
    assert.deepEqual(command.slice(0,2),['/bin/sh','-c']);assert.equal(options.user,'65534:65534');
    c.files.set('/tmp/build-only-marker',Buffer.from('transient'));
    return structuredClone(this.debug);
  }
  async commitContainer(id,repo,tag,config){this.hit('commitContainer',id,repo,tag,config);const c=this.containers.get(id);assert.equal(c.State.Running,false);
    const image=`sha256:${crypto.createHash('sha256').update(String(++this.commits)).digest('hex')}`;
    this.images.set(image,{Id:image,Os:'linux',Architecture:'amd64',Config:{...structuredClone(config),Volumes:null},files:structuredClone(c.files)});return image;}
  async waitContainer(){return 0;}
  async containerLogs(){return {stdout:'{"n":2}',stderr:''};}
}
