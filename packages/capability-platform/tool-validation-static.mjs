// Independent lexical checks for the reference Node/offline policy. Matching a
// comment can fail; obfuscated code can evade these rules. Containers still apply.
const rules=[
  ['STATIC_HTTP_CLIENT_COMMAND','HTTP客户端命令',/\b(curl|wget)\b/gi,true],
  ['STATIC_REMOTE_SHELL_OR_RAW_SOCKET_COMMAND','远程命令或原始网络工具',/\b(ssh|scp|nc|ncat)\b/gi],
  ['STATIC_DOCKER_CONTROL_SOCKET','Docker控制接口',/\/var\/run\/docker\.sock|\\\\\.\\pipe\\docker_engine/gi],
  ['STATIC_RUNTIME_PACKAGE_INSTALL','运行时安装软件',/\b(sudo|apt|apt-get|apk|dnf|yum|micromamba|conda|pip|npm)\s+(install|create|add)\b/gi],
  ['STATIC_DYNAMIC_CODE_EVALUATION','动态代码执行',/\b(eval|Function)\s*\(/g],
  ['STATIC_RECURSIVE_DELETION','递归强制删除',/\brm\s+-rf\b|\bRemove-Item[^\n]*-Recurse/gi],
  ['STATIC_HOST_ABSOLUTE_PATH','主机敏感目录',/(?:^|[^\w])\/(etc|proc|sys|root|home)\//gm],
  ['STATIC_NODE_PROCESS_API','Node进程接口',/\b(?:node:)?child_process\b/g,true],
  ['STATIC_NODE_SHELL_EXECUTION','Node shell执行',/\b(exec|execSync)\s*\(/g],
  ['STATIC_NODE_RAW_NETWORK_API','Node原始网络接口',/node:(net|tls)\b|(?:from|require\s*\()\s*["'](net|tls)["']/g],
  ['STATIC_NODE_HTTP_API','Node HTTP接口',/node:https?\b|(?:from|require\s*\()\s*["']https?["']|\bfetch\s*\(/g,true],
];
export function assertValidationSupported(input) {
  if(input.runtime!=='node'||input.baseline?.runtime!=='node'||!Array.isArray(input.dependencies)||input.dependencies.length||
    input.permissions?.profile!=='no_external_access'||input.repeatabilityMode!=='exact') {
    throw new Error('Validation supports only node candidate/baseline, no dependencies, no_external_access and exact');
  }
  for(const cases of [input.testCases,input.benchmarkCases]) {
    if(!Array.isArray(cases)||cases.length<1||cases.length>10)throw new Error('Validation supports one to ten cases per group');
  }
  for(const value of [input.smokeInput,...input.testCases.map(x=>x.input),...input.benchmarkCases.map(x=>x.input)]) {
    if(Buffer.byteLength(JSON.stringify(value))>65536)throw new Error('Validation input exceeds the 64KiB limit');
  }
}
export function checkValidationSource(manifest,input) {
  assertValidationSupported(input);
  const violations=[];
  for(const [target,file,source] of [['candidate',manifest.scriptFile,input.script],['baseline',manifest.baselineScriptFile,input.baseline.script]]) {
    for(const [ruleId,title,pattern,profileSpecific] of rules) {
      for(const match of source.matchAll(new RegExp(pattern))) {
        const before=source.slice(0,match.index);const lineStart=before.lastIndexOf('\n')+1;
        const lineEnd=source.indexOf('\n',match.index);
        const profiles=['no_external_access','controlled_network','controlled_software'];
        const allowedUnderProfiles=profileSpecific?[ruleId==='STATIC_NODE_PROCESS_API'?'controlled_software':'controlled_network']:[];
        violations.push({ruleId,title,description:title,detector:'lexical-pattern/v1',target,file,
          line:before.split('\n').length,column:match.index-lineStart+1,
          matchedText:match[0].slice(0,1000),sourceLine:source.slice(lineStart,lineEnd<0?source.length:lineEnd).replace(/\r$/,'').slice(0,1000),
          selectedProfile:'no_external_access',blockedUnderProfiles:profiles.filter(p=>!allowedUnderProfiles.includes(p)),allowedUnderProfiles});
        if(violations.length>=1000)break;
      }
      if(violations.length>=1000)break;
    }
    if(violations.length>=1000)break;
  }
  return {passed:violations.length===0,permissionProfile:'no_external_access',permissionPolicy:{
    selectedProfile:'no_external_access',permissions:manifest.permissions,validatorRoute:'restricted-offline',relaxedRuleIds:[],
    enforcedProfileRuleIds:rules.filter(r=>r[3]).map(r=>r[0]),alwaysProhibitedRuleIds:rules.filter(r=>!r[3]).map(r=>r[0]),
    explanation:'Lexical checks only; this learning validator supports offline Node tools. Patterns are not a security proof.',
  },violations,issues:violations.map(v=>`${v.target}: [${v.ruleId}] ${v.file}:${v.line}:${v.column}`)};
}
