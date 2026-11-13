
import {preparePilot} from './pilot-sync.service.mjs';

const str=value=>String(value??'').trim();
const norm=value=>str(value).toLowerCase();
const validId=value=>/^[1-9]\d*$/.test(str(value));
const validEntityId=value=>/^(0|[1-9]\d*)$/.test(str(value));
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm(value));
const validName=value=>typeof value==='string'&&value.trim().length>0;

function blocked(id,reason,extra={}){
return {tmrUserId:id,action:'BLOQUEADO',reason,changesApplied:0,...extra};
}

function getTMRId(user){
return str(user?.idUsuario??user?.id);
}

function getPersonaId(user){
return str(user?.idPersona);
}

function getLogin(user){
return norm(
user?.login||
user?.usuario||
user?.nombreUsuario||
user?.username||
user?.userName||
user?.email
);
}

function getEmail(user){
return norm(
user?.email||
user?.correo||
user?.correoElectronico||
user?.correo_electronico||
user?.emailUsuario||
user?.emailAddress||
user?.mail
);
}

function getGLPILogin(user){
return norm(user?.username??user?.name??user?.login);
}

function getGLPIEmails(user){
const emails=new Set();
const visited=new WeakSet();
function collect(value){
if(value==null)return;
if(typeof value==='string'){
if(validEmail(value))emails.add(norm(value));
return;
}
if(typeof value!=='object'||visited.has(value))return;
visited.add(value);
if(Array.isArray(value)){
for(const item of value)collect(item);
return;
}
for(const key of ['email','mail','address','value','emails','useremails','emailAddress','email_address']){
if(Object.hasOwn(value,key))collect(value[key]);
}
}
for(const key of ['email','mail','emails','useremails','emailAddress','email_address']){
collect(user?.[key]);
}
return emails;
}

function unwrap(value){
const data=value?.data??value;
return Array.isArray(data)?(data.length===1?data[0]:null):data;
}

function getCreatedId(response){
const data=unwrap(response);
const id=data?.id??data?.user?.id;
return validId(id)?str(id):null;
}

function getProfileName(operation){
return str(
operation?.resolvedProfileName??
operation?.proposedProfileName??
operation?.profileName
);
}

function getEntityName(operation,options){
return str(
operation?.resolvedEntityName??
operation?.proposedEntityName??
operation?.entityName??
options.entityName
);
}

function indexBy(items,getKey){
const result=new Map();
for(const item of items){
const key=getKey(item);
if(!result.has(key))result.set(key,[]);
result.get(key).push(item);
}
return result;
}

function getMappingForTMR(mapping,tmrUserId){
if(typeof mapping.getAll!=='function'){
throw new Error('MAPPING_GET_ALL_NO_DISPONIBLE');
}
const rows=mapping.getAll();
if(!Array.isArray(rows)){
throw new Error('MAPPING_INVALIDO');
}
return rows.filter(row=>
str(row?.tmrUserId??row?.idUsuario)===tmrUserId
);
}

async function validateCandidate({
candidate,
user,
operation,
glpi,
options
}){
const tmrUserId=getTMRId(user);
const personaId=getPersonaId(user);
const login=getLogin(user);
const email=getEmail(user);

if(!validId(tmrUserId)||tmrUserId!==str(candidate.tmrUserId)){
return blocked(tmrUserId,'IDENTIDAD_TMR_INVALIDA');
}
if(!validId(personaId)){
return blocked(tmrUserId,'PERSONA_TMR_INVALIDA');
}
if(!login||!validEmail(email)){
return blocked(tmrUserId,'LOGIN_O_EMAIL_TMR_INVALIDO');
}
if(candidate.personaId&&str(candidate.personaId)!==personaId){
return blocked(tmrUserId,'PERSONA_PREVALIDACION_NO_COINCIDE');
}
if(candidate.login&&norm(candidate.login)!==login){
return blocked(tmrUserId,'LOGIN_PREVALIDACION_NO_COINCIDE');
}
if(candidate.email&&norm(candidate.email)!==email){
return blocked(tmrUserId,'EMAIL_PREVALIDACION_NO_COINCIDE');
}
if(operation.personaId!=null&&str(operation.personaId)!==personaId){
return blocked(tmrUserId,'PERSONA_PLAN_NO_COINCIDE');
}
if(operation.glpiUserId!=null){
return blocked(tmrUserId,'USUARIO_GLPI_YA_ASIGNADO');
}
if(operation.profileVerified!==true){
return blocked(tmrUserId,'PERFIL_PLAN_NO_VERIFICADO');
}

const profileName=getProfileName(operation);
const entityName=getEntityName(operation,options);

if(!profileName)return blocked(tmrUserId,'PERFIL_NO_DEFINIDO');
if(!entityName)return blocked(tmrUserId,'ENTIDAD_NO_DEFINIDA');

const profile=await glpi.resolveProfileByName(profileName);
const entity=await glpi.resolveEntityByName(entityName);

if(!validId(profile?.id)||norm(profile?.name)!==norm(profileName)){
return blocked(tmrUserId,'PERFIL_GLPI_NO_VERIFICADO');
}
if(!validEntityId(entity?.id)||norm(entity?.name)!==norm(entityName)){
return blocked(tmrUserId,'ENTIDAD_GLPI_NO_VERIFICADA');
}
if(operation.proposedProfileId!=null&&str(operation.proposedProfileId)!==str(profile.id)){
return blocked(tmrUserId,'ID_PERFIL_NO_COINCIDE');
}
if(operation.proposedEntityId!=null&&str(operation.proposedEntityId)!==str(entity.id)){
return blocked(tmrUserId,'ID_ENTIDAD_NO_COINCIDE');
}

const identity=await glpi.findIdentityConflicts(login,email);
if(!identity||!Array.isArray(identity.conflicts)){
return blocked(tmrUserId,'RESPUESTA_IDENTIDAD_GLPI_INVALIDA');
}
if(identity.conflicts.length){
return blocked(tmrUserId,'USUARIO_YA_EXISTE_GLPI',{
conflicts:identity.conflicts
});
}

return {
tmrUserId,
personaId,
login,
email,
user,
operation,
profileId:Number(profile.id),
profileName:profile.name,
entityId:Number(entity.id),
entityName:entity.name,
inventoryComplete:identity.inventoryComplete===true,
safeToCreate:identity.safeToCreate===true,
detailErrors:identity.detailErrors,
checkedUsers:identity.checkedUsers,
action:'PREVALIDADO',
changesApplied:0
};
}

async function buildPayload(validated,createPayload){
if(typeof createPayload!=='function'){
throw new Error('CREATE_PAYLOAD_NO_CONFIGURADO');
}
const payload=await createPayload({
user:validated.user,
tmrUserId:validated.tmrUserId,
personaId:validated.personaId,
login:validated.login,
email:validated.email,
profileId:validated.profileId,
profileName:validated.profileName,
entityId:validated.entityId,
entityName:validated.entityName,
operation:validated.operation
});
if(!payload||typeof payload!=='object'||Array.isArray(payload)){
throw new Error('PAYLOAD_GLPI_INVALIDO');
}
if(getGLPILogin(payload)!==validated.login||
norm(payload.email)!==validated.email){
throw new Error('IDENTIDAD_PAYLOAD_NO_COINCIDE');
}
if(str(payload.profileId)!==str(validated.profileId)||
str(payload.entityId)!==str(validated.entityId)){
throw new Error('IDS_PAYLOAD_NO_COINCIDEN');
}
if(norm(payload.profileName)!==norm(validated.profileName)||
norm(payload.entityName)!==norm(validated.entityName)){
throw new Error('PERFIL_ENTIDAD_PAYLOAD_NO_COINCIDEN');
}
return payload;
}

async function verifyCreatedUser(glpi,created,validated){
const glpiUserId=getCreatedId(created);
if(!glpiUserId){
throw new Error('CREACION_SIN_ID_CONFIRMADO_REQUIERE_REVISION_MANUAL');
}
const response=await glpi.getUserById(glpiUserId);
const user=unwrap(response);
if(!user||str(user.id)!==glpiUserId){
throw new Error('USUARIO_CREADO_NO_VERIFICABLE');
}
if(getGLPILogin(user)!==validated.login){
throw new Error('LOGIN_CREADO_NO_COINCIDE');
}
if(!getGLPIEmails(user).has(validated.email)){
throw new Error('EMAIL_CREADO_NO_COINCIDE');
}
return glpiUserId;
}

function summarize(results){
const count=action=>results.filter(row=>row.action===action).length;
return {
prevalidados:count('PREVALIDADO'),
pendientesEscritura:count('PENDIENTE_ESCRITURA'),
creados:count('CREADO_Y_VINCULADO'),
bloqueados:count('BLOQUEADO'),
errores:count('ERROR_REQUIERE_REVISION')
};
}

export async function executePilotCreation({
users,
plan,
glpi,
mapping,
createPayload,
options={}
}={}){
if(!Array.isArray(users)||!Array.isArray(plan)||!glpi||!mapping){
throw new Error('DATOS_REALES_SINCRONIZACION_INVALIDOS');
}
if(typeof mapping.load==='function')await mapping.load();
if(Number(options.maxWrites??1)!==1){
throw new Error('SOLO_UNA_ESCRITURA_POR_EJECUCION');
}

const realRequested=
options.enabled===true&&
options.writesEnabled===true&&
options.dryRun===false&&
options.confirmed===true;

const selectedId=str(options.allowedTmrUserId);
if(realRequested&&!validId(selectedId)){
throw new Error('PILOTO_REQUIERE_ID_TMR_EXPLICITO');
}
if(realRequested&&options.contractVerified!==true){
throw new Error('CONTRATO_API_GLPI_NO_VERIFICADO');
}
if(realRequested&&typeof glpi.createUser!=='function'){
throw new Error('GLPI_CREATE_USER_NO_DISPONIBLE');
}

const prevalidation=await preparePilot({users,plan,glpi,mapping});
if(!prevalidation||!Array.isArray(prevalidation.results)){
throw new Error('PREVALIDACION_INVALIDA');
}

const usersIndex=indexBy(users,getTMRId);
const operationsIndex=indexBy(
plan.filter(operation=>operation?.action==='CREAR_CANDIDATO'),
operation=>str(operation.tmrUserId)
);
const candidates=realRequested
?prevalidation.results.filter(candidate=>str(candidate.tmrUserId)===selectedId)
:prevalidation.results;

if(realRequested&&candidates.length!==1){
throw new Error('USUARIO_PILOTO_NO_ENCONTRADO_O_DUPLICADO');
}

const results=[];
let writeAttempts=0;
let changesApplied=0;

console.log('TMR_GLPI_PILOTO_INICIADO '+JSON.stringify({
totalUsuariosTMR:users.length,
totalOperaciones:plan.length,
totalCandidatos:prevalidation.totalCandidatos,
seleccionado:realRequested?selectedId:null,
dryRun:!realRequested,
maxWrites:1
}));

for(const candidate of candidates){
const tmrUserId=str(candidate?.tmrUserId);

if(candidate.status==='BLOQUEADO'){
results.push(blocked(tmrUserId,candidate.reason??'PREVALIDACION_BLOQUEADA'));
continue;
}

const matchingUsers=usersIndex.get(tmrUserId)??[];
const matchingOperations=operationsIndex.get(tmrUserId)??[];

if(matchingUsers.length!==1||matchingOperations.length!==1){
results.push(blocked(tmrUserId,'USUARIO_O_PLAN_NO_UNICO'));
continue;
}

try{
if(getMappingForTMR(mapping,tmrUserId).length){
results.push(blocked(tmrUserId,'VINCULACION_TMR_EXISTENTE'));
continue;
}

const validated=await validateCandidate({
candidate,
user:matchingUsers[0],
operation:matchingOperations[0],
glpi,
options
});

if(validated.action==='BLOQUEADO'){
results.push(validated);
continue;
}

if(!realRequested){
results.push({
tmrUserId,
personaId:validated.personaId,
action:'PREVALIDADO',
reason:validated.safeToCreate
?'VALIDACIONES_LECTURA_COMPLETADAS'
:'COBERTURA_GLPI_PENDIENTE',
profileId:validated.profileId,
profileName:validated.profileName,
entityId:validated.entityId,
entityName:validated.entityName,
inventoryComplete:validated.inventoryComplete,
safeToCreate:validated.safeToCreate,
readyToWrite:false,
changesApplied:0
});
continue;
}

if(validated.inventoryComplete!==true||
validated.safeToCreate!==true||
validated.detailErrors!==0){
results.push(blocked(tmrUserId,'COBERTURA_GLPI_NO_VERIFICADA'));
continue;
}

if(glpi.integrationIdentity?.effectiveSessionVerified!==true){
results.push(blocked(tmrUserId,'SESION_GLPI_NO_VERIFICADA'));
continue;
}
if(glpi.integrationPermissions?.canCreateUsers!==true){
results.push(blocked(tmrUserId,'PERMISO_GLPI_CREACION_NO_VERIFICADO'));
continue;
}
if(glpi.entityCoverage?.entityScopeVerified!==true){
results.push(blocked(tmrUserId,'COBERTURA_ENTIDADES_NO_VERIFICADA'));
continue;
}
if(typeof glpi.getWriteBlockers!=='function'||
glpi.getWriteBlockers().readyToWrite!==true){
results.push(blocked(tmrUserId,'GLPI_NO_AUTORIZA_ESCRITURA'));
continue;
}
if(writeAttempts>=1){
results.push(blocked(tmrUserId,'LIMITE_ESCRITURA_ALCANZADO'));
continue;
}

const payload=await buildPayload(validated,createPayload);
const writeOptions={
tmrUserId,
allowedTmrUserId:selectedId,
profileName:validated.profileName,
entityName:validated.entityName,
confirmed:true,
dryRun:false,
maxWrites:1,
contractVerified:options.contractVerified===true
};

const approval=await glpi.validateCreation(payload,writeOptions);
if(approval?.approved!==true){
results.push(blocked(tmrUserId,'CREACION_GLPI_NO_APROBADA',{
reasons:approval?.reasons??[]
}));
continue;
}
if(str(approval.profile?.id)!==str(validated.profileId)||
str(approval.entity?.id)!==str(validated.entityId)){
results.push(blocked(tmrUserId,'VALIDACION_GLPI_INCONSISTENTE'));
continue;
}

writeAttempts++;
console.log('GLPI_CREACION_INICIADA '+JSON.stringify({
tmrUserId,
profileId:validated.profileId,
entityId:validated.entityId
}));

const created=await glpi.createUser(payload,writeOptions);
const glpiUserId=await verifyCreatedUser(glpi,created,validated);

if(typeof mapping.register!=='function'){
throw new Error('MAPPING_REGISTER_NO_DISPONIBLE');
}

const mappingResult=await mapping.register({
tmrUserId,
personaId:validated.personaId,
glpiUserId,
login:validated.login,
email:validated.email,
verified:true
});

changesApplied++;
results.push({
tmrUserId,
personaId:validated.personaId,
glpiUserId,
action:'CREADO_Y_VINCULADO',
changesApplied:1,
mapping:mappingResult
});

console.log('GLPI_USUARIO_CREADO_Y_VERIFICADO '+JSON.stringify({
tmrUserId,
glpiUserId
}));
}catch(error){
results.push({
tmrUserId,
action:'ERROR_REQUIERE_REVISION',
reason:error?.message??'ERROR_DESCONOCIDO',
changesApplied:0
});
console.error('TMR_GLPI_ERROR '+JSON.stringify({
tmrUserId,
message:error?.message??'ERROR_DESCONOCIDO',
writeAttempted:writeAttempts>0
}));
if(realRequested&&writeAttempts>0)break;
}
}

const counts=summarize(results);
const summary={
status:'FINALIZADO',
totalUsuariosTMR:users.length,
totalOperaciones:plan.length,
totalCandidatos:prevalidation.totalCandidatos,
totalProcesados:results.length,
candidatos:counts.prevalidados+counts.pendientesEscritura,
prevalidados:counts.prevalidados,
pendientesEscritura:counts.pendientesEscritura,
creados:counts.creados,
bloqueados:counts.bloqueados,
errores:counts.errores,
writeAttempts,
changesApplied,
dryRun:!realRequested,
writesEnabled:realRequested,
contractVerified:options.contractVerified===true,
results
};

console.log('TMR_GLPI_EJECUCION_FINALIZADA '+JSON.stringify({
totalProcesados:summary.totalProcesados,
creados:summary.creados,
bloqueados:summary.bloqueados,
errores:summary.errores,
writeAttempts,
changesApplied
}));

return summary;
}
