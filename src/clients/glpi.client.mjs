import {identityOverlaps} from '../utils/identity.mjs';

import {request} from './http.client.mjs';
import {inspectSession,inspectEntityTree} from '../services/glpi-session.service.mjs';

const API='/api.php/v2.3';
const USER_PATH=`${API}/Administration/User`;
const ENTITY_PATH=`${API}/Administration/Entity`;
const PROFILE_PATH=`${API}/Administration/Profile`;
const PROTECTED_IDS=new Set(['1','2','3','4','5','6','7']);
const PROTECTED_LOGINS=new Set(['glpi','glpi-system','tmr-sync','post-only','tech','normal']);
const normalize=value=>String(value??'').trim().toLowerCase();
const normalizeName=value=>normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
const validId=value=>/^[1-9]\d*$/.test(String(value??'').trim());
const validEntityId=value=>/^(0|[1-9]\d*)$/.test(String(value??'').trim());
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(value));
const relationId=value=>value&&typeof value==='object'?value.id??null:value;
const unwrap=value=>value?.data??value;

function getRows(response){
const data=unwrap(response);
if(Array.isArray(data))return data;
for(const value of [data?.items,data?.results,data?.rows,data?.data]){
if(Array.isArray(value))return value;
}
throw new Error('GLPI_LISTA_RESPUESTA_INVALIDA');
}

function getTotal(response){
if(response?.contentRange){
const match=/^(?:\d+-(?:\d+|-1)|\*)\/(\d+)$/.exec(response.contentRange);
if(!match||!Number.isSafeInteger(Number(match[1])))throw new Error('GLPI_CONTENT_RANGE_INVALIDO');
return Number(match[1]);
}
const data=unwrap(response);
for(const value of [
data?.total,
data?.totalCount,
data?.totalcount,
data?.pagination?.total,
data?.meta?.pagination?.total,
response?.total,
response?.pagination?.total
]){
if(value==null)continue;
const total=Number(value);
if(Number.isSafeInteger(total)&&total>=0)return total;
}
return null;
}

function getLogin(user){
return normalize(user?.username??user?.name??user?.login);
}

function getEmails(user){
const result=new Set();
const visited=new WeakSet();
function collect(value){
if(value==null)return;
if(typeof value==='string'){
const email=normalize(value);
if(validEmail(email))result.add(email);
return;
}
if(typeof value!=='object'||visited.has(value))return;
visited.add(value);
if(Array.isArray(value)){
for(const item of value)collect(item);
return;
}
for(const key of [
'email','correo','mail','address','value',
'email_address','emailAddress','emails','useremails'
]){
if(Object.hasOwn(value,key))collect(value[key]);
}
}
for(const key of [
'email','correo','mail','emails','useremails',
'email_address','emailAddress'
]){
collect(user?.[key]);
}
return result;
}

function publicError(error){
return {
name:error?.name??'Error',
message:error?.message??'Error desconocido'
};
}

export class GLPIClient{
constructor(config){
if(!config?.url)throw new Error('CONFIGURACION_GLPI_INVALIDA');
this.config=config;
this.token=null;
this.syncEnabled=false;
this.lastInventory=null;
this.profileCache=null;
this.entityCache=null;
this.detailedInventoryCache=null;
this.entityCoverage=null;
this.integrationPermissions=null;
this.integrationIdentity=null;
this.sessionContext=null;
this.resourcePages=new Map();
this.pilotWrites=0;
}

ensureAuthenticated(){
if(!this.token)throw new Error('GLPI_NO_AUTENTICADO');
}

invalidateInventory(){
this.lastInventory=null;
this.detailedInventoryCache=null;
this.entityCoverage=null;
this.integrationPermissions=null;
this.integrationIdentity=null;
this.sessionContext=null;
this.resourcePages.clear();
}

async authenticate(){
this.token=null;
this.syncEnabled=false;
this.invalidateInventory();
const response=await request(
this.config.url,
'/api.php/token',
null,
{
grant_type:'password',
client_id:this.config.clientId,
client_secret:this.config.clientSecret,
username:this.config.user,
password:this.config.password,
scope:'api'
},
true
);
const data=unwrap(response);
if(typeof data?.access_token!=='string'||!data.access_token.trim()){
throw new Error('GLPI_ACCESS_TOKEN_NO_RECIBIDO');
}
this.token=data.access_token;
this.syncEnabled=false;
this.pilotWrites=0;
this.invalidateInventory();
this.profileCache=null;
this.entityCache=null;
console.log('GLPI_AUTENTICACION_OK');
return true;
}

enableSynchronization(enabled=false){
this.syncEnabled=enabled===true&&process.env.GLPI_ENABLE_PILOT_WRITE==='true';
console.log('GLPI_ESCRITURAS '+JSON.stringify({
requested:enabled===true,
enabled:this.syncEnabled,
maxWrites:1
}));
return this.syncEnabled;
}

getWriteBlockers(){
const blockers=[];
if(!this.syncEnabled)blockers.push('SINCRONIZACION_DESHABILITADA');
if(this.pilotWrites>=1)blockers.push('LIMITE_PILOTO_ALCANZADO');
if(this.lastInventory?.inventoryComplete!==true)blockers.push('INVENTARIO_GLOBAL_NO_VERIFICADO');
if(this.entityCoverage?.entityScopeVerified!==true)blockers.push('COBERTURA_ENTIDADES_NO_VERIFICADA');
if(this.integrationIdentity?.effectiveSessionVerified!==true)blockers.push('SESION_EFECTIVA_NO_VERIFICADA');
if(this.integrationPermissions?.canCreateUsers!==true)blockers.push('PERMISO_CREACION_NO_VERIFICADO');
if(this.integrationPermissions?.contractVerified!==true)blockers.push('CONTRATO_NO_VERIFICADO');
return {
readyToWrite:blockers.length===0,
writesEnabled:this.syncEnabled,
blockers
};
}

async getSession(){
this.ensureAuthenticated();
return request(this.config.url,`${API}/session`,this.token);
}

async getSessionEntityTree(){
this.ensureAuthenticated();
return request(this.config.url,`${API}/Session/EntityTree`,this.token);
}

async diagnoseSessionContext(){
this.ensureAuthenticated();
this.integrationIdentity=null;
this.integrationPermissions=null;
this.entityCoverage=null;
const result={checkedAt:new Date().toISOString(),session:null,entityTree:null,errors:[]};
for(const [resource,read,inspect] of [
['session',()=>this.getSession(),value=>inspectSession(value,this.config.user)],
['entityTree',()=>this.getSessionEntityTree(),inspectEntityTree]
]){
try{
result[resource]=inspect(unwrap(await read()));
}catch(error){
// Do not log response bodies: session endpoints may contain personal data.
result.errors.push({resource,status:error.status??null,message:`GLPI_CONTEXTO_${resource}_NO_VERIFICADO`});
}
}
this.sessionContext=result;
console.log('GLPI_CONTEXTO_SESION '+JSON.stringify(result));
return result;
}

async getPaginatedResource(path){
this.ensureAuthenticated();
if(![USER_PATH,ENTITY_PATH,PROFILE_PATH].includes(path)){
throw new Error('RECURSO_GLPI_NO_AUTORIZADO');
}
const items=[];
const seen=new Set();
const limit=100;
let declaredTotal=null;
let finished=false;
let pagesRead=0;
for(let page=0;page<1000;page++){
const response=await request(
this.config.url,
`${path}?limit=${limit}&start=${page*limit}&sort=id`,
this.token,null,false,{responseMetadata:true}
);
const rows=getRows(response);
const total=getTotal(response);
pagesRead++;
if(rows.length>limit)throw new Error('GLPI_LIMITE_PAGINA_EXCEDIDO');
if(total!==null){
if(declaredTotal!==null&&declaredTotal!==total){
throw new Error('GLPI_TOTAL_INCONSISTENTE');
}
declaredTotal=total;
}
for(const row of rows){
const id=String(row?.id??'').trim();
if(!(path===ENTITY_PATH?validEntityId(id):validId(id))){
throw new Error('GLPI_ID_INVALIDO');
}
if(seen.has(id))throw new Error('GLPI_ID_DUPLICADO');
seen.add(id);
items.push(row);
}
if(declaredTotal!==null&&items.length>declaredTotal){
throw new Error('GLPI_TOTAL_EXCEDIDO');
}
if(declaredTotal!==null&&items.length===declaredTotal){
finished=true;
break;
}
if(rows.length<limit){
if(declaredTotal!==null&&items.length!==declaredTotal){
throw new Error('GLPI_PAGINACION_INCOMPLETA');
}
finished=true;
break;
}
}
if(!finished)throw new Error('GLPI_LIMITE_PAGINACION');
const metadata={
items,
declaredTotal,
declaredTotalKnown:declaredTotal!==null,
paginationFinished:finished,
visibleCount:items.length,
pagesRead,
scopeVerified:false
};
this.resourcePages.set(path,metadata);
return metadata;
}

async getUsers(){
const page=await this.getPaginatedResource(USER_PATH);
this.lastInventory={
checkedAt:new Date().toISOString(),
visibleUsers:page.items.length,
declaredTotal:page.declaredTotal,
declaredTotalKnown:page.declaredTotalKnown,
paginationFinished:page.paginationFinished,
pagesRead:page.pagesRead,
inventoryComplete:false,
reason:'ALCANCE_GLOBAL_DE_ENTIDADES_NO_VERIFICADO'
};
this.detailedInventoryCache=null;
console.log('GLPI_INVENTARIO '+JSON.stringify(this.lastInventory));
return page.items;
}

async getEntities(){
const page=await this.getPaginatedResource(ENTITY_PATH);
this.entityCache=page.items;
return page.items;
}

async getProfiles(){
const page=await this.getPaginatedResource(PROFILE_PATH);
this.profileCache=page.items;
return page.items;
}

async resolveProfileByName(name){
const profiles=this.profileCache??await this.getProfiles();
const matches=profiles.filter(item=>normalizeName(item.name)===normalizeName(name));
if(matches.length!==1||!validId(matches[0].id)){
throw new Error(`PERFIL_GLPI_NO_RESUELTO: ${name}`);
}
return {id:Number(matches[0].id),name:matches[0].name};
}

async resolveEntityByName(name){
const entities=this.entityCache??await this.getEntities();
const matches=entities.filter(item=>{
return normalizeName(item.completename??item.name)===normalizeName(name);
});
if(matches.length!==1||!validEntityId(matches[0].id)){
throw new Error(`ENTIDAD_GLPI_NO_RESUELTA: ${name}`);
}
return {
id:Number(matches[0].id),
name:matches[0].name,
completename:matches[0].completename??matches[0].name
};
}

async resolveTMRProfile(role,profileNames={}){
const match=Object.entries(profileNames).find(([key])=>{
return normalizeName(key)===normalizeName(role);
});
if(!match)throw new Error(`ROL_TMR_SIN_EQUIVALENCIA: ${role}`);
return this.resolveProfileByName(match[1]);
}

async getUserById(id){
this.ensureAuthenticated();
if(!validId(id))throw new Error('ID_USUARIO_INVALIDO');
return request(this.config.url,`${USER_PATH}/${id}`,this.token);
}

async getUserDetails(id){
const user=unwrap(await this.getUserById(id));
if(!user||typeof user!=='object'||Array.isArray(user)){
throw new Error('DETALLE_USUARIO_INVALIDO');
}
if(String(user.id)!==String(id)){
throw new Error('DETALLE_USUARIO_ID_INCONSISTENTE');
}
return user;
}

async getDetailedInventory(forceRefresh=false){
this.ensureAuthenticated();
if(!forceRefresh&&this.detailedInventoryCache){
return this.detailedInventoryCache;
}
const summaries=await this.getUsers();
const users=[];
const errors=[];
let detailsWithEmail=0;
for(const summary of summaries){
try{
const detail=await this.getUserDetails(summary.id);
const combined={...summary,...detail};
users.push(combined);
if(getEmails(combined).size>0)detailsWithEmail++;
}catch(error){
errors.push({id:String(summary.id),message:error.message});
users.push(summary);
}
}
const inventory={
checkedAt:new Date().toISOString(),
users,
checkedUsers:summaries.length,
detailsChecked:summaries.length-errors.length,
detailsWithEmail,
detailErrors:errors.length,
errors,
declaredTotal:this.lastInventory?.declaredTotal??null,
declaredTotalKnown:this.lastInventory?.declaredTotalKnown===true,
paginationFinished:this.lastInventory?.paginationFinished===true,
inventoryComplete:false,
reason:errors.length
?'DETALLES_INCOMPLETOS'
:'COBERTURA_GLOBAL_NO_VERIFICADA'
};
this.detailedInventoryCache=inventory;
return inventory;
}

async findIdentityConflicts(login,email){
const normalizedLogin=normalize(login);
const normalizedEmail=normalize(email);
if(!normalizedLogin||!validEmail(normalizedEmail)){
throw new Error('IDENTIDAD_TMR_INVALIDA');
}
const inventory=await this.getDetailedInventory();
const conflicts=[];
for(const user of inventory.users){
const existingLogin=getLogin(user);
const loginCoincide=existingLogin===normalizedLogin||
existingLogin===normalizedEmail;
const correoCoincide=getEmails(user).has(normalizedEmail);
if(identityOverlaps(normalizedLogin,normalizedEmail,user)){
conflicts.push({
id:user.id,
login:existingLogin,
loginCoincide,
correoCoincide
});
}
}
return {
checked:true,
checkedUsers:inventory.checkedUsers,
detailsChecked:inventory.detailsChecked,
detailsWithEmail:inventory.detailsWithEmail,
detailErrors:inventory.detailErrors,
paginationFinished:inventory.paginationFinished,
inventoryComplete:inventory.inventoryComplete,
conflicts,
safeToCreate:inventory.inventoryComplete&&inventory.detailErrors===0&&conflicts.length===0,
reason:conflicts.length?'IDENTIDAD_EXISTENTE_EN_GLPI':inventory.reason
};
}

async diagnoseUser(id){
const user=await this.getUserDetails(id);
return {
consultado:true,
tieneId:validId(user.id),
tieneUsername:Boolean(getLogin(user)),
campos:Object.keys(user),
correosDetectados:getEmails(user).size,
tienePerfilPredeterminado:relationId(user.default_profile)!=null,
tieneEntidadPredeterminada:relationId(user.default_entity)!=null
};
}

async diagnoseUserRelations(id){
const user=await this.getUserDetails(id);
const relations={};
for(const [key,value] of Object.entries(user)){
if(Array.isArray(value)){
relations[key]={
tipo:'array',
cantidad:value.length,
camposPrimerElemento:value[0]&&typeof value[0]==='object'
?Object.keys(value[0]):[]
};
}else if(value!==null&&typeof value==='object'){
relations[key]={tipo:'object',campos:Object.keys(value)};
}
}
return {consultado:true,camposRelacionados:relations};
}

async diagnoseInventory(){
const inventory=await this.getDetailedInventory();
const logins=new Map();
const emails=new Map();
let protectedUsers=0;
for(const user of inventory.users){
const id=String(user.id);
const login=getLogin(user);
if(PROTECTED_IDS.has(id)||PROTECTED_LOGINS.has(login)){
protectedUsers++;
}
if(login){
if(!logins.has(login))logins.set(login,[]);
logins.get(login).push(id);
}
for(const email of getEmails(user)){
if(!emails.has(email))emails.set(email,[]);
emails.get(email).push(id);
}
}
const duplicateLogins=[...logins]
.filter(([,ids])=>ids.length>1)
.map(([login,ids])=>({login,ids}));
const duplicateEmails=[...emails]
.filter(([,ids])=>ids.length>1)
.map(([email,ids])=>({email,ids}));
const result={
status:inventory.detailErrors===0?'LECTURA_OK':'LECTURA_PARCIAL',
checkedUsers:inventory.checkedUsers,
detailsChecked:inventory.detailsChecked,
detailsWithEmail:inventory.detailsWithEmail,
detailErrors:inventory.detailErrors,
paginationFinished:inventory.paginationFinished,
declaredTotal:inventory.declaredTotal,
protectedUsers,
uniqueLogins:logins.size,
uniqueEmails:emails.size,
duplicateLogins,
duplicateEmails,
inventoryComplete:inventory.inventoryComplete,
safeToCreate:false,
writesEnabled:this.syncEnabled,
reason:inventory.reason
};
console.log('DIAGNOSTICO_INVENTARIO_GLPI '+JSON.stringify(result));
return result;
}

async diagnoseEntityCoverage(){
this.ensureAuthenticated();
this.entityCoverage=null;
const context=this.sessionContext??await this.diagnoseSessionContext();
const page=await this.getPaginatedResource(ENTITY_PATH);
this.entityCache=page.items;
const ids=page.items.map(item=>String(item.id));
const result={
checkedAt:new Date().toISOString(),
status:'COBERTURA_PENDIENTE',
visibleEntities:page.items.length,
entityIds:ids,
rootEntityVisible:ids.includes('0'),
entityPaginationFinished:page.paginationFinished,
entityDeclaredTotal:page.declaredTotal,
userPaginationFinished:this.lastInventory?.paginationFinished===true,
userDeclaredTotal:this.lastInventory?.declaredTotal??null,
visibleUsers:this.lastInventory?.visibleUsers??null,
entityScopeVerified:false,
inventoryComplete:false,
canCreateUsers:null,
writesEnabled:this.syncEnabled,
reason:'ALCANCE_RECURSIVO_NO_VERIFICADO',
evidence:{
activeEntityIds:context.session?.activeEntityIds??null,
activeEntityId:context.session?.activeEntityId??null,
recursive:context.session?.recursive??null,
treeEntityIds:context.entityTree?.entityIds??null,
errors:context.errors
}
};
this.entityCoverage=result;
console.log('DIAGNOSTICO_COBERTURA_ENTIDADES_GLPI '+JSON.stringify(result));
return result;
}

async diagnoseIntegrationIdentity(){
this.ensureAuthenticated();
this.integrationIdentity=null;
const context=this.sessionContext??await this.diagnoseSessionContext();
const users=await this.getUsers();
const login=normalize(this.config.user);
const matches=users.filter(user=>getLogin(user)===login);
const result={
checkedAt:new Date().toISOString(),
configuredLogin:login,
userFound:matches.length===1,
userId:matches.length===1?Number(matches[0].id):null,
loginMatches:matches.length===1,
expectedProfileName:'Integración TMR',
expectedProfileId:9,
expectedEntityId:0,
profileExists:false,
entityExists:false,
defaultProfileId:null,
defaultEntityId:null,
defaultProfileMatches:null,
defaultEntityMatches:null,
profileAndEntityDefaultsChecked:false,
effectiveSessionVerified:false,
canCreateUsers:null,
reason:'SESION_EFECTIVA_NO_VERIFICADA',
errors:[]
};
try{
if(matches.length===1){
const detail=await this.getUserDetails(matches[0].id);
result.defaultProfileId=relationId(detail.default_profile);
result.defaultEntityId=relationId(detail.default_entity);
result.defaultProfileMatches=result.defaultProfileId==null
?null:String(result.defaultProfileId)==='9';
result.defaultEntityMatches=result.defaultEntityId==null
?null:String(result.defaultEntityId)==='0';
result.profileAndEntityDefaultsChecked=
result.defaultProfileId!=null&&result.defaultEntityId!=null;
}
const profiles=await this.getProfiles();
const entities=await this.getEntities();
result.profileExists=profiles.some(item=>
String(item.id)==='9'&&normalizeName(item.name)==='integracion tmr'
);
result.entityExists=entities.some(item=>String(item.id)==='0');
}catch(error){
result.errors.push(publicError(error));
result.reason='ERROR_DIAGNOSTICO_IDENTIDAD';
}
const session=context.session;
result.sessionUserId=session?.userId??null;
result.activeProfileId=session?.activeProfileId??null;
result.activeEntityId=session?.activeEntityId??null;
result.effectiveSessionVerified=result.errors.length===0&&result.userFound&&
result.profileExists&&result.entityExists&&session?.sessionStructureVerified===true&&
session.userId===result.userId&&session.activeProfileId===result.expectedProfileId&&
session.activeEntityId===result.expectedEntityId;
if(result.effectiveSessionVerified)result.reason='SESION_EFECTIVA_VERIFICADA';
this.integrationIdentity=result;
console.log('DIAGNOSTICO_IDENTIDAD_INTEGRACION '+JSON.stringify(result));
return result;
}

async diagnoseIntegrationPermissions(){
this.ensureAuthenticated();
const context=await this.diagnoseSessionContext();
const result={
checkedAt:new Date().toISOString(),
users:null,
entities:null,
profiles:null,
profileNames:[],
errors:[],
readPermissionsVerified:false,
entityCoverage:null,
integrationIdentity:null,
inventoryComplete:false,
canCreateUsers:null,
createPermissionEvidence:'PENDIENTE_PERMISOS_EFECTIVOS',
contractVerified:false,
writesEnabled:this.syncEnabled
};
for(const [key,method,path] of [
['users',()=>this.getUsers(),USER_PATH],
['entities',()=>this.getEntities(),ENTITY_PATH],
['profiles',()=>this.getProfiles(),PROFILE_PATH]
]){
try{
const items=await method();
const page=this.resourcePages.get(path);
result[key]={
status:'OK',
total:items.length,
visible:items.length,
declaredTotal:page?.declaredTotal??null,
paginationFinished:page?.paginationFinished===true,
scopeVerified:false
};
if(key==='profiles')result.profileNames=items.map(item=>item.name);
}catch(error){
result[key]={status:'ERROR'};
result.errors.push({resource:key,message:error.message});
}
}
result.readPermissionsVerified=result.errors.length===0;
if(result.readPermissionsVerified){
result.entityCoverage=await this.diagnoseEntityCoverage();
result.integrationIdentity=await this.diagnoseIntegrationIdentity();
}
if(result.integrationIdentity?.effectiveSessionVerified===true){
result.canCreateUsers=context.session?.createRight??null;
result.createPermissionEvidence=result.canCreateUsers===null
?'DERECHO_USER_NO_EXPUESTO':'SESSION_ACTIVE_PROFILE_RIGHTS_USER';
}
result.reason=result.errors.length
?'RECURSOS_GLPI_NO_VERIFICADOS'
:result.canCreateUsers===true?'PERMISO_CREATE_VERIFICADO_CONTRATO_Y_COBERTURA_PENDIENTES'
:result.canCreateUsers===false?'PERMISO_CREATE_DENEGADO':'PERMISOS_ESCRITURA_NO_VERIFICADOS';
this.integrationPermissions=result;
console.log('DIAGNOSTICO_PERMISOS_GLPI '+JSON.stringify(result));
return result;
}

async diagnoseCreationReadiness(){
this.ensureAuthenticated();
const permissions=await this.diagnoseIntegrationPermissions();
const inventory=await this.getDetailedInventory();
const reasons=['CONTRATO_GLPI_NO_VERIFICADO'];
if(permissions.entityCoverage?.entityScopeVerified!==true)reasons.push('COBERTURA_ENTIDADES_NO_VERIFICADA');
if(!permissions.readPermissionsVerified){
reasons.push('LECTURA_GLPI_INCOMPLETA');
}
if(!inventory.inventoryComplete){
reasons.push('INVENTARIO_GLOBAL_NO_VERIFICADO');
}
if(inventory.detailErrors){
reasons.push('DETALLES_USUARIOS_INCOMPLETOS');
}
if(!permissions.integrationIdentity?.effectiveSessionVerified){
reasons.push('SESION_EFECTIVA_NO_VERIFICADA');
}
if(permissions.canCreateUsers!==true){
reasons.push('PERMISO_CREACION_NO_VERIFICADO');
}
if(!this.syncEnabled){
reasons.push('SINCRONIZACION_DESHABILITADA');
}
const result={
status:'PENDIENTE',
checkedAt:new Date().toISOString(),
visibleUsers:inventory.checkedUsers,
detailsChecked:inventory.detailsChecked,
detailsWithEmail:inventory.detailsWithEmail,
inventoryComplete:inventory.inventoryComplete,
canCreateUsers:permissions.canCreateUsers,
contractVerified:false,
readyToWrite:false,
writesEnabled:this.syncEnabled,
reasons
};
console.log('DIAGNOSTICO_CREACION_GLPI '+JSON.stringify(result));
return result;
}

async validateCreation(payload,options={}){
this.ensureAuthenticated();
if(!payload||typeof payload!=='object'||Array.isArray(payload)){
throw new Error('PAYLOAD_GLPI_INVALIDO');
}
const login=normalize(payload.username??payload.name);
const email=normalize(payload.email);
if(!login||PROTECTED_LOGINS.has(login)){
throw new Error('LOGIN_GLPI_INVALIDO_O_PROTEGIDO');
}
if(!validEmail(email)){
throw new Error('EMAIL_GLPI_INVALIDO');
}
const profileName=options.profileName??payload.profileName;
const entityName=options.entityName??payload.entityName;
if(!profileName||!entityName){
throw new Error('PERFIL_Y_ENTIDAD_OBLIGATORIOS');
}
const profile=await this.resolveProfileByName(profileName);
const entity=await this.resolveEntityByName(entityName);
const identity=await this.findIdentityConflicts(login,email);
const reasons=[];
if(payload.profileId!=null&&String(payload.profileId)!==String(profile.id)){
reasons.push('PERFIL_ID_NO_COINCIDE');
}
if(payload.entityId!=null&&String(payload.entityId)!==String(entity.id)){
reasons.push('ENTIDAD_ID_NO_COINCIDE');
}
if(identity.conflicts.length){
reasons.push('IDENTIDAD_EXISTENTE_EN_GLPI');
}
if(!identity.inventoryComplete){
reasons.push('INVENTARIO_GLOBAL_NO_VERIFICADO');
}
if(identity.detailErrors){
reasons.push('DETALLES_GLPI_INCOMPLETOS');
}
if(!this.syncEnabled){
reasons.push('SINCRONIZACION_DESHABILITADA');
}
if(this.pilotWrites>=1){
reasons.push('LIMITE_PILOTO_ALCANZADO');
}
if(options.confirmed!==true){
reasons.push('CONFIRMACION_PENDIENTE');
}
if(options.dryRun!==false){
reasons.push('MODO_SIMULACION');
}
if(options.maxWrites!==1){
reasons.push('LIMITE_ESCRITURAS_INVALIDO');
}
if(!validId(options.allowedTmrUserId)||
String(options.allowedTmrUserId)!==String(options.tmrUserId??'')){
reasons.push('USUARIO_TMR_NO_AUTORIZADO');
}
if(this.integrationPermissions?.canCreateUsers!==true){
reasons.push('PERMISO_CREACION_NO_VERIFICADO');
}
if(this.integrationIdentity?.effectiveSessionVerified!==true){
reasons.push('SESION_EFECTIVA_NO_VERIFICADA');
}
if(this.entityCoverage?.entityScopeVerified!==true){
reasons.push('COBERTURA_ENTIDADES_NO_VERIFICADA');
}
if(options.contractVerified!==true||this.integrationPermissions?.contractVerified!==true){
reasons.push('CONTRATO_NO_VERIFICADO');
}
return {
approved:reasons.length===0,
action:reasons.length?'BLOQUEADO':'CREAR_PILOTO',
reason:reasons[0]??null,
reasons,
login,
email,
profile,
entity,
conflicts:identity.conflicts,
checkedUsers:identity.checkedUsers,
detailErrors:identity.detailErrors,
inventoryComplete:identity.inventoryComplete,
writesEnabled:this.syncEnabled
};
}

async createUser(payload,options={}){
const validation=await this.validateCreation(payload,options);
console.log('GLPI_CREACION_VALIDADA '+JSON.stringify({
approved:validation.approved,
reason:validation.reason,
login:validation.login,
profileId:validation.profile.id,
entityId:validation.entity.id
}));
if(!validation.approved){
throw new Error(`CREACION_GLPI_BLOQUEADA: ${validation.reasons.join(',')}`);
}
const body={
username:validation.login,
realname:String(payload.realname??'').trim(),
firstname:String(payload.firstname??'').trim(),
emails:[{
email:validation.email,
is_default:true,
is_dynamic:false
}],
is_active:true,
is_deleted:false,
default_profile:{id:validation.profile.id},
default_entity:{id:validation.entity.id}
};
const requestOptions={
method:'POST',
allowWrite:this.syncEnabled,
syncEnabled:this.syncEnabled,
confirmed:options.confirmed===true,
inventoryVerified:validation.inventoryComplete===true,
permissionsVerified:this.integrationPermissions?.canCreateUsers===true,
identityVerified:this.integrationIdentity?.effectiveSessionVerified===true,
contractVerified:options.contractVerified===true,
dryRun:options.dryRun,
maxWrites:options.maxWrites,
allowedTmrUserId:options.allowedTmrUserId,
tmrUserId:options.tmrUserId,
glpiHeaders:{
'GLPI-Entity':String(validation.entity.id),
'GLPI-Profile':String(validation.profile.id),
'GLPI-Entity-Recursive':'false'
}
};
this.pilotWrites++;
let response;
try{
response=await request(
this.config.url,
USER_PATH,
this.token,
body,
false,
requestOptions
);
}catch(error){
console.error('GLPI_CREACION_ERROR '+JSON.stringify({
tmrUserId:options.tmrUserId,
message:error.message
}));
throw error;
}
this.invalidateInventory();
console.log('GLPI_CREACION_RESPUESTA '+JSON.stringify({
tmrUserId:options.tmrUserId,
response
}));
return response;
}

async updateUser(id,payload,options={}){
this.ensureAuthenticated();
if(!validId(id)||PROTECTED_IDS.has(String(id))){
throw new Error('USUARIO_GLPI_PROTEGIDO_O_INVALIDO');
}
const existing=await this.getUserDetails(id);
if(PROTECTED_LOGINS.has(getLogin(existing))){
throw new Error('CUENTA_GLPI_PROTEGIDA');
}
if(options.verifiedMapping!==true){
throw new Error('VINCULACION_TMR_GLPI_NO_VERIFICADA');
}
throw new Error('ACTUALIZACION_GLPI_NO_HABILITADA_EN_PILOTO');
}
}
