import test from 'node:test';
import assert from 'node:assert/strict';
import * as lifecycle from '../apps/api/service-lifecycle.mjs';

test('API startup recovers handoffs only after listening and starts no automatic build',()=>{
  assert.equal(typeof lifecycle.startApiServices,'function');
  const events=[],server={listening:false},services={server,toolRepair:{recover:()=>events.push('repair')},toolCurationBuild:{recover:()=>events.push('build')},toolMaintenance:{start:()=>events.push('maintenance')},toolCuration:{start:()=>events.push('curation')}};
  assert.throws(()=>lifecycle.startApiServices(services));assert.deepEqual(events,[]);
  server.listening=true;lifecycle.startApiServices(services);assert.deepEqual(events,['repair','build','maintenance','curation']);
});

test('API starts approval worker before coordinator and drains it during shutdown',async()=>{
  const events=[],server={listening:true,close:cb=>{events.push('http');cb();},waitForTaskCompletion:async()=>{}};
  const services={server,toolApproval:{start:()=>events.push('approval-start'),stop:async()=>events.push('approval-stop')},toolCurationCoordinator:{start:()=>events.push('coordinator-start'),stop:async()=>events.push('coordinator-stop')}};
  lifecycle.startApiServices(services);assert.deepEqual(events,['approval-start','coordinator-start']);
  await lifecycle.createApiShutdown({...services,stores:[{close:()=>events.push('store')}]} )();
  assert.deepEqual(events,['approval-start','coordinator-start','coordinator-stop','approval-stop','http','store']);
});

test('shutdown stops build admission synchronously and drains accepted handoffs before closing every resource',async()=>{
  const events=[];let release;const gate=new Promise(resolve=>release=resolve);
  const shutdown=lifecycle.createApiShutdown({server:{close:cb=>{events.push('http');cb();},waitForTaskCompletion:async()=>events.push('messages')},toolCurationBuild:{stop(){events.push('build-stop');return gate;}},stores:[{close:()=>events.push('store')}],rpcs:[{close:()=>events.push('rpc')}]});
  const first=shutdown();assert.ok(events.includes('build-stop'));await new Promise(resolve=>setImmediate(resolve));assert.equal(events.includes('store'),false);assert.equal(shutdown(),first);
  release();await first;assert.deepEqual(events,['build-stop','http','messages','store','rpc']);
});

test('build drain failure still closes task stores, builder socket and transports',async()=>{
  const events=[];
  const shutdown=lifecycle.createApiShutdown({server:{close:cb=>cb(),waitForTaskCompletion:async()=>{throw Error('task drain');}},toolCurationBuild:{stop(){events.push('build-stop');throw Error('build drain');}},toolsServer:{close:cb=>{events.push('socket');cb();},waitForCalls:()=>events.push('calls')},stores:[{close(){events.push('broken-store');throw Error('store');}},{close:()=>events.push('store')}],rpcs:[{close:()=>events.push('rpc')}]});
  await assert.rejects(shutdown());assert.deepEqual(events,['build-stop','socket','calls','broken-store','store','rpc']);
});

test('bootstrap admission bridge fails closed before initialization and preserves the submission-failure hook',()=>{
  assert.equal(typeof lifecycle.createCurationBuildRegistrationPolicy,'function');
  let service;const bridge=lifecycle.createCurationBuildRegistrationPolicy(()=>service),events=[];
  assert.throws(()=>bridge({},{}));assert.throws(()=>bridge.onSubmissionFailure({requestId:'before-start'}));
  const association={requestId:'ticket'},input={toolName:'shape_tool'},context={taskId:'task'};
  const registration=(value,ctx)=>{assert.equal(value,input);assert.equal(ctx,context);return association;};registration.onSubmissionFailure=(value,ctx)=>events.push([value,ctx]);
  service={registration};assert.equal(bridge(input,context),association);bridge.onSubmissionFailure(association,context);assert.deepEqual(events,[[association,context]]);
});
