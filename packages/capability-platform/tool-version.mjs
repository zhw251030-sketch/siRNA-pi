// Canonical stored version identities: prereleases and unsafe integers are not identities.
export function toolVersion(value) {
  if(typeof value!=='string'||/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value)?.[0]!==value||
    !value.split('.').every(part=>Number.isSafeInteger(Number(part))))throw new Error('Invalid canonical tool version');
  return value;
}
export function versionParts(value){return toolVersion(value).split('.').map(Number);}
export function earlierParent(parent,child){
  const a=versionParts(parent),b=versionParts(child);
  return a[0]===b[0]&&a[1]===b[1]&&a[2]<b[2];
}
export function maintenanceText(value,label,max=120){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`${label} must be nonempty text of at most ${max} characters without controls`);
  return value.trim();
}
