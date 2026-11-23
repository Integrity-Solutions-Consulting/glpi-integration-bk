import {getTMRLogin,getTMREmail,getGLPIEmails,getGLPILogin,isValidEmail} from '../utils/identity.mjs';

const positive=value=>/^[1-9]\d*$/.test(String(value??''));
const numeric=value=>(typeof value==='number'||typeof value==='string')&&/^(0|[1-9]\d*)$/.test(String(value))&&Number.isSafeInteger(Number(value));
const hasRight=(value,bit)=>numeric(value)&&(Number(value)&bit)===bit;
const protectedLogins=new Set(['glpi','glpi-system','tmr-sync','post-only','tech','normal']);

export function verifyLegacyContext(session,login){
const profile=session?.glpiactiveprofile;
const active=session?.glpiactiveentities;
const entities=Array.isArray(active)?active:Object.values(active??{});
const entityIds=entities.map(Number);
const grants=Array.isArray(profile?.entities)?profile.entities:Object.values(profile?.entities??{});
const rootRecursive=grants.some(item=>numeric(item.id)&&Number(item.id)===0&&[1,'1',true].includes(item.is_recursive));
const singleEntity=[0,'0',false].includes(session?.glpi_multientitiesmode);
const identityVerified=positive(session?.glpiID)&&positive(profile?.id)&&
String(session.glpiname??'').trim().toLowerCase()===String(login).trim().toLowerCase();
const globalScope=identityVerified&&entityIds.length>0&&entities.every(numeric)&&
numeric(session.glpiactive_entity)&&Number(session.glpiactive_entity)===0&&entityIds.includes(0)&&
((singleEntity&&entityIds.length===1)||
(rootRecursive&&[1,'1',true].includes(session.glpiactive_entity_recursive)));
return {identityVerified,globalScope,userId:Number(session?.glpiID),profileId:Number(profile?.id),
entityIds,canRead:hasRight(profile?.user,1),canCreate:hasRight(profile?.user,4),
canReadProjects:hasRight(profile?.project,1),canCreateProjects:hasRight(profile?.project,4),
rootRecursive,singleEntity};
}

export function canAssignProfile(current,target){
if(!current||!target||!positive(target.id))return false;
if(hasRight(current.profile,4))return true;
if(current.interface==='central'&&target.interface==='helpdesk')return true;
if(current.interface!==target.interface)return false;
// Profile::post_getFromDB exposes the actual rights on legacy detail responses.
if(!Object.hasOwn(target,'user')||!Object.hasOwn(target,'ticket'))return false;
const nonRights=new Set(['id','is_default','helpdesk_hardware','use_mentions','create_ticket_on_login','tickettemplates_id',
'changetemplates_id','problemtemplates_id','2fa_enforced']);
return Object.entries(target).every(([key,value])=>{
if(nonRights.has(key)||!numeric(value))return true;
if(!Object.hasOwn(current,key))return Number(value)===0;
return numeric(current[key])&&(value|Number(current[key]))===Number(current[key]);
});
}

export function legacyUserInput(user,profileId,entityId,marker){
const login=getTMRLogin(user),email=getTMREmail(user);
if(!login||protectedLogins.has(login)||!isValidEmail(email)||user.activo!==true||
!positive(user.idUsuario??user.id)||!positive(user.idPersona)||!positive(profileId)||
!numeric(entityId)||typeof marker!=='string'||!/^tmr-glpi-sync:[a-f0-9-]{36}$/.test(marker)){
throw new Error('PAYLOAD_TRANSFERENCIA_INVALIDO');
}

return {name:login,firstname:String(user.nombres??'').trim(),realname:String(user.apellidos??'').trim(),
is_active:1,is_deleted:0,authtype:1,entities_id:Number(entityId),profiles_id:Number(profileId),
_entities_id:Number(entityId),_profiles_id:Number(profileId),_is_recursive:0,
_useremails:{'-1':email},_default_email:-1,comment:marker};
}

export function legacyProjectInput(project,entityId,marker){
const id=project?.id;
const code=String(project?.codigo??'').trim();
const name=String(project?.nombre??'').trim();
if(!positive(id)||!code||!name||!numeric(entityId)||
typeof marker!=='string'||!/^tmr-glpi-project:[a-f0-9-]{36}$/.test(marker)){
throw new Error('PAYLOAD_PROYECTO_TRANSFERENCIA_INVALIDO');
}
return {name:`${code} - ${name}`.slice(0,255),content:String(project?.descripcion??project?.observacion??'').trim(),
comment:`${marker} codigo:${code} tmrProjectId:${id}`,
entities_id:Number(entityId),is_recursive:0,is_template:0,
plan_start_date:project?.fechaInicio?String(project.fechaInicio):null,
plan_end_date:project?.fechaFin?String(project.fechaFin):null};
}

export class GLPILegacyClient{
constructor(config){
const url=new URL(config.url);
if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('URL_GLPI_INVALIDA');
this.config=config;this.base=url.origin+'/apirest.php';this.token=null;this.context=null;this.session=null;this.incompletePaths=[];
}

async call(path,{method='GET',body,authenticate=false}={}){
if(!/^\/(initSession|killSession|getFullSession|changeActiveEntities|User(?:\/\d+(?:\/(?:UserEmail|Profile_User))?)?|Profile(?:\/\d+)?|Entity|Project(?:\/\d+)?|(?:Computer|Phone|Peripheral|Monitor)(?:\/\d+)?(?:\/Item_OperatingSystem)?|Manufacturer|ComputerModel|ComputerType|State|Location|OperatingSystem|PhoneModel|PhoneType|PeripheralModel|PeripheralType|MonitorModel|MonitorType)(?:\?|$)/.test(path)||
path.includes('#')||path.includes('\\'))throw new Error('RUTA_LEGACY_NO_AUTORIZADA');
if(method!=='GET'&&!(method==='POST'&&(['/User','/Project','/Computer','/Phone','/Peripheral','/Monitor','/Manufacturer','/ComputerModel','/ComputerType','/State','/Location','/OperatingSystem','/PhoneModel','/PhoneType','/PeripheralModel','/PeripheralType','/MonitorModel','/MonitorType','/changeActiveEntities'].includes(path)||/^\/User\/\d+\/Profile_User$/.test(path)||/^\/Computer\/\d+\/Item_OperatingSystem$/.test(path)))&&!(method==='PUT'&&/^\/(Computer|Phone|Peripheral|Monitor)\/\d+$/.test(path))&&!(method==='DELETE'&&/^\/(Computer|Phone|Peripheral|Monitor)\/\d+$/.test(path)))throw new Error('METODO_LEGACY_NO_AUTORIZADO');
const headers={'Content-Type':'application/json',Accept:'application/json'};
if(this.config.appToken)headers['App-Token']=this.config.appToken;
if(authenticate){
if(path!=='/initSession'||method!=='GET')throw new Error('AUTENTICACION_LEGACY_INVALIDA');
headers.Authorization='Basic '+Buffer.from(this.config.user+':'+this.config.password).toString('base64');
}else{
if(!this.token)throw new Error('GLPI_LEGACY_NO_AUTENTICADO');
headers['Session-Token']=this.token;
}
let response;
try{response=await fetch(this.base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
redirect:'error',signal:AbortSignal.timeout(60000)});}
catch{throw new Error('GLPI_LEGACY_CONEXION_INCIERTA');}
const raw=await response.text();
let data;
try{data=raw?JSON.parse(raw):null;}catch{throw new Error('GLPI_LEGACY_RESPUESTA_NO_JSON');}
if(!response.ok){
const disabled=Array.isArray(data)&&data.some(item=>typeof item==='string'&&/API disabled/i.test(item));
const serverCode=Array.isArray(data)&&/^ERROR_[A-Z_]+$/.test(data[0])?data[0]:null;
const code=disabled?'GLPI_LEGACY_DESHABILITADA':serverCode??`GLPI_LEGACY_HTTP_${response.status}`;
const error=new Error(code);error.status=response.status;throw error;
}
return {data,contentRange:response.headers.get('content-range'),status:response.status};
}

async authenticate(){
this.token=null;this.context=null;
const {data}=await this.call('/initSession',{authenticate:true});
if(typeof data?.session_token!=='string'||!data.session_token)throw new Error('GLPI_LEGACY_TOKEN_AUSENTE');
this.token=data.session_token;
return this.refreshContext();
}

async refreshContext(){
this.context=null;
const {data}=await this.call('/getFullSession');
this.session=data?.session;
this.context=verifyLegacyContext(this.session,this.config.user);
if(!this.context.identityVerified)throw new Error('GLPI_LEGACY_IDENTIDAD_NO_VERIFICADA');
return this.context;
}

async selectGlobalScope(){
await this.refreshContext();
if(!this.context.globalScope&&this.context.rootRecursive){
await this.call('/changeActiveEntities',{method:'POST',body:{entities_id:0,is_recursive:true}});
await this.refreshContext();
}
if(!this.context.globalScope){
// A single root entity is itself a complete scope; do not infer this from a
// profile flag because older GLPI sessions omit glpi_multientitiesmode.
const entities=await this.list('/Entity');
if(entities.length===1&&Number(entities[0]?.id)===0&&this.context.entityIds.length===1&&
Number(this.context.entityIds[0])===0){
this.context.globalScope=true;
this.context.scopeEvidence='CATALOGO_UNA_ENTIDAD_RAIZ';
}
}
if(!this.context.globalScope||!this.context.canRead)throw new Error('GLPI_LEGACY_COBERTURA_GLOBAL_NO_VERIFICADA');
return this.context;
}

async list(path){
const result=[],seen=new Set();let total=null;
for(let start=0;start<100000;start+=100){
const response=await this.call(`${path}${path.includes('?')?'&':'?'}range=${start}-${start+99}&sort=id&order=ASC`);
const rows=response.data;
if(!Array.isArray(rows))throw new Error('GLPI_LEGACY_LISTA_INVALIDA');
const match=/^(?:\d+-(?:\d+|-1)|\*)\/(\d+)$/.exec(response.contentRange??'');
if(!response.contentRange&&((rows.length===0&&(path.includes('is_deleted=true')||path==='/Project'||['/Computer','/Phone','/Peripheral','/Monitor','/Manufacturer','/ComputerModel','/ComputerType','/State','/Location','/OperatingSystem','/PhoneModel','/PhoneType','/PeripheralModel','/PeripheralType','/MonitorModel','/MonitorType'].includes(path)))||path.includes('/User/'))){
for(const row of rows){
if(!numeric(row.id)||seen.has(String(row.id)))throw new Error('GLPI_LEGACY_ID_INVALIDO_O_DUPLICADO');
seen.add(String(row.id));result.push(row);
}
return result;
}
if(!match)throw new Error(`GLPI_LEGACY_TOTAL_NO_DECLARADO:${path}`);
const count=Number(match[1]);
if(!Number.isSafeInteger(count)||(total!==null&&total!==count))throw new Error('GLPI_LEGACY_TOTAL_INCONSISTENTE');
total=count;
for(const row of rows){
if(!numeric(row.id)||seen.has(String(row.id)))throw new Error('GLPI_LEGACY_ID_INVALIDO_O_DUPLICADO');
seen.add(String(row.id));result.push(row);
}
if(result.length===total)return result;
if(rows.length!==100||result.length>total){
if(path.startsWith('/User?is_deleted=')&&result.length<total){
this.incompletePaths.push({path,visible:result.length,declared:total});
return result;
}
throw new Error(`GLPI_LEGACY_PAGINACION_INCOMPLETA:${path}:${rows.length}/${result.length}/${total}`);
}
}
throw new Error('GLPI_LEGACY_LIMITE_PAGINACION');
}

async inventory(){
await this.selectGlobalScope();
this.incompletePaths=[];
const live=await this.list('/User?is_deleted=false');
const deleted=await this.list('/User?is_deleted=true');
const byId=new Map([...live,...deleted].map(user=>[String(user.id),user]));
const users=[];
for(const user of byId.values()){
const emails=await this.list(`/User/${user.id}/UserEmail`);
users.push({...user,username:user.name,emails});
}

if(this.incompletePaths.length)console.log('GLPI_LEGACY_USUARIOS_NO_VISIBLES '+JSON.stringify(this.incompletePaths));
return users;
}

async inventoryProjects(){
await this.selectGlobalScope();
if(!this.context.canReadProjects)throw new Error('GLPI_LEGACY_SIN_PERMISO_PROJECT_READ');
return this.list('/Project');
}

async inventoryComputers(){
await this.selectGlobalScope();
return this.list('/Computer');
}

async inventoryAssets(path){
if(!['/Computer','/Phone','/Peripheral','/Monitor'].includes(path))throw new Error('TIPO_ACTIVO_GLPI_INVALIDO');
await this.selectGlobalScope();
return this.list(path);
}

async inventoryCatalogs(){
await this.selectGlobalScope();
const [manufacturers,models,types,states,locations,operatingSystems]=await Promise.all([
this.list('/Manufacturer'),
this.list('/ComputerModel'),
this.list('/ComputerType'),
this.list('/State'),
this.list('/Location'),
this.list('/OperatingSystem')
]);
return {manufacturers,models,types,states,locations,operatingSystems};
}

async inventoryCatalog(path){
const allowed=['/Manufacturer','/ComputerModel','/ComputerType','/PhoneModel','/PhoneType','/PeripheralModel','/PeripheralType','/MonitorModel','/MonitorType','/State','/Location','/OperatingSystem'];
if(!allowed.includes(path))throw new Error('CATALOGO_GLPI_INVALIDO');
await this.selectGlobalScope();
return this.list(path);
}

async createCatalogValue(path,name){
if(!['/Manufacturer','/ComputerModel','/ComputerType','/PhoneModel','/PhoneType','/PeripheralModel','/PeripheralType','/MonitorModel','/MonitorType','/State','/Location','/OperatingSystem'].includes(path)||!String(name??'').trim())throw new Error('CATALOGO_GLPI_INVALIDO');
await this.selectGlobalScope();
const {data}=await this.call(path,{method:'POST',body:{input:{name:String(name).trim().slice(0,255)}}});
if(!positive(data?.id))throw new Error(`ALTA_CATALOGO_SIN_ID:${path}`);
return Number(data.id);
}

async createComputer(input){
await this.selectGlobalScope();
if(!this.context.canCreate)throw new Error('GLPI_LEGACY_SIN_PERMISO_CREATE');
const {data}=await this.call('/Computer',{method:'POST',body:{input}});
if(!positive(data?.id))throw new Error('ALTA_COMPUTER_SIN_ID_RESULTADO_INCIERTO');
return Number(data.id);
}

async createAsset(path,input){
if(!['/Computer','/Phone','/Peripheral','/Monitor'].includes(path))throw new Error('TIPO_ACTIVO_GLPI_INVALIDO');
await this.selectGlobalScope();
if(!this.context.canCreate)throw new Error('GLPI_LEGACY_SIN_PERMISO_CREATE');
const {data}=await this.call(path,{method:'POST',body:{input}});
if(!positive(data?.id))throw new Error(`ALTA_ACTIVO_SIN_ID:${path}`);
return Number(data.id);
}

async verifyAsset(path,id,input){
if(!positive(id))throw new Error('ID_ACTIVO_INVALIDO');
const {data}=await this.call(`${path}/${id}`);
if(String(data?.id)!==String(id)||String(data?.name??'')!==String(input.name??'')||String(data?.serial??'')!==String(input.serial??'')||String(data?.otherserial??'')!==String(input.otherserial??'')||String(data?.comment??'')!==String(input.comment??''))throw new Error('ALTA_ACTIVO_GLPI_INCOMPLETA_REQUIERE_REVISION');
return data;
}

async updateComputer(id,input){
if(!positive(id))throw new Error('ID_COMPUTER_INVALIDO');
await this.selectGlobalScope();
const {data}=await this.call(`/Computer/${id}`,{method:'PUT',body:{input}});
return data;
}

async updateAsset(path,id,input){
if(!['/Computer','/Phone','/Peripheral','/Monitor'].includes(path)||!positive(id))throw new Error('ACTIVO_GLPI_INVALIDO');
await this.selectGlobalScope();
const {data}=await this.call(`${path}/${id}`,{method:'PUT',body:{input}});
return data;
}

async deleteComputer(id){
if(!positive(id))throw new Error('ID_COMPUTER_INVALIDO');
await this.selectGlobalScope();
const {data}=await this.call(`/Computer/${id}`,{method:'DELETE'});
return data;
}

async setComputerOperatingSystem(computerId,operatingSystemId){
if(!positive(computerId)||!positive(operatingSystemId))throw new Error('SISTEMA_OPERATIVO_GLPI_INVALIDO');
await this.selectGlobalScope();
const path=`/Computer/${computerId}/Item_OperatingSystem`;
const current=await this.call(path);
const existing=Array.isArray(current.data)?current.data:[];
if(existing.some(row=>Number(row?.operatingsystems_id)===Number(operatingSystemId)))return existing.find(row=>Number(row?.operatingsystems_id)===Number(operatingSystemId));
const {data}=await this.call(path,{method:'POST',body:{input:{items_id:Number(computerId),itemtype:'Computer',operatingsystems_id:Number(operatingSystemId)}}});
const rows=Array.isArray(data)?data:[data];
if(!rows.length&&!data)throw new Error('SISTEMA_OPERATIVO_GLPI_SIN_RESULTADO');
return rows[0]??data;
}

async verifyCreatedComputer(id,input){
if(!positive(id))throw new Error('ID_COMPUTER_CREADO_INVALIDO');
const {data}=await this.call(`/Computer/${id}`);
if(String(data?.id)!==String(id)||String(data?.name??'')!==String(input.name??'')||
String(data?.serial??'')!==String(input.serial??'')||String(data?.otherserial??'')!==String(input.otherserial??'')||
String(data?.comment??'')!==String(input.comment??'')){
throw new Error('ALTA_COMPUTER_GLPI_INCOMPLETA_REQUIERE_REVISION');
}
for(const field of ['manufacturers_id','computermodels_id','computertypes_id','states_id','locations_id']){
if(input[field]!==undefined&&Number(data?.[field]??0)!==Number(input[field])){
throw new Error(`ALTA_COMPUTER_GLPI_CAMPO_INCOMPLETO:${field}`);
}
}
return data;
}

async verifyCreatedProject(id,input){
if(!positive(id))throw new Error('ID_PROYECTO_CREADO_INVALIDO');
const {data}=await this.call(`/Project/${id}`);
if(String(data?.id)!==String(id)||String(data?.comment??'')!==input.comment||
String(data?.name??'')!==input.name||Number(data?.entities_id)!==input.entities_id){
throw new Error('ALTA_PROYECTO_GLPI_INCOMPLETA_REQUIERE_REVISION');
}
return data;
}

async createProject(input){
await this.selectGlobalScope();
if(!this.context.canCreateProjects)throw new Error('GLPI_LEGACY_SIN_PERMISO_PROJECT_CREATE');
const {data}=await this.call('/Project',{method:'POST',body:{input}});
if(!positive(data?.id))throw new Error('ALTA_PROYECTO_SIN_ID_RESULTADO_INCIERTO');
return Number(data.id);
}

async verifyCreated(id,input){
if(!positive(id))throw new Error('ID_CREADO_INVALIDO');
const {data:user}=await this.call(`/User/${id}`);
const emails=await this.list(`/User/${id}/UserEmail`);
const profiles=await this.list(`/User/${id}/Profile_User`);
if(String(user?.id)!==String(id)||getGLPILogin(user)!==input.name||
!getGLPIEmails({emails}).has(input._useremails['-1'])||user.comment!==input.comment||
user.firstname!==input.firstname||user.realname!==input.realname||Number(user.is_active)!==1||Number(user.is_deleted)!==0||
!profiles.some(row=>Number(row.profiles_id)===input._profiles_id&&Number(row.entities_id)===input._entities_id)){
throw new Error('ALTA_GLPI_INCOMPLETA_REQUIERE_REVISION');
}

return {...user,username:user.name,emails};
}

async userProfiles(id){
if(!positive(id))throw new Error('ID_USUARIO_INVALIDO');
return this.list(`/User/${id}/Profile_User`);
}

async assignUserProfile(userId,profileId,entityId=0){
if(!positive(userId)||!positive(profileId)||!numeric(entityId))throw new Error('ASIGNACION_PERFIL_INVALIDA');
await this.selectGlobalScope();
if(!this.context.canCreate)throw new Error('GLPI_LEGACY_SIN_PERMISO_CREATE');
const {data}=await this.call(`/Profile/${profileId}`);
if(!canAssignProfile(this.session.glpiactiveprofile,data))throw new Error('GLPI_PERFIL_NO_ASIGNABLE');
const result=await this.call(`/User/${userId}/Profile_User`,{method:'POST',body:{input:{users_id:Number(userId),profiles_id:Number(profileId),entities_id:Number(entityId),is_recursive:0}}});
return result.data;
}

async verifyUserProfile(userId,profileId,entityId=0){
const rows=await this.userProfiles(userId);
return rows.some(row=>Number(row.profiles_id)===Number(profileId)&&Number(row.entities_id)===Number(entityId));
}

async create(input){
await this.selectGlobalScope();
if(!this.context.canCreate)throw new Error('GLPI_LEGACY_SIN_PERMISO_CREATE');
const {data:profile}=await this.call(`/Profile/${input._profiles_id}`);
if(!canAssignProfile(this.session.glpiactiveprofile,profile))throw new Error('GLPI_PERFIL_NO_ASIGNABLE');
const {data}=await this.call('/User',{method:'POST',body:{input}});
if(!positive(data?.id))throw new Error('GLPI_ALTA_SIN_ID_RESULTADO_INCIERTO');
return Number(data.id);
}

async close(){
if(this.token)try{await this.call('/killSession');}finally{this.token=null;this.context=null;}
}
}
