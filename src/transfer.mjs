import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {loadConfig} from './config/env.mjs';
import {TMRClient} from './clients/tmr.client.mjs';
import {GLPIClient} from './clients/glpi.client.mjs';
import {GLPILegacyClient,legacyUserInput,canAssignProfile} from './clients/glpi-legacy.client.mjs';
import {TransferStore} from './services/transfer-store.service.mjs';
import {MappingService} from './services/mapping.service.mjs';
import {auditTransfer} from './services/transfer-audit.service.mjs';
import {propose} from './services/proposal.service.mjs';
import {buildSyncPlan} from './services/sync-plan.service.mjs';
import {todayEcuador} from './utils/dates.mjs';
import {getTMRLogin,getTMREmail,getGLPILogin,getGLPIEmails,identityOverlaps,findTMRDuplicates} from './utils/identity.mjs';

const log=(name,value)=>console.log(name+' '+JSON.stringify(value));
const tmrId=user=>String(user.idUsuario??user.id);

export async function runTransfer({apply=false,maxCreates=1,onlyId=null}={}){
if(!Number.isSafeInteger(maxCreates)||maxCreates<1||maxCreates>1000)throw new Error('MAX_CREATES_INVALIDO');
if(onlyId!==null&&!/^[1-9]\d*$/.test(String(onlyId)))throw new Error('ID_TMR_INVALIDO');
const config=loadConfig();
const directory=resolve(process.env.SYNC_DATA_DIR??'./data');
const store=new TransferStore(directory,config.tmr.url,config.glpi.url);
const mapping=new MappingService(join(directory,'mappings.json'));
const tmr=new TMRClient(config.tmr);
const hl=new GLPIClient(config.glpi);
const legacy=new GLPILegacyClient({...config.glpi,appToken:process.env.GLPI_LEGACY_APP_TOKEN});
const result={mode:apply?'REAL':'PREVALIDACION',created:0,recovered:0,alreadyLinked:0,review:0,planned:0,writeAttempts:0,rows:[]};
await store.acquire();
try{
await mapping.load();
await tmr.authenticate();
await hl.authenticate();
// Fail before any creation if legacy authentication, scope or reads are unavailable.
await legacy.authenticate();
await legacy.selectGlobalScope();
let existing=await legacy.inventory();
const users=await tmr.getUsers();
const duplicates=findTMRDuplicates(users);
const employees=await tmr.getEmployees();
const leaders=await tmr.getLeaders();
const projects=await tmr.getProjects();
const profiles=await hl.getProfiles();
const report=propose(users,employees,leaders,projects,existing,config.supportProjectCode,todayEcuador());
const plan=buildSyncPlan(report,existing,{availableProfiles:profiles,inventoryComplete:true});
const audit=auditTransfer({users,existing,mappings:mapping.getAll(),inventoryComplete:true,detailErrors:0});
log('TRANSFERENCIA_PLAN',{usersTMR:users.length,usersGLPI:existing.length,apply,maxCreates,onlyId,
globalScope:legacy.context.globalScope,canCreate:legacy.context.canCreate});
if(apply&&!legacy.context.canCreate)throw new Error('GLPI_SIN_PERMISO_CREACION');
const selected=users.filter(user=>onlyId===null||tmrId(user)===String(onlyId));
if(onlyId!==null&&selected.length!==1)throw new Error('USUARIO_TMR_AUSENTE_O_DUPLICADO');
const handled=new Set();
const profileDetails=new Map();
for(const user of selected){
const id=tmrId(user);
const record=(action,reason,extra={})=>{
const row={tmrUserId:id,action,reason,...extra};result.rows.push(row);log('TRANSFERENCIA_USUARIO',row);
};
if(handled.has(id)){record('REVISAR','ID_TMR_DUPLICADO');result.review++;continue;}
handled.add(id);
const sourceIndex=users.indexOf(user);
if(duplicates[sourceIndex].length){result.review++;record('REVISAR',duplicates[sourceIndex][0]);continue;}
const reconciled=audit.rows.find(row=>row.tmrUserId===id);
const operation=plan.find(row=>String(row.tmrUserId)===id);
let entry=store.get(id);
// The durable attempt is checked before the plan: it can match an interrupted creation.
if(entry){
if(entry.personaId!==String(user.idPersona)||entry.input.name!==getTMRLogin(user)||
entry.input._useremails['-1']!==getTMREmail(user)||user.activo!==true){
record('REVISAR','IDENTIDAD_TMR_CAMBIO_DESPUES_DEL_INTENTO');result.review++;continue;
}
const matches=existing.filter(target=>identityOverlaps(entry.input.name,entry.input._useremails['-1'],target));
const owned=matches.filter(target=>target.comment===entry.input.comment&&(!entry.glpiUserId||String(target.id)===String(entry.glpiUserId)));
if(owned.length!==1||matches.length!==1){
record('REVISAR','INTENTO_PREVIO_NO_RESUELTO_NO_REINTENTAR');result.review++;continue;
}
try{
await legacy.verifyCreated(owned[0].id,entry.input);
if(apply){
await mapping.register({tmrUserId:id,personaId:entry.personaId,glpiUserId:owned[0].id,
login:entry.input.name,email:entry.input._useremails['-1'],verified:true});
await store.put(id,{...entry,status:'complete',glpiUserId:owned[0].id});
}
if(entry.status==='complete'){result.alreadyLinked++;record('YA_VINCULADO',null,{glpiUserId:owned[0].id});}
else{result.recovered++;record(apply?'RECUPERADO':'RECUPERABLE',null,{glpiUserId:owned[0].id});}
}catch(error){result.review++;record('REVISAR',error.message);}
continue;
}
if(reconciled?.action==='YA_VINCULADO'){
result.alreadyLinked++;record('YA_VINCULADO',null,{glpiUserId:reconciled.glpiUserId});continue;
}
// Existing GLPI accounts can be adopted automatically only when both stable
// identities match exactly and there is exactly one destination candidate.
// This repairs missing historical mappings without guessing from names.
if(reconciled?.action==='REVISAR_MANUALMENTE'&&
reconciled.reasons.length===1&&
reconciled.reasons[0]==='CUENTA_GLPI_EXISTENTE_SIN_VINCULO'&&
user.activo===true){
const login=getTMRLogin(user);
const email=getTMREmail(user);
const exactMatches=existing.filter(target=>
getGLPILogin(target)===login&&getGLPIEmails(target).has(email)
);
if(exactMatches.length===1&&mapping.getByGLPI(exactMatches[0].id)===null){
try{
await mapping.register({tmrUserId:id,personaId:user.idPersona,glpiUserId:exactMatches[0].id,
login,email,verified:true});
result.alreadyLinked++;
record('VINCULADO_EXISTENTE_VERIFICADO',null,{glpiUserId:exactMatches[0].id});
continue;
}catch(error){
record('REVISAR',error.message);
result.review++;
continue;
}
}
}
if(reconciled?.action!=='CREAR_CANDIDATO'||operation?.action!=='CREAR_CANDIDATO'){
result.review++;record('REVISAR',reconciled?.reasons[0]??operation?.reason??'IDENTIDAD_NO_VERIFICADA');continue;
}
const profile=await hl.resolveProfileByName(operation.proposedProfileName);
if(!profileDetails.has(profile.id)){
const {data}=await legacy.call(`/Profile/${profile.id}`);
profileDetails.set(profile.id,data);
}
const targetProfile=profileDetails.get(profile.id);
if(!canAssignProfile(legacy.session.glpiactiveprofile,targetProfile)){
result.review++;record('REVISAR','GLPI_PERFIL_NO_ASIGNABLE',{profileId:profile.id});continue;
}
const marker='tmr-glpi-sync:'+randomUUID();
let input=legacyUserInput(user,profile.id,0,marker);
if(!apply){result.planned++;record('LISTO_PARA_CREAR',null,{profileId:profile.id});continue;}
if(result.writeAttempts>=maxCreates){result.planned++;record('PENDIENTE_LIMITE',null);continue;}
// Re-read source identity and destination immediately before the durable attempt.
const fresh=await tmr.getUser(id);
if(tmrId(fresh)!==id||String(fresh.idPersona)!==String(user.idPersona)||fresh.activo!==true||
getTMRLogin(fresh)!==input.name||getTMREmail(fresh)!==input._useremails['-1']){
result.review++;record('REVISAR','USUARIO_TMR_CAMBIO_DURANTE_TRANSFERENCIA');continue;
}
input=legacyUserInput(fresh,profile.id,0,marker);
if(existing.some(target=>identityOverlaps(input.name,input._useremails['-1'],target))){
result.review++;record('REVISAR','IDENTIDAD_GLPI_EXISTENTE');continue;
}
// Save intent BEFORE POST; a timeout is never followed by another blind POST.
entry=await store.put(id,{status:'sent',personaId:String(user.idPersona),input,startedAt:new Date().toISOString()});
result.writeAttempts++;
try{
const glpiUserId=await legacy.create(input);
entry=await store.put(id,{...entry,status:'created',glpiUserId});
const created=await legacy.verifyCreated(glpiUserId,input);
await mapping.register({tmrUserId:id,personaId:user.idPersona,glpiUserId,login:input.name,
email:input._useremails['-1'],verified:true});
await store.put(id,{...entry,status:'complete'});
existing.push(created);result.created++;
record('CREADO_Y_VERIFICADO',null,{glpiUserId,profileId:profile.id});
}catch(error){
await store.put(id,{...entry,error:error.message});
result.review++;record('REVISAR_RESULTADO_ALTA',error.message);
break; // A partially created user stops the batch; never hide uncertainty.
}
}
await writeFile(join(directory,'last-transfer-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
log('TRANSFERENCIA_RESULTADO',{...result,rows:undefined});
return result;
}catch(error){
result.error=error.message;
await writeFile(join(directory,'last-transfer-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600}).catch(()=>{});
throw error;
}finally{
try{await legacy.close();}catch{log('GLPI_LEGACY_CIERRE',{status:'ERROR'});}
await store.release();
}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
try{
try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
const args=process.argv.slice(2);
const allowed=/^(--apply|--max=\d+|--id=\d+)$/;
if(args.some(arg=>!allowed.test(arg)))throw new Error('Uso: npm run transfer -- [--apply] [--max=1] [--id=ID_TMR]');
const value=name=>args.find(arg=>arg.startsWith(`--${name}=`))?.split('=')[1];
const result=await runTransfer({apply:args.includes('--apply'),maxCreates:Number(value('max')??1),onlyId:value('id')??null});
if(result.rows.some(row=>row.action==='REVISAR_RESULTADO_ALTA'))process.exitCode=1;
}catch(error){console.error('TRANSFERENCIA_ERROR '+error.message);process.exitCode=1;}
}
