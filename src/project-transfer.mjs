import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {loadConfig} from './config/env.mjs';
import {TMRClient} from './clients/tmr.client.mjs';
import {GLPILegacyClient,legacyProjectInput} from './clients/glpi-legacy.client.mjs';
import {TransferStore} from './services/transfer-store.service.mjs';

const log=(name,value)=>console.log(name+' '+JSON.stringify(value));
const projectId=project=>String(project?.id??'');
const markerFor=(id)=>`tmr-glpi-project:${id}`;

export async function runProjectTransfer({apply=false,maxCreates=200,onlyId=null}={}){
if(!Number.isSafeInteger(maxCreates)||maxCreates<1||maxCreates>1000)throw new Error('MAX_PROJECT_CREATES_INVALIDO');
if(onlyId!==null&&!/^[1-9]\d*$/.test(String(onlyId)))throw new Error('ID_PROYECTO_TMR_INVALIDO');
const config=loadConfig();
const directory=resolve(process.env.SYNC_DATA_DIR??'./data');
const store=new TransferStore(directory,config.tmr.url,config.glpi.url+'#projects',{journalName:'project-transfer-journal.json',lockName:'project-transfer.lock'});
const tmr=new TMRClient(config.tmr);
const legacy=new GLPILegacyClient({...config.glpi,appToken:process.env.GLPI_LEGACY_APP_TOKEN});
const result={mode:apply?'REAL':'PREVALIDACION',created:0,recovered:0,alreadyLinked:0,review:0,planned:0,writeAttempts:0,rows:[]};
await store.acquire();
try{
await tmr.authenticate();
await legacy.authenticate();
const projects=await tmr.getProjects();
const selected=projects.filter(project=>onlyId===null||projectId(project)===String(onlyId));
if(onlyId!==null&&selected.length!==1)throw new Error('PROYECTO_TMR_AUSENTE_O_DUPLICADO');
let existing;
try{existing=await legacy.inventoryProjects();}
catch(error){
log('PROYECTOS_GLPI_NO_CONSULTABLES',{reason:error.message,required:'permiso project de lectura'});
throw error;
}
const byMarker=new Map(existing.map(item=>[String(item.comment??'').match(/tmr-glpi-project:[a-f0-9-]+/)?.[0]??'',item]).filter(([key])=>key));
log('PROYECTOS_TRANSFERENCIA_PLAN',{proyectosTMR:projects.length,proyectosGLPI:existing.length,seleccionados:selected.length,apply,maxCreates});
for(const project of selected){
const id=projectId(project);
const row=(action,reason,extra={})=>{const value={tmrProjectId:id,action,reason,...extra};result.rows.push(value);log('TRANSFERENCIA_PROYECTO',value);};
if(!id||!String(project.codigo??'').trim()||!String(project.nombre??'').trim()){result.review++;row('REVISAR','IDENTIDAD_PROYECTO_TMR_INCOMPLETA');continue;}
let entry=store.get(id);
const marker=entry?.input?.comment?.match(/^tmr-glpi-project:[a-f0-9-]{36}/)?.[0]??markerFor(randomUUID());
const owned=byMarker.get(marker);
if(owned){
try{
await legacy.verifyCreatedProject(owned.id,entry?.input??legacyProjectInput(project,0,marker));
if(entry?.status==='complete'){result.alreadyLinked++;row('YA_VINCULADO',null,{glpiProjectId:owned.id});}
else{result.recovered++;row(apply?'RECUPERADO':'RECUPERABLE',null,{glpiProjectId:owned.id});}
if(apply&&entry?.status!=='complete')await store.put(id,{...entry,status:'complete',glpiProjectId:owned.id});
}catch(error){result.review++;row('REVISAR',error.message);}
continue;
}
if(entry&&entry.status!=='complete'){result.review++;row('REVISAR','INTENTO_PREVIO_NO_RESUELTO_NO_REINTENTAR');continue;}
const input=legacyProjectInput(project,0,marker);
if(existing.some(item=>String(item.name??'').trim().toLowerCase()===input.name.toLowerCase())){result.review++;row('REVISAR','NOMBRE_PROYECTO_GLPI_EXISTENTE');continue;}
if(!apply){result.planned++;row('LISTO_PARA_CREAR');continue;}
if(result.writeAttempts>=maxCreates){result.planned++;row('PENDIENTE_LIMITE');continue;}
entry=await store.put(id,{status:'sent',input,startedAt:new Date().toISOString()});
result.writeAttempts++;
try{
const glpiProjectId=await legacy.createProject(input);
entry=await store.put(id,{...entry,status:'created',glpiProjectId});
const created=await legacy.verifyCreatedProject(glpiProjectId,input);
await store.put(id,{...entry,status:'complete'});
existing.push(created);byMarker.set(marker,created);result.created++;
row('CREADO_Y_VERIFICADO',null,{glpiProjectId});
}catch(error){await store.put(id,{...entry,error:error.message});result.review++;row('REVISAR_RESULTADO_ALTA',error.message);break;}
}
await writeFile(join(directory,'last-project-transfer-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
log('TRANSFERENCIA_PROYECTOS_RESULTADO',{...result,rows:undefined});
return result;
}catch(error){result.error=error.message;await writeFile(join(directory,'last-project-transfer-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600}).catch(()=>{});throw error;
}finally{try{await legacy.close();}catch{}await store.release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
try{try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
const args=process.argv.slice(2);const allowed=/^(--apply|--max=\d+|--id=\d+)$/;
if(args.some(arg=>!allowed.test(arg)))throw new Error('Uso: npm run project-transfer -- [--apply] [--max=200] [--id=ID_TMR]');
const value=name=>args.find(arg=>arg.startsWith(`--${name}=`))?.split('=')[1];
await runProjectTransfer({apply:args.includes('--apply'),maxCreates:Number(value('max')??200),onlyId:value('id')??null});
}catch(error){console.error('TRANSFERENCIA_PROYECTOS_ERROR '+error.message);process.exitCode=1;}
}
