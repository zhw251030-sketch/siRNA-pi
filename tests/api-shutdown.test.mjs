import test from 'node:test';
import assert from 'node:assert/strict';

test('shutdown closes admission immediately, drains accepted reviews and closes resources even when drain rejects',async()=>{
  const {createApiShutdown}=await import('../apps/api/service-lifecycle.mjs');
  const order=[];let finish;const gate=new Promise(resolve=>finish=resolve);
  const service=name=>({stop(){order.push('stop-'+name);return name==='curation'?gate.then(()=>{throw Error('private persistence fault');}):Promise.resolve();}});
  const server={close(cb){order.push('http-close');cb();},async waitForTaskCompletion(){order.push('http-drain');}};
  const toolsServer={close(cb){order.push('tools-close');cb();},async waitForCalls(){order.push('tools-drain');}};
  const close=name=>({close(){order.push(name);}});
  const shutdown=createApiShutdown({server,toolMaintenance:service('maintenance'),toolRepair:service('repair'),toolCuration:service('curation'),toolsServer,stores:[close('tasks'),close('maintenance-db'),close('repair-db'),close('curation-db')],rpc:close('rpc')});
  const pending=shutdown();assert.deepEqual(order.slice(0,4),['stop-maintenance','stop-repair','stop-curation','http-close']);assert.equal(order.includes('rpc'),false);
  assert.equal(shutdown(),pending);finish();await assert.rejects(pending,e=>!e.message.includes('private'));
  assert.deepEqual(order.slice(-7),['tools-close','tools-drain','tasks','maintenance-db','repair-db','curation-db','rpc']);
});
test('shutdown still closes every store and RPC when another close fails',async()=>{
  const {createApiShutdown}=await import('../apps/api/service-lifecycle.mjs');let rpcClosed=false,otherClosed=false;
  const shutdown=createApiShutdown({server:{close(cb){cb();},waitForTaskCompletion:async()=>{}},toolsServer:{close(cb){cb();},waitForCalls:async()=>{}},stores:[{close(){throw Error('private db failure');}},{close(){otherClosed=true;}}],rpc:{close(){rpcClosed=true;}}});
  await assert.rejects(shutdown());assert.equal(rpcClosed,true);assert.equal(otherClosed,true);
});
test('shutdown closes a separate curator transport even if the designer transport close fails',async()=>{
  const {createApiShutdown}=await import('../apps/api/service-lifecycle.mjs');const closed=[];
  const shutdown=createApiShutdown({server:{close(cb){cb();},waitForTaskCompletion:async()=>{}},rpcs:[{close(){closed.push('designer');throw Error('transport close');}},{close(){closed.push('curator');}}]});
  await assert.rejects(shutdown());assert.deepEqual(closed,['designer','curator']);
});
