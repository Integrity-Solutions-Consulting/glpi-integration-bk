
import {pathToFileURL} from 'node:url';
import {loadConfig} from './config/env.mjs';
import {TMRClient} from './clients/tmr.client.mjs';
import {InventoryClient} from './clients/inventory.client.mjs';
import {GLPIClient} from './clients/glpi.client.mjs';
import {propose} from './services/proposal.service.mjs';
import {todayEcuador} from './utils/dates.mjs';
import {sameId} from './utils/normalize.mjs';
import {getSupportContext} from './services/support.service.mjs';
import {buildSyncPlan,summarizeSyncPlan} from './services/sync-plan.service.mjs';
import {MappingService} from './services/mapping.service.mjs';
import {SyncService} from './services/sync.service.mjs';
import {executePilotCreation} from './services/pilot-execution.service.mjs';

export {propose} from './services/proposal.service.mjs';
export {normalizeDate} from './utils/dates.mjs';

const normalize=value=>String(value??'').trim();
const normalizeIdentity=value=>normalize(value).toLowerCase();
const validId=value=>/^[1-9]\d*$/.test(normalize(value));
const validEntityId=value=>/^(0|[1-9]\d*)$/.test(normalize(value));
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeIdentity(value));

function log(label,data){
console.log(label+' '+JSON.stringify(data));
}

function getPilotLogin(user){
for(const value of [
user?.login,
user?.usuario,
user?.nombreUsuario,
user?.username,
user?.userName,
user?.email
]){
if(typeof value==='string'&&value.trim()){
return normalizeIdentity(value);
}
}
return '';
}

function getPilotEmail(user){
for(const value of [
user?.email,
user?.correo,
user?.correoElectronico,
user?.correo_electronico,
user?.emailUsuario,
user?.emailAddress,
user?.mail
]){
if(typeof value==='string'&&value.trim()){
return normalizeIdentity(value);
}
}
return '';
}

function validateSyncConfiguration(config){
const requestedMode=normalize(
process.env.SYNC_MODE??
config?.sync?.requestedMode??
config?.sync?.mode??
'PREVALIDACION'
).toUpperCase();

if(!['PREVALIDACION','REAL'].includes(requestedMode)){
throw new Error('SYNC_MODE_INVALIDO');
}

const allowedTmrUserId=normalize(
process.env.PILOT_TMR_USER_ID??
config?.sync?.allowedTmrUserId
);

const confirmed=
process.env.PILOT_CONFIRM==='YES';

const enabled=
process.env.GLPI_ENABLE_PILOT_WRITE==='true';

const realRequested=requestedMode==='REAL';

if(realRequested){
if(!validId(allowedTmrUserId)){
throw new Error('PILOT_TMR_USER_ID_OBLIGATORIO');
}
if(!confirmed){
throw new Error('PILOT_CONFIRM_DEBE_SER_YES');
}
if(!enabled){
throw new Error('GLPI_ENABLE_PILOT_WRITE_DEBE_SER_TRUE');
}
}

return {
requestedMode,
mode:requestedMode,
scope:'USUARIOS_REALES_TMR',
enabled:realRequested&&enabled,
dryRun:!realRequested,
writesEnabled:realRequested&&enabled&&confirmed,
confirmed,
allowedTmrUserId:realRequested?allowedTmrUserId:null,
maxWrites:1
};
}

function summarizeTMRModule(items){
if(!Array.isArray(items)){
throw new Error('RESPUESTA_TMR_NO_ES_LISTA');
}
return {
status:'OK',
total:items.length,
fields:items.length&&items[0]&&typeof items[0]==='object'
?Object.keys(items[0])
:[]
};
}

async function loadTMRData(tmr){
console.log('CONSULTANDO_ENDPOINTS_TMR');

const operations=[
['usuarios',()=>tmr.getUsers()],
['colaboradores',()=>tmr.getEmployees()],
['lideres',()=>tmr.getLeaders()],
['proyectos',()=>tmr.getProjects()],
['roles',()=>tmr.getRoles()]
];

const data={};
const diagnostics={};

for(const [name,execute] of operations){
try{
const response=await execute();
diagnostics[name]=summarizeTMRModule(response);
data[name]=response;
}catch(error){
diagnostics[name]={
status:'ERROR',
message:error.message
};
data[name]=null;
}
}

log('DIAGNOSTICO_ENDPOINTS_TMR',{
endpointsChecked:operations.length,
endpointsSuccessful:Object.values(diagnostics)
.filter(item=>item.status==='OK').length,
results:diagnostics
});

const required=[
'usuarios',
'colaboradores',
'lideres',
'proyectos'
];

const failures=required.filter(
name=>diagnostics[name]?.status!=='OK'
);

if(failures.length){
throw new Error(
'ENDPOINTS_TMR_OBLIGATORIOS_FALLIDOS: '+
failures.join(',')
);
}

if(diagnostics.roles?.status!=='OK'){
log('ADVERTENCIA_ROLES_TMR',diagnostics.roles);
}

return data;
}

function diagnoseTMREmails(users){
const fields=[
'email',
'correo',
'correoElectronico',
'correo_electronico',
'emailUsuario',
'emailAddress',
'mail'
];

log('DIAGNOSTICO_CORREOS_TMR',{
totalUsuarios:users.length,
campos:fields.map(campo=>({
campo,
conValor:users.filter(user=>
typeof user?.[campo]==='string'&&
user[campo].trim()!==''
).length
}))
});
}

function getEmailFormat(value){
if(value==null){
return {
tipo:value===null?'null':'undefined',
cantidad:0,
primerElemento:null,
campos:[]
};
}

if(Array.isArray(value)){
const first=value[0];
return {
tipo:'array',
cantidad:value.length,
primerElemento:first===null
?'null'
:Array.isArray(first)
?'array'
:typeof first,
campos:first&&typeof first==='object'&&!Array.isArray(first)
?Object.keys(first)
:[]
};
}

return {
tipo:typeof value,
cantidad:value?1:0,
primerElemento:null,
campos:[]
};
}

function hasEmailValue(value){
if(value==null)return false;
if(typeof value==='string')return value.trim().length>0;
if(Array.isArray(value))return value.some(hasEmailValue);
if(typeof value==='object'){
return Object.values(value).some(hasEmailValue);
}
return false;
}

function diagnoseGLPIEmails(existing){
const formats=new Map();

for(const user of existing){
const format=getEmailFormat(user?.emails);
const key=JSON.stringify({
tipo:format.tipo,
primerElemento:format.primerElemento,
campos:format.campos
});

if(!formats.has(key)){
formats.set(key,{
tipo:format.tipo,
primerElemento:format.primerElemento,
campos:format.campos,
usuarios:0,
totalElementos:0
});
}

const item=formats.get(key);
item.usuarios++;
item.totalElementos+=format.cantidad;
}

return {
totalUsuarios:existing.length,
formatos:[...formats.values()]
};
}

function countGLPIUsersWithEmail(existing){
return existing.filter(user=>
hasEmailValue(user?.email)||
hasEmailValue(user?.correo)||
hasEmailValue(user?.mail)||
hasEmailValue(user?.useremails)||
hasEmailValue(user?.emails)
).length;
}

function unwrapGLPI(response){
const data=response?.data??response;
if(Array.isArray(data)){
return data.length===1?data[0]:data;
}
return data;
}

async function diagnoseGLPIUserDetail(glpi,existing){
const first=existing.find(user=>validId(user?.id));

if(!first){
log('DIAGNOSTICO_DETALLE_GLPI',{
consultado:false,
motivo:'SIN_USUARIO_VALIDO'
});
return;
}

try{
const response=await glpi.getUserById(first.id);
const detail=unwrapGLPI(response);
const emails=detail?.emails;
const format=getEmailFormat(emails);

log('DIAGNOSTICO_DETALLE_GLPI',{
consultado:true,
campos:detail&&typeof detail==='object'
?Object.keys(detail)
:[],
formatoEmails:format.tipo,
cantidadEmails:format.cantidad,
camposPrimerEmail:format.campos,
tieneCorreo:hasEmailValue(emails)
});
}catch(error){
log('DIAGNOSTICO_DETALLE_GLPI',{
consultado:false,
motivo:'ERROR_CONSULTA_DETALLE',
message:error.message
});
}
}

async function diagnoseGLPIUserRelations(glpi,existing){
const first=existing.find(user=>validId(user?.id));

if(!first)return;

if(typeof glpi.diagnoseUserRelations!=='function'){
log('DIAGNOSTICO_RELACIONES_GLPI',{
consultado:false,
motivo:'METODO_NO_DISPONIBLE'
});
return;
}

try{
const result=await glpi.diagnoseUserRelations(first.id);
log('DIAGNOSTICO_RELACIONES_GLPI',result);
}catch(error){
log('DIAGNOSTICO_RELACIONES_GLPI',{
consultado:false,
message:error.message
});
}
}

async function diagnoseSupport({
tmr,
users,
employees,
projects,
report,
config,
today
}){
console.log('DIAGNOSTICANDO_PROYECTO_SOPORTE');

let context;

try{
context=getSupportContext(
projects,
config.supportProjectCode,
today
);
}catch(error){
log('DIAGNOSTICO_SOPORTE_ERROR',{
motivo:'CONTEXTO_NO_DISPONIBLE',
message:error.message
});
return;
}

log('CONTEXTO_SOPORTE',{
proyecto:config.supportProjectCode,
proyectoActivo:context.project?.activo??null,
recursosTotales:context.resources?.length??0,
recursosActivos:context.activeResources?.length??0,
colaboradoresSoporte:context.supportIds?.size??0,
lideresConfigurados:context.leaderIds?.length??0
});

const inspected=new Set();

for(const resource of context.resources??[]){
if(resource.idEmpleado==null)continue;

const key=String(resource.idEmpleado);
if(inspected.has(key))continue;
inspected.add(key);

try{
const employeeList=employees.filter(employee=>
sameId(employee.id,resource.idEmpleado)
);

const detail=await tmr.getEmployee(resource.idEmpleado);

const personIds=[
...employeeList.map(employee=>employee.idPersona),
detail?.idPersona
].filter(value=>value!=null);

const associated=users.filter(user=>
user.idPersona!=null&&
personIds.some(personId=>
sameId(personId,user.idPersona)
)
);

const proposals=report.filter(row=>
associated.some(user=>
sameId(user.idUsuario??user.id,row.tmrUserId)
)
);

log('DIAGNOSTICO_SOPORTE',{
empleadoId:resource.idEmpleado,
estadoAsignacion:resource.estadoAsignacion??null,
entrada:resource.entrada??null,
salida:resource.salida??null,
fechaEvaluacion:today,
personasEnListado:employeeList.map(employee=>({
idPersona:employee.idPersona,
activo:employee.activo
})),
personaEnDetalle:detail?.idPersona??null,
activoEnDetalle:detail?.activo??null,
cuentasAsociadas:associated.map(user=>({
id:user.idUsuario??user.id,
personaId:user.idPersona,
activo:user.activo
})),
propuestas:proposals.map(row=>({
id:row.tmrUserId,
propuesta:row.propuesta
}))
});
}catch(error){
log('DIAGNOSTICO_SOPORTE_ERROR',{
empleadoId:resource.idEmpleado,
message:error.message
});
}
}
}

export function createPilotPayload({
user,
login,
email,
profileId,
profileName,
entityId,
entityName
}){
if(
!login||
!validEmail(email)||
normalizeIdentity(login)!==getPilotLogin(user)||
normalizeIdentity(email)!==getPilotEmail(user)
){
throw new Error('IDENTIDAD_TMR_NO_COINCIDE');
}

if(!validId(profileId)){
throw new Error('PERFIL_GLPI_INVALIDO');
}

if(!validEntityId(entityId)){
throw new Error('ENTIDAD_GLPI_INVALIDA');
}

if(!normalize(profileName)||!normalize(entityName)){
throw new Error('PERFIL_O_ENTIDAD_NO_VERIFICADOS');
}

return {
username:normalizeIdentity(login),
email:normalizeIdentity(email),
firstname:typeof user.nombres==='string'?user.nombres.trim():'',
realname:typeof user.apellidos==='string'?user.apellidos.trim():'',
profileName:normalize(profileName),
profileId:Number(profileId),
entityName:normalize(entityName),
entityId:Number(entityId)
};
}

function getPilotPlan(syncPlan){
if(!Array.isArray(syncPlan)){
throw new Error('PLAN_SINCRONIZACION_INVALIDO');
}

return syncPlan.map(operation=>{
if(
!operation||
typeof operation!=='object'||
Array.isArray(operation)
){
throw new Error('OPERACION_SINCRONIZACION_INVALIDA');
}
return {...operation};
});
}

async function resolveRealEntity(glpi,config){
const configuredName=normalize(
process.env.GLPI_ENTITY_NAME??
config?.sync?.entityName??
config?.sync?.glpiEntityName
);

if(configuredName){
try{
const entity=await glpi.resolveEntityByName(configuredName);

if(!entity||!validEntityId(entity.id)){
return {
verified:false,
reason:'ENTIDAD_GLPI_INVALIDA',
entityName:null
};
}

return {
verified:true,
entityId:Number(entity.id),
entityName:normalize(entity.name),
source:'GLPI_API'
};
}catch(error){
return {
verified:false,
reason:'ENTIDAD_GLPI_NO_RESUELTA',
message:error.message,
entityName:null
};
}
}

try{
const entities=await glpi.getEntities();

if(!Array.isArray(entities)){
throw new Error('RESPUESTA_ENTIDADES_INVALIDA');
}

const validEntities=entities.filter(entity=>
entity&&
validEntityId(entity.id)&&
normalize(entity.name)
);

if(validEntities.length!==1){
return {
verified:false,
reason:validEntities.length===0
?'SIN_ENTIDAD_GLPI'
:'MULTIPLES_ENTIDADES_REQUIEREN_CONFIGURACION',
visibleEntities:validEntities.length,
entityName:null
};
}

return {
verified:true,
entityId:Number(validEntities[0].id),
entityName:normalize(validEntities[0].name),
source:'GLPI_API'
};
}catch(error){
return {
verified:false,
reason:'ERROR_CONSULTA_ENTIDADES_GLPI',
message:error.message,
entityName:null
};
}
}

function getGLPIReadiness({
permissions,
coverage,
readiness,
inventory
}){
const reasons=[];

if(permissions?.readPermissionsVerified!==true){
reasons.push('LECTURA_GLPI_NO_VERIFICADA');
}

if(permissions?.canCreateUsers!==true){
reasons.push('PERMISO_CREACION_NO_VERIFICADO');
}

if(coverage?.entityScopeVerified!==true){
reasons.push('COBERTURA_ENTIDADES_NO_VERIFICADA');
}

if(inventory?.inventoryComplete!==true){
reasons.push('INVENTARIO_GLOBAL_NO_VERIFICADO');
}

if(readiness?.inventoryComplete!==true){
reasons.push('INVENTARIO_CREACION_NO_VERIFICADO');
}

if(readiness?.contractVerified!==true){
reasons.push('CONTRATO_GLPI_NO_VERIFICADO');
}

if(readiness?.readyToWrite!==true){
reasons.push('CLIENTE_GLPI_NO_PREPARADO');
}

return {
ready:reasons.length===0,
contractVerified:readiness?.contractVerified===true,
reasons
};
}

function buildPilotOptions({
syncConfig,
entityResolution,
security
}){
const requested=syncConfig.writesEnabled===true;

return {
enabled:requested&&security.ready,
writesEnabled:requested&&security.ready,
dryRun:!(requested&&security.ready),
confirmed:requested&&syncConfig.confirmed===true,
contractVerified:security.contractVerified,
maxWrites:1,
allowedTmrUserId:syncConfig.allowedTmrUserId,
entityName:entityResolution.verified
?entityResolution.entityName
:''
};
}

async function runControlledPilot({
users,
syncPlan,
glpi,
mapping,
config,
syncConfig,
security
}){
const plan=getPilotPlan(syncPlan);
const entityResolution=await resolveRealEntity(glpi,config);

const options=buildPilotOptions({
syncConfig,
entityResolution,
security
});

if(!entityResolution.verified){
options.enabled=false;
options.writesEnabled=false;
options.dryRun=true;
}

log('ENTIDAD_GLPI_PILOTO',entityResolution);

log('INICIANDO_PILOTO_CONTROLADO',{
totalUsuariosTMR:users.length,
totalOperaciones:plan.length,
totalCandidatos:plan.filter(operation=>
operation.action==='CREAR_CANDIDATO'
).length,
selectedTmrUserId:options.allowedTmrUserId,
entityName:options.entityName||null,
dryRun:options.dryRun,
writesEnabled:options.writesEnabled,
contractVerified:options.contractVerified,
maxWrites:options.maxWrites,
securityReasons:security.reasons
});

const result=await executePilotCreation({
users,
plan,
glpi,
mapping,
createPayload:createPilotPayload,
options
});

log('RESULTADO_PILOTO',{
status:result.status,
totalProcesados:result.totalProcesados,
candidatos:result.candidatos,
creados:result.creados,
bloqueados:result.bloqueados,
errores:result.errores,
writeAttempts:result.writeAttempts,
changesApplied:result.changesApplied
});

return {
...result,
entityResolution
};
}

export async function main(){
const config=loadConfig();
const syncConfig=validateSyncConfiguration(config);

console.log('========================================');
console.log('INTEGRACION TMR -> GLPI 11');
console.log('========================================');

log('CONFIGURACION_SINCRONIZACION',syncConfig);

const tmr=new TMRClient(config.tmr);
const glpi=new GLPIClient(config.glpi);
const inventory=new InventoryClient(config.inventory);

console.log('AUTENTICANDO_TMR');
await tmr.authenticate();

console.log('AUTENTICANDO_INVENTORY');
await inventory.authenticate();

console.log('AUTENTICANDO_GLPI');
await glpi.authenticate();

/*
La autenticacion puede reiniciar el estado del cliente.
Por eso la configuracion se aplica despues de autenticar.
*/
glpi.enableSynchronization(syncConfig.writesEnabled);

console.log('INICIANDO_DIAGNOSTICOS_SEGURIDAD_GLPI');

const diagnosticoPermisos=
await glpi.diagnoseIntegrationPermissions();

log('RESULTADO_PERMISOS_GLPI',diagnosticoPermisos);

const diagnosticoCobertura=
await glpi.diagnoseEntityCoverage();

log(
'RESULTADO_COBERTURA_ENTIDADES_GLPI',
diagnosticoCobertura
);

const diagnosticoPreparacion=
await glpi.diagnoseCreationReadiness();

log(
'RESULTADO_PREPARACION_CREACION_GLPI',
diagnosticoPreparacion
);

console.log('CONSULTANDO_DATOS_REALES_TMR');

const tmrData=await loadTMRData(tmr);

console.log('CONSULTANDO_EQUIPOS_INVENTORY');
const inventoryEquipment=await inventory.getEquipment();
if(!Array.isArray(inventoryEquipment)){
throw new Error('LISTADO_EQUIPOS_INVENTORY_INVALIDO');
}

const users=tmrData.usuarios;
const employees=tmrData.colaboradores;
const leaders=tmrData.lideres;
const projects=tmrData.proyectos;
const roles=tmrData.roles;

diagnoseTMREmails(users);

console.log('CONSULTANDO_USUARIOS_GLPI');

const detailedInventory=await glpi.getDetailedInventory(true);
const existing=detailedInventory.users;

if(!Array.isArray(existing)){
throw new Error('LISTADO_USUARIOS_GLPI_INVALIDO');
}

console.log('VALIDANDO_INVENTARIO_GLPI');

const diagnosticoGLPI=await glpi.diagnoseInventory();

log('RESULTADO_VALIDACION_GLPI',diagnosticoGLPI);

log('DIAGNOSTICO_GLPI',{
totalUsuarios:existing.length,
camposUsuario:existing.length
?Object.keys(existing[0])
:[],
usuariosConCorreo:countGLPIUsersWithEmail(existing)
});

log(
'DIAGNOSTICO_EMAILS_GLPI',
diagnoseGLPIEmails(existing)
);

await diagnoseGLPIUserDetail(glpi,existing);
await diagnoseGLPIUserRelations(glpi,existing);

const today=todayEcuador();

log('FECHA_EVALUACION',{fecha:today});

log('DATOS_CONSULTADOS',{
usuariosTMR:users.length,
colaboradores:employees.length,
lideres:leaders.length,
proyectos:projects.length,
rolesTMR:roles?.length??null,
usuariosGLPI:existing.length,
equiposInventory:inventoryEquipment.length
});

console.log('GENERANDO_PROPUESTAS');

const report=propose(
users,
employees,
leaders,
projects,
existing,
config.supportProjectCode,
today
);

if(!Array.isArray(report)){
throw new Error('PROPUESTAS_INVALIDAS');
}

const totals={};

for(const row of report){
totals[row.propuesta]=(totals[row.propuesta]??0)+1;
}

log('RESUMEN_PROPUESTAS',totals);

console.log('CONSULTANDO_PERFILES_GLPI');

const availableProfiles=await glpi.getProfiles();

if(!Array.isArray(availableProfiles)){
throw new Error('PERFILES_GLPI_INVALIDOS');
}

log(
'PERFILES_GLPI_DISPONIBLES',
availableProfiles.map(profile=>({
id:profile.id,
name:profile.name
}))
);

console.log('GENERANDO_PLAN_SINCRONIZACION');

const syncPlan=buildSyncPlan(report,existing,{
availableProfiles,
inventoryComplete:diagnosticoGLPI.inventoryComplete===true
});

if(!Array.isArray(syncPlan)){
throw new Error('PLAN_SINCRONIZACION_INVALIDO');
}

const syncSummary=summarizeSyncPlan(syncPlan);

log('PLAN_SINCRONIZACION',syncSummary);

for(const operation of syncPlan){
log('OPERACION_PROPUESTA',operation);
}

console.log('INICIALIZANDO_VINCULACIONES');

const mapping=new MappingService(config.sync.mappingPath);

await mapping.load();

const existingMappings=mapping.getAll();

if(!Array.isArray(existingMappings)){
throw new Error('VINCULACIONES_INVALIDAS');
}

log('VINCULACIONES_EXISTENTES',{
total:existingMappings.length
});

const security=getGLPIReadiness({
permissions:diagnosticoPermisos,
coverage:diagnosticoCobertura,
readiness:diagnosticoPreparacion,
inventory:diagnosticoGLPI
});

log('ESTADO_SEGURIDAD_GLPI',{
...security,
requestedMode:syncConfig.mode,
requestedWrites:syncConfig.writesEnabled,
effectiveWrites:syncConfig.writesEnabled&&security.ready
});

log('MODO_DATOS_REALES',{
usuariosTMR:users.length,
usuariosGLPI:existing.length,
operacionesPlanificadas:syncPlan.length,
inventarioGLPICompleto:
diagnosticoGLPI.inventoryComplete===true,
mockData:false
});

/*
SyncService se conserva para la prevalidacion general.
No se habilitan escrituras masivas desde este servicio.
La unica ruta de creacion es executePilotCreation.
*/
console.log('INICIALIZANDO_SERVICIO_SINCRONIZACION');

const syncService=new SyncService({
tmr,
glpi,
mapping,
config:{
...config.sync,
mode:'PREVALIDACION',
writesEnabled:false,
availableProfiles,
inventoryComplete:
diagnosticoGLPI.inventoryComplete===true
}
});

const syncResult=await syncService.execute(
syncPlan,
users,
existing
);

log('RESULTADO_PREVALIDACION',syncResult.summary);

console.log('MODO_SINCRONIZACION '+syncResult.mode);
console.log('ESCRITURAS_HABILITADAS '+syncResult.writesEnabled);
console.log('CAMBIOS_APLICADOS '+syncResult.changesApplied);

for(const result of syncResult.results??[]){
log('RESULTADO_USUARIO',result);
}

if((syncResult.changesApplied??0)!==0){
throw new Error('PREVALIDACION_APLICO_CAMBIOS_INESPERADOS');
}

console.log('INICIANDO_PILOTO');

const pilotResult=await runControlledPilot({
users,
syncPlan,
glpi,
mapping,
config,
syncConfig,
security
});

await diagnoseSupport({
tmr,
users,
employees,
projects,
report,
config,
today
});

const changesApplied=
(syncResult.changesApplied??0)+
(pilotResult.changesApplied??0);

const finalSummary={
usuariosTMR:users.length,
rolesTMR:roles?.length??null,
usuariosGLPI:existing.length,
equiposInventory:inventoryEquipment.length,
propuestas:report.length,
operacionesPlanificadas:syncPlan.length,
vinculaciones:mapping.getAll().length,
diagnosticosGLPI:{
permisosLecturaVerificados:
diagnosticoPermisos.readPermissionsVerified===true,
permisosCreacionVerificados:
diagnosticoPermisos.canCreateUsers===true,
coberturaGlobalVerificada:
diagnosticoCobertura.entityScopeVerified===true,
inventarioCompleto:
diagnosticoGLPI.inventoryComplete===true,
contratoCreacionVerificado:
diagnosticoPreparacion.contractVerified===true,
readyToWrite:security.ready,
motivosPendientes:security.reasons
},
prevalidacion:syncResult.summary,
piloto:{
status:pilotResult.status,
totalProcesados:pilotResult.totalProcesados,
candidatos:pilotResult.candidatos,
prevalidados:pilotResult.prevalidados,
creados:pilotResult.creados,
bloqueados:pilotResult.bloqueados,
errores:pilotResult.errores,
writeAttempts:pilotResult.writeAttempts,
changesApplied:pilotResult.changesApplied,
entidad:pilotResult.entityResolution
},
inventarioGLPICompleto:
diagnosticoGLPI.inventoryComplete===true,
modoSolicitado:syncConfig.mode,
usuarioPiloto:syncConfig.allowedTmrUserId,
cambiosAplicados:changesApplied
};

log('RESUMEN_FINAL',finalSummary);

console.log('========================================');
console.log('INTEGRACION TMR -> GLPI FINALIZADA');
console.log('CAMBIOS_REALIZADOS '+changesApplied);

log('BLOQUEOS_ESCRITURA_GLPI',{
...glpi.getWriteBlockers(),
appMode:syncConfig.mode,
appWritesEnabled:syncConfig.writesEnabled,
pilotWritesEnabled:pilotResult.writesEnabled,
pilotDryRun:pilotResult.dryRun,
changesApplied
});

console.log('========================================');

return {
report,
syncPlan,
syncResult,
pilotResult,
finalSummary,
inventoryEquipment,
tmrDiagnostics:{
rolesAvailable:Array.isArray(roles),
rolesCount:roles?.length??null
}
};
}

if(
process.argv[1]&&
import.meta.url===pathToFileURL(process.argv[1]).href
){
main().catch(error=>{
console.error(
'ERROR_INTEGRACION '+
(error?.message??'Error desconocido')
);
console.error(
'ERROR_STACK '+
(error?.stack??'Sin stack disponible')
);
process.exitCode=1;
});
}
