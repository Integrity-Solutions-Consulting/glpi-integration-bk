import {findTMRDuplicates,getTMRLogin,getTMREmail,identityOverlaps} from '../utils/identity.mjs';

const PROTECTED_LOGINS=new Set(['glpi','glpi-system','tmr-sync','post-only','tech','normal']);
const normalize=value=>String(value??'').trim().toLowerCase();
const raw=value=>String(value??'').trim();
const validId=value=>/^[1-9]\d*$/.test(raw(value));
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(value));
const isActive=value=>value===true||value===1||['1','true'].includes(normalize(value));

function userId(user){
return raw(user?.idUsuario??user?.id);
}
function personaId(user){
return raw(user?.idPersona);
}
function firstValue(...values){
for(const value of values){
if(value!==null&&value!==undefined&&raw(value))return raw(value);
}
return '';
}
function loginOf(user){
return getTMRLogin(user);
}
function emailOf(user){
return getTMREmail(user);
}
function result(tmrUserId,status,reason,extra={}){
return {
tmrUserId,
status,
action:status==='BLOQUEADO'?'BLOQUEADO':'PENDIENTE_VALIDACION',
reason,
approved:false,
writesEnabled:false,
changesApplied:0,
...extra
};
}
async function mappingRows(mapping){
if(Array.isArray(mapping))return mapping;
if(!mapping||typeof mapping.getAll!=='function'){
throw new Error('VINCULACIONES_TMR_GLPI_NO_DISPONIBLES');
}
const rows=await mapping.getAll();
if(!Array.isArray(rows)){
throw new Error('MAPPING_SERVICE_RESPUESTA_INVALIDA');
}
return rows;
}
function add(index,key,value){
if(!key)return;
if(!index.has(key))index.set(key,[]);
index.get(key).push(value);
}
function buildIndexes(users,plan,mappings){
const findTMRDuplicatesCached=findTMRDuplicates(users);
const index={
duplicateReasons:new Map(users.map((user,index)=>[user,findTMRDuplicatesCached[index]])),
byUser:new Map(),
byPersona:new Map(),
byEmail:new Map(),
byLogin:new Map(),
byPlan:new Map(),
linkedUsers:new Set(),
linkedPeople:new Set()
};
for(const user of users){
add(index.byUser,userId(user),user);
add(index.byPersona,personaId(user),user);
add(index.byEmail,emailOf(user),user);
add(index.byLogin,loginOf(user),user);
}
for(const operation of plan){
add(index.byPlan,raw(operation?.tmrUserId),operation);
}
for(const row of mappings){
if(validId(row?.tmrUserId))index.linkedUsers.add(raw(row.tmrUserId));
if(validId(row?.personaId))index.linkedPeople.add(raw(row.personaId));
}
return index;
}
function validateCandidate(operation,index){
const tmrUserId=raw(operation?.tmrUserId);
if(!validId(tmrUserId)){
return result(tmrUserId,'BLOQUEADO','ID_TMR_INVALIDO');
}
if(operation.action!=='CREAR_CANDIDATO'){
return result(tmrUserId,'BLOQUEADO','PLAN_NO_AUTORIZA_CREACION');
}
const matches=index.byUser.get(tmrUserId)??[];
if(matches.length!==1){
return result(tmrUserId,'BLOQUEADO','USUARIO_TMR_AUSENTE_O_DUPLICADO');
}
const user=matches[0];
const duplicateReasons=index.duplicateReasons.get(user)??[];
if(duplicateReasons.length)return result(tmrUserId,'BLOQUEADO',duplicateReasons[0]);
const person=personaId(user);
const login=loginOf(user);
const email=emailOf(user);
if(!isActive(user.activo)){
return result(tmrUserId,'BLOQUEADO','USUARIO_TMR_INACTIVO');
}
if(!validId(person)){
return result(tmrUserId,'BLOQUEADO','PERSONA_TMR_INVALIDA');
}
if(!validEmail(email)){
return result(tmrUserId,'BLOQUEADO','EMAIL_TMR_INVALIDO');
}
if(!login||PROTECTED_LOGINS.has(login)){
return result(tmrUserId,'BLOQUEADO','LOGIN_TMR_NO_PERMITIDO');
}
if((index.byPersona.get(person)??[]).length!==1){
return result(tmrUserId,'BLOQUEADO','PERSONA_TMR_DUPLICADA');
}
if((index.byEmail.get(email)??[]).length!==1){
return result(tmrUserId,'BLOQUEADO','EMAIL_TMR_DUPLICADO');
}
if((index.byLogin.get(login)??[]).length!==1){
return result(tmrUserId,'BLOQUEADO','LOGIN_TMR_DUPLICADO');
}
if((index.byPlan.get(tmrUserId)??[]).length!==1){
return result(tmrUserId,'BLOQUEADO','PLAN_TMR_DUPLICADO');
}
if(operation.personaId!=null&&raw(operation.personaId)!==person){
return result(tmrUserId,'BLOQUEADO','PERSONA_PLAN_NO_COINCIDE');
}
if(operation.glpiUserId!=null){
return result(tmrUserId,'BLOQUEADO','USUARIO_GLPI_YA_ASIGNADO');
}
if(index.linkedUsers.has(tmrUserId)||index.linkedPeople.has(person)){
return result(tmrUserId,'BLOQUEADO','VINCULACION_EXISTENTE');
}
if(operation.profileVerified!==true){
return result(tmrUserId,'BLOQUEADO','PERFIL_PLAN_NO_VERIFICADO');
}
const profileName=firstValue(operation.resolvedProfileName,operation.proposedProfileName,operation.profileName);
if(!profileName){
return result(tmrUserId,'BLOQUEADO','PERFIL_GLPI_NO_DEFINIDO');
}
return result(tmrUserId,'PENDIENTE_VALIDACION','IDENTIDAD_TMR_VALIDADA',{
personaId:person,
login,
email,
profileName,
proposedProfileId:operation.proposedProfileId??null
});
}
function collectEmails(value,emails,visited=new WeakSet()){
if(value==null)return;
if(typeof value==='string'){
const email=normalize(value);
if(validEmail(email))emails.add(email);
return;
}
if(typeof value!=='object'||visited.has(value))return;
visited.add(value);
if(Array.isArray(value)){
for(const item of value)collectEmails(item,emails,visited);
return;
}
for(const key of ['email','mail','correo','address','value','emails','useremails','emailAddress','email_address']){
if(Object.hasOwn(value,key))collectEmails(value[key],emails,visited);
}
}
function visibleConflicts(existing,login,email){
const conflicts=[];
for(const user of existing){
const existingLogin=normalize(user?.username??user?.name??user?.login);
const emails=new Set();
for(const field of ['email','mail','correo','emails','useremails','emailAddress','email_address']){
collectEmails(user?.[field],emails);
}
if(identityOverlaps(login,email,user)){
conflicts.push({
glpiUserId:user.id??null,
loginMatch:existingLogin===login||existingLogin===email,
emailMatch:emails.has(email)
});
}
}
return conflicts;
}
function candidateResult(candidate,identity){
const complete=identity.inventoryComplete===true;
const detailErrors=identity.detailErrors;
const detailsValid=detailErrors===0;
const safe=complete&&identity.safeToCreate===true&&detailsValid;
return result(
candidate.tmrUserId,
'PENDIENTE_VALIDACION',
safe?'IDENTIDAD_GLPI_VERIFICADA':'COBERTURA_GLPI_PENDIENTE',
{
personaId:candidate.personaId,
login:candidate.login,
email:candidate.email,
profileName:candidate.profileName,
proposedProfileId:candidate.proposedProfileId,
inventoryComplete:complete,
safeToCreate:safe,
detailErrors:detailErrors??null,
checkedUsers:identity.checkedUsers??null,
reasonGLPI:identity.reason??null,
readyToWrite:false,
validationScope:complete?'GLOBAL_VERIFICADO':'INVENTARIO_VISIBLE'
}
);
}
function summary(users,results,extra={}){
return {
status:'PREVALIDACION_COMPLETADA',
totalUsuariosTMR:users.length,
totalCandidatos:results.length,
bloqueados:results.filter(row=>row.status==='BLOQUEADO').length,
pendientes:results.filter(row=>row.status==='PENDIENTE_VALIDACION').length,
inventoryComplete:results.length>0&&results.every(row=>row.inventoryComplete===true),
writesEnabled:false,
changesApplied:0,
...extra,
results
};
}
export function preparePilotSync({users,plan,existing,mappings,glpiInventoryComplete=false}={}){
if(!Array.isArray(users)||!Array.isArray(plan)||!Array.isArray(existing)||!Array.isArray(mappings)){
throw new Error('DATOS_REALES_TMR_GLPI_INVALIDOS');
}
const index=buildIndexes(users,plan,mappings);
const operations=plan.filter(row=>row?.action==='CREAR_CANDIDATO');
const results=[];
const seen=new Set();
for(const operation of operations){
const candidate=validateCandidate(operation,index);
const tmrUserId=candidate.tmrUserId;
if(seen.has(tmrUserId)){
results.push(result(tmrUserId,'BLOQUEADO','CANDIDATO_DUPLICADO_EN_PLAN'));
continue;
}
seen.add(tmrUserId);
if(candidate.status==='BLOQUEADO'){
results.push(candidate);
continue;
}
const conflicts=visibleConflicts(existing,candidate.login,candidate.email);
if(conflicts.length){
results.push(result(tmrUserId,'BLOQUEADO','DUPLICADO_GLPI_VISIBLE',{conflicts}));
continue;
}
results.push(candidateResult(candidate,{
inventoryComplete:glpiInventoryComplete===true,
safeToCreate:false,
detailErrors:null,
checkedUsers:existing.length,
reason:glpiInventoryComplete===true?'VERIFICACION_IDENTIDAD_ADICIONAL_PENDIENTE':'COBERTURA_GLOBAL_GLPI_NO_VERIFICADA'
}));
}
return summary(users,results,{
totalUsuariosGLPIVisibles:existing.length,
inventoryComplete:glpiInventoryComplete===true
});
}
export async function preparePilot({users,plan,glpi,mapping}={}){
if(!Array.isArray(users)||!Array.isArray(plan)){
throw new Error('USUARIOS_O_PLAN_TMR_INVALIDOS');
}
if(!glpi||typeof glpi.findIdentityConflicts!=='function'||typeof glpi.resolveProfileByName!=='function'){
throw new Error('CLIENTE_GLPI_INCOMPLETO');
}
if(!mapping||typeof mapping.getAll!=='function'){
throw new Error('MAPPING_SERVICE_NO_DISPONIBLE');
}
if(typeof mapping.load==='function')await mapping.load();
const mappings=await mappingRows(mapping);
const index=buildIndexes(users,plan,mappings);
const operations=plan.filter(row=>row?.action==='CREAR_CANDIDATO');
const results=[];
const seen=new Set();
for(const operation of operations){
const candidate=validateCandidate(operation,index);
const tmrUserId=candidate.tmrUserId;
if(seen.has(tmrUserId)){
results.push(result(tmrUserId,'BLOQUEADO','CANDIDATO_DUPLICADO_EN_PLAN'));
continue;
}
seen.add(tmrUserId);
if(candidate.status==='BLOQUEADO'){
results.push(candidate);
continue;
}
try{
const identity=await glpi.findIdentityConflicts(candidate.login,candidate.email);
if(!identity||!Array.isArray(identity.conflicts)){
results.push(result(tmrUserId,'BLOQUEADO','RESPUESTA_GLPI_INVALIDA'));
continue;
}
if(identity.conflicts.length){
results.push(result(tmrUserId,'BLOQUEADO','DUPLICADO_GLPI',{conflicts:identity.conflicts}));
continue;
}
const profile=await glpi.resolveProfileByName(candidate.profileName);
if(!profile||!validId(profile.id)||!raw(profile.name)){
results.push(result(tmrUserId,'BLOQUEADO','PERFIL_GLPI_INVALIDO'));
continue;
}
if(candidate.proposedProfileId!=null&&raw(candidate.proposedProfileId)!==raw(profile.id)){
results.push(result(tmrUserId,'BLOQUEADO','PERFIL_GLPI_NO_COINCIDE'));
continue;
}
const checked=candidateResult(candidate,identity);
results.push({
...checked,
profileId:Number(profile.id),
profileName:profile.name
});
}catch(error){
results.push(result(tmrUserId,'BLOQUEADO','ERROR_VALIDACION_GLPI',{
message:error?.message??'Error desconocido'
}));
}
}
const response=summary(users,results);
console.log('TMR_GLPI_PREVALIDACION '+JSON.stringify({
totalCandidatos:response.totalCandidatos,
bloqueados:response.bloqueados,
pendientes:response.pendientes,
inventoryComplete:response.inventoryComplete,
writesEnabled:false
}));
return response;
}
