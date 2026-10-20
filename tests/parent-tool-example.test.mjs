import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {expectedOutputMatches} from '../packages/capability-platform/tool-contract.mjs';

const draft=JSON.parse(fs.readFileSync(new URL('../examples/05-parent-tool-proposal/proposal.draft.json',import.meta.url)));
const original=JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json',import.meta.url)));
function run(script,input){
  return spawnSync(process.execPath,['--input-type=module','--eval',script],{
    input:JSON.stringify({input}),encoding:'utf8',timeout:5000,maxBuffer:65536,
  });
}
test('child example reports correct canonical counts while retaining previous length and GC outputs',()=>{
  const cases=[
    ['ACGT',{length:4,gcFraction:0.5,baseCounts:{A:1,C:1,G:1,T:1}}],
    ['AACCGGGUUUA',{length:11,gcFraction:0.45454545454545453,baseCounts:{A:3,C:2,G:3,T:3}}],
    ['>target\nggc\ncau\n',{length:6,gcFraction:0.6666666666666666,baseCounts:{A:1,C:2,G:2,T:1}}],
  ];
  for(const [sequence,want] of cases){
    const actual=run(draft.script,{sequence});assert.equal(actual.status,0,actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout),want);
  }
});
test('child example rejects unsupported bases rather than inventing counts',()=>{
  const actual=run(draft.script,{sequence:'ACGN'});assert.notEqual(actual.status,0);assert.equal(actual.stdout,'');
});
test('comparison source is the original candidate, not its deliberately limited baseline',()=>{
  assert.equal(draft.baseline.script,original.script);
  assert.notEqual(draft.baseline.script,original.baseline.script);
  const actual=run(draft.baseline.script,{sequence:'>target\nACGU\n'});
  assert.equal(actual.status,0,actual.stderr);assert.deepEqual(JSON.parse(actual.stdout),{length:4,gcFraction:0.5});
});
test('declared benchmark gain measures the two new counts contracts',()=>{
  let candidate=0,parent=0;
  for(const example of draft.benchmarkCases){
    const a=run(draft.script,example.input),b=run(draft.baseline.script,example.input);
    assert.equal(a.status,0,a.stderr);assert.equal(b.status,0,b.stderr);
    if(expectedOutputMatches(JSON.parse(a.stdout),example.expectedOutput))candidate++;
    if(expectedOutputMatches(JSON.parse(b.stdout),example.expectedOutput))parent++;
  }
  assert.deepEqual({candidate,parent,netGain:candidate-parent},{candidate:3,parent:1,netGain:2});
});
