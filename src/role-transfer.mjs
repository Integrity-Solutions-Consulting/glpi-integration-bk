import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {loadConfig} from './config/env.mjs';
import {TMRClient} from './clients/tmr.client.mjs';
import {GLPILegacyClient} from './clients/glpi-legacy.client.mjs';
import {MappingService} from './services/mapping.service.mjs';
import {TransferStore} from './services/transfer-store.service.mjs';

const ROLE_TO_PROFILE=new Map([
['COLABORADOR','Self-Service'],
['LIDER','Technician'],
['GERENCIA','Supervisor'],
['RECURSOS HUMANOS','Observer'],
['ADMINISTRATIVO','Observer']
]);
const norm=value=>String(value??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const idOf=user=>String(user?.idUsuario??user?.id??'');
const log=(name,value)=>console.log(name+' '+JSON.stringify(value));

export async function runRoleTransfer({apply=false,maxWrites=200,onlyId=null}={}){
if(!Number.isSafeInteger(maxWrites)||maxWrites<1||maxWrites>1000)throw new Error('MAX_ROLE_WRITES_INVALIDO');
if(onlyId!==null&&!/^[1-9]\d*$/.test(String(onlyId)))throw new Error('ID_USUARIO_TMR_INVALIDO');
const config=loadConfig();
const directory=resolve(process.env.SYNC_DATA_DIR??'./data');
const store=new TransferStore(directory,config.tmr.url,config.glpi.url+'#roles',{journalName:'role-transfer-journal.json',lockName:'role-transfer.lock'});
const mapping=new MappingService(join(directory,'mappings.json'));
const tmr=new TMRClient(config.tmr);
const legacy=new GLPILegacyClient({...config.glpi,appToken:process.env.GLPI_LEGACY_APP_TOKEN});
const result={mode:apply?'REAL':'PREVALIDACION',assigned:0,alreadyLinked:0,skipped:0,review:0,writeAttempts:0,rows:[]};
await store.acquire();
try{
await mapping.load();
await tmr.authenticate();
await legacy.authenticate();
const users=(await tmr.getUsers()).filter(user=>onlyId===null||idOf(user)===String(onlyId));
if(onlyId!==null&&users.length!==1)throw new Error('USUARIO_TMR_AUSENTE_O_DUPLICADO');
const profiles=await legacy.list('/Profile');
const byName=new Map(profiles.map(profile=>[norm(profile.name),profile]));
const unresolved=[...new Set([...ROLE_TO_PROFILE.values()].filter(name=>!byName.has(norm(name))))];
if(unresolved.length)throw new Error(`PERFILES_GLPI_NO_RESUELTOS:${unresolved.join(',')}`);
const profileIds=new Map([...ROLE_TO_PROFILE].map(([role,name])=>[role,Number(byName.get(norm(name)).id)]));
log('ROLES_TRANSFERENCIA_PLAN',{usuarios:users.length,mapeados:profileIds.size,apply,maxWrites,omitir:['ADMINISTRADOR','Integración GLPI']});
for(const user of users){
const tmrUserId=idOf(user); const roles=Array.isArray(user.roles)?user.roles.map(value=>String(value).trim().toUpperCase()).filter(Boolean):[];
const mapped=roles.filter(role=>ROLE_TO_PROFILE.has(role));
const row=(action,reason,extra={})=>{const value={tmrUserId,roles,action,reason,...extra};result.rows.push(value);log('TRANSFERENCIA_ROL',value);};
if(!tmrUserId||mapped.length===0){result.skipped++;row('OMITIDO','ROL_SIN_MAPEO');continue;}
if(mapped.length>1){
const priorities=['LIDER','GERENCIA','RECURSOS HUMANOS','ADMINISTRATIVO','COLABORADOR'];
mapped.sort((a,b)=>priorities.indexOf(a)-priorities.indexOf(b));
}
const role=mapped[0]; const profileId=profileIds.get(role); const mappingRow=mapping.getByTMR(tmrUserId);
if(!mappingRow){result.review++;row('REVISAR','USUARIO_SIN_VINCULO_GLPI');continue;}
const existing=await legacy.userProfiles(mappingRow.glpiUserId);
if(existing.some(item=>Number(item.profiles_id)===profileId&&Number(item.entities_id)===0)){result.alreadyLinked++;row('YA_VINCULADO',null,{glpiUserId:mappingRow.glpiUserId,profileId,profileName:ROLE_TO_PROFILE.get(role)});continue;}
if(!apply){result.writeAttempts++;row('LISTO_PARA_ASIGNAR',null,{glpiUserId:mappingRow.glpiUserId,profileId,profileName:ROLE_TO_PROFILE.get(role)});continue;}
if(result.writeAttempts>=maxWrites){row('PENDIENTE_LIMITE');continue;}
await store.put(tmrUserId,{status:'sent',glpiUserId:mappingRow.glpiUserId,profileId,role}); result.writeAttempts++;
try{await legacy.assignUserProfile(mappingRow.glpiUserId,profileId,0); if(!await legacy.verifyUserProfile(mappingRow.glpiUserId,profileId,0))throw new Error('ASIGNACION_PERFIL_NO_VERIFICADA'); await store.put(tmrUserId,{status:'complete',glpiUserId:mappingRow.glpiUserId,profileId,role}); result.assigned++;row('ASIGNADO_Y_VERIFICADO',null,{glpiUserId:mappingRow.glpiUserId,profileId,profileName:ROLE_TO_PROFILE.get(role)});}catch(error){await store.put(tmrUserId,{status:'error',glpiUserId:mappingRow.glpiUserId,profileId,role,error:error.message});result.review++;row('REVISAR',error.message);break;}
}
await writeFile(join(directory,'last-role-transfer-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
log('TRANSFERENCIA_ROLES_RESULTADO',{...result,rows:undefined}); return result;
}catch(error){result.error=error.message;await writeFile(join(directory,'last-role-transfer-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600}).catch(()=>{});throw error;
}finally{try{await legacy.close();}catch{}await store.release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
try{try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
const args=process.argv.slice(2),allowed=/^(--apply|--max=\d+|--id=\d+)$/;
if(args.some(arg=>!allowed.test(arg)))throw new Error('Uso: npm run role-transfer -- [--apply] [--max=200] [--id=ID_TMR]');
const value=name=>args.find(arg=>arg.startsWith(`--${name}=`))?.split('=')[1];
await runRoleTransfer({apply:args.includes('--apply'),maxWrites:Number(value('max')??200),onlyId:value('id')??null});
}catch(error){console.error('TRANSFERENCIA_ROLES_ERROR '+error.message);process.exitCode=1;}
}
