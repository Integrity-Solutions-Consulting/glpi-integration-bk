import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// All writers must use the same persistent directory (also across containers).
// A stale lock is deliberately not stolen: another machine may still be writing.
export class TransferStore{
constructor(directory,source,destination,options={}){
this.directory=directory;this.path=join(directory,options.journalName??'transfer-journal.json');
this.lockPath=join(directory,options.lockName??'transfer.lock');this.source=source;this.destination=destination;this.lock=null;
}
async acquire(){
await mkdir(this.directory,{recursive:true,mode:0o700});
try{this.lock=await open(this.lockPath,'wx',0o600);}catch(error){
if(error.code==='EEXIST')throw new Error('TRANSFERENCIA_YA_EN_CURSO_O_LOCK_PENDIENTE');
throw error;
}
try{
await this.lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
await this.lock.sync();
try{this.data=JSON.parse(await readFile(this.path,'utf8'));}catch(error){
if(error.code!=='ENOENT')throw error;
this.data={version:1,source:this.source,destination:this.destination,entries:{}};
}
if(this.data.version!==1||this.data.source!==this.source||this.data.destination!==this.destination||
!this.data.entries||typeof this.data.entries!=='object'||Array.isArray(this.data.entries))throw new Error('DIARIO_TRANSFERENCIA_INVALIDO');
}catch(error){await this.release();throw error;}
}
get(id){return this.data.entries[String(id)]??null;}
async save(){
if(!this.lock)throw new Error('TRANSFERENCIA_SIN_LOCK');
const temp=join(this.directory,`.journal-${randomUUID()}.tmp`);
const file=await open(temp,'wx',0o600);
try{await file.writeFile(JSON.stringify(this.data,null,2)+'\n');await file.sync();}finally{await file.close();}
await rename(temp,this.path);
const directory=await open(this.directory,'r');
try{await directory.sync();}finally{await directory.close();}
}
async put(id,entry){
this.data.entries[String(id)]={...entry,updatedAt:new Date().toISOString()};
await this.save();
return this.get(id);
}
async release(){
if(!this.lock)return;
await this.lock.close();this.lock=null;await unlink(this.lockPath);
}
}
