import fs from 'node:fs';
import path from 'node:path';
import {ensureDirectory} from '../../packages/agent-runtime/compose-session-store.mjs';

export async function listenToolSocket(server,{root}) {
  if(process.platform!=='linux')throw new Error('The private tool API requires Linux');
  const directory=ensureDirectory(path.resolve(root),'runtime/agent-tools');
  if((fs.statSync(directory).mode&0o777)!==0o700)throw new Error('Tool API directory must be private (0700)');
  const socket=path.join(directory,'api.sock');
  try { fs.lstatSync(socket);throw new Error('Tool API socket already exists; inspect its owner before restarting'); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  await new Promise((resolve,reject)=>{
    const error=e=>{server.off('listening',ready);reject(e);};
    const ready=()=>{server.off('error',error);resolve();};
    server.once('error',error);server.once('listening',ready);server.listen(socket);
  });
  try { fs.chmodSync(socket,0o600); }
  catch(error) { await new Promise(resolve=>server.close(resolve));throw error; }
  return socket;
}
