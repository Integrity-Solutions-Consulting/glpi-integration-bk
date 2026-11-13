
const AUTH_PATHS=new Set(['/api/auth/login','/api.php/token']);
const METHODS=new Set(['GET','POST','PATCH','PUT']);
const GLPI_USER_PATHS=new Set([
'/api.php/v2.3/Administration/User'
]);
const GLPI_CREATION_CONTRACT_VERIFIED=false;
const DEFAULT_TIMEOUT=60000;
const MAX_ERROR_BODY_LENGTH=300;
const normalize=value=>String(value??'').trim();
const validId=value=>/^[1-9]\d*$/.test(normalize(value));
const validEntityId=value=>/^(0|[1-9]\d*)$/.test(normalize(value));
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(value));
let pilotWriteAttempted=false;

function isAuthentication(method,pathname){
return method==='POST'&&AUTH_PATHS.has(pathname);
}

function getWriteTarget(method,pathname){
if(method==='POST'&&GLPI_USER_PATHS.has(pathname)){
return {type:'CREATE'};
}
for(const root of GLPI_USER_PATHS){
if((method==='PATCH'||method==='PUT')&&pathname.startsWith(root+'/')){
const id=pathname.slice(root.length+1);
if(validId(id))return {type:'UPDATE',id};
}
}
return null;
}

function getMethod(body,options={}){
const method=normalize(options.method??(body==null?'GET':'POST')).toUpperCase();
if(!METHODS.has(method))throw new Error(`Metodo HTTP no permitido: ${method}.`);
return method;
}

function validateURL(base,path){
if(typeof base!=='string'||!base.trim())throw new Error('URL base HTTP invalida.');
if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')){
throw new Error('Ruta HTTP invalida.');
}
if(/[\\\u0000-\u001f\u007f]/.test(path)||/%(?:2e|2f|5c)/i.test(path)){
throw new Error('Ruta HTTP contiene caracteres no permitidos.');
}
const rawPath=path.split('?')[0];
if(rawPath.split('/').some(segment=>segment==='.'||segment==='..')){
throw new Error('Ruta HTTP con segmentos no permitidos.');
}
let baseUrl,url;
try{
baseUrl=new URL(base);
url=new URL(path,baseUrl);
}catch{
throw new Error('URL HTTP invalida.');
}
if(baseUrl.protocol!=='https:'||url.protocol!=='https:'){
throw new Error('HTTPS obligatorio.');
}
if(url.origin!==baseUrl.origin){
throw new Error('Origen HTTP no autorizado.');
}
if(baseUrl.username||baseUrl.password||baseUrl.hash||baseUrl.search||
url.username||url.password||url.hash){
throw new Error('URL HTTP contiene componentes no permitidos.');
}
if(url.pathname!==rawPath){
throw new Error('La ruta HTTP fue normalizada inesperadamente.');
}
return url;
}

function validateBody(method,body){
if(method==='GET'){
if(body!=null)throw new Error('GET no admite cuerpo.');
return;
}
if(body===null||body===undefined||typeof body!=='object'||Array.isArray(body)){
throw new Error('Cuerpo HTTP invalido.');
}
}

function validateAuthentication(method,url,token,form){
if(!isAuthentication(method,url.pathname))return false;
if(token!=null){
throw new Error('La autenticacion no debe enviar un token existente.');
}
if(url.search){
throw new Error('La autenticacion no admite parametros en URL.');
}
if(url.pathname==='/api.php/token'&&form!==true){
throw new Error('La autenticacion GLPI requiere formulario.');
}
if(url.pathname==='/api/auth/login'&&form===true){
throw new Error('La autenticacion TMR requiere JSON.');
}
return true;
}

function validateWrite(method,url,token,options={}){
if(method==='GET')return {type:'READ'};
const target=getWriteTarget(method,url.pathname);
if(!target){
throw new Error(`Escritura HTTP no autorizada: ${method} ${url.pathname}.`);
}
if(target.type!=='CREATE'){
throw new Error('Actualizacion GLPI deshabilitada durante el piloto.');
}
// Keep the transport closed until the deployed creation contract and global scope are verified.
if(!GLPI_CREATION_CONTRACT_VERIFIED){
throw new Error('Escritura GLPI bloqueada: contrato de creacion y cobertura global pendientes.');
}
if(url.search){
throw new Error('Escritura GLPI no admite parametros en URL.');
}
if(typeof token!=='string'||!token.trim()){
throw new Error('Escritura GLPI requiere token OAuth.');
}
const checks=[
['allowWrite','autorizacion explicita ausente'],
['syncEnabled','sincronizacion deshabilitada'],
['confirmed','confirmacion pendiente'],
['inventoryVerified','inventario no verificado'],
['permissionsVerified','permisos no verificados'],
['identityVerified','identidad no verificada'],
['contractVerified','contrato API no verificado']
];
for(const [field,message] of checks){
if(options[field]!==true){
throw new Error(`Escritura GLPI bloqueada: ${message}.`);
}
}
if(options.dryRun!==false){
throw new Error('Escritura GLPI bloqueada: simulacion activa.');
}
if(options.maxWrites!==1){
throw new Error('El piloto permite maxWrites=1.');
}
if(!validId(options.allowedTmrUserId)){
throw new Error('ID TMR autorizado invalido.');
}
if(normalize(options.allowedTmrUserId)!==normalize(options.tmrUserId)){
throw new Error('Usuario fuera del piloto.');
}
if(pilotWriteAttempted){
throw new Error('Ya se intento una escritura GLPI en este proceso.');
}
return target;
}

function buildGLPIHeaders(options={}){
const supplied=options.glpiHeaders??{};
if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)){
throw new Error('Encabezados GLPI invalidos.');
}
const allowed=new Set([
'GLPI-Entity',
'GLPI-Profile',
'GLPI-Entity-Recursive',
'Accept-Language'
]);
for(const key of Object.keys(supplied)){
if(!allowed.has(key)){
throw new Error(`Encabezado GLPI no autorizado: ${key}.`);
}
}
const headers={};
if(supplied['GLPI-Entity']!=null){
if(!validEntityId(supplied['GLPI-Entity'])){
throw new Error('GLPI-Entity invalido.');
}
headers['GLPI-Entity']=normalize(supplied['GLPI-Entity']);
}
if(supplied['GLPI-Profile']!=null){
if(!validId(supplied['GLPI-Profile'])){
throw new Error('GLPI-Profile invalido.');
}
headers['GLPI-Profile']=normalize(supplied['GLPI-Profile']);
}
if(supplied['GLPI-Entity-Recursive']!=null){
const recursive=normalize(supplied['GLPI-Entity-Recursive']).toLowerCase();
if(!['true','false'].includes(recursive)){
throw new Error('GLPI-Entity-Recursive invalido.');
}
headers['GLPI-Entity-Recursive']=recursive;
}
if(supplied['Accept-Language']!=null){
const language=normalize(supplied['Accept-Language']);
if(!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(language)){
throw new Error('Accept-Language invalido.');
}
headers['Accept-Language']=language;
}
return headers;
}

function buildHeaders(token,body,form,options={}){
const headers={Accept:'application/json'};
if(token!=null){
if(typeof token!=='string'||!token.trim()){
throw new Error('Token HTTP invalido.');
}
headers.Authorization=`Bearer ${token.trim()}`;
}
if(body!=null){
headers['Content-Type']=form?
'application/x-www-form-urlencoded':
'application/json';
}
return {...headers,...buildGLPIHeaders(options)};
}

function buildBody(body,form){
if(body==null)return undefined;
if(!body||typeof body!=='object'||Array.isArray(body)){
throw new Error('Cuerpo HTTP invalido.');
}
if(form){
const params=new URLSearchParams();
for(const [key,value] of Object.entries(body)){
if(value==null)continue;
if(typeof value==='object'||typeof value==='function'||typeof value==='symbol'){
throw new Error(`Campo de formulario invalido: ${key}.`);
}
params.append(key,String(value));
}
return params;
}
try{
const serialized=JSON.stringify(body);
if(typeof serialized!=='string')throw new Error('JSON invalido.');
return serialized;
}catch{
throw new Error('No se pudo serializar el cuerpo JSON.');
}
}

function validateCreationBody(body){
if(typeof body.username!=='string'||!body.username.trim()){
throw new Error('GLPI requiere username.');
}
if(!Array.isArray(body.emails)||body.emails.length!==1){
throw new Error('El piloto requiere exactamente un correo GLPI.');
}
const email=body.emails[0]?.email;
if(!validEmail(email)){
throw new Error('Correo GLPI invalido.');
}
if(body.is_active!==true){
throw new Error('El usuario piloto debe estar activo.');
}
if(body.is_deleted!==false){
throw new Error('El usuario piloto no debe estar eliminado.');
}
}

async function parseResponse(response){
if(response.status===204||response.status===205)return null;
const content=await response.text();
if(!content.trim())return null;
try{
return JSON.parse(content);
}catch{
throw new Error(`Respuesta JSON invalida: HTTP ${response.status}.`);
}
}

async function parseError(response,url){
let content='';
try{
content=await response.text();
}catch{}
let message='';
if(content.trim()){
try{
const parsed=JSON.parse(content);
if(typeof parsed?.message==='string')message=parsed.message;
else if(typeof parsed?.error==='string')message=parsed.error;
else if(typeof parsed?.detail==='string')message=parsed.detail;
}catch{}
}
const safeMessage=message.replace(/[\r\n\t]/g,' ').slice(0,MAX_ERROR_BODY_LENGTH);
const error=new Error(
`${url.hostname} ${url.pathname}: HTTP ${response.status}`+
(safeMessage?` - ${safeMessage}`:'')
);
error.status=response.status;
error.path=url.pathname;
return error;
}

function validateTimeout(options={}){
const timeout=Number(options.timeout??DEFAULT_TIMEOUT);
if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>120000){
throw new Error('Timeout HTTP invalido.');
}
return timeout;
}

export async function request(base,path,token=null,body=null,form=false,options={}){
const url=validateURL(base,path);
const method=getMethod(body,options);
validateBody(method,body);
const authentication=validateAuthentication(method,url,token,form);
const authorization=authentication?
{type:'AUTHENTICATION'}:
validateWrite(method,url,token,options);

if(authorization.type==='CREATE'){
validateCreationBody(body);
const glpiHeaders=buildGLPIHeaders(options);
if(!validEntityId(glpiHeaders['GLPI-Entity'])){
throw new Error('Creacion requiere GLPI-Entity.');
}
if(!validId(glpiHeaders['GLPI-Profile'])){
throw new Error('Creacion requiere GLPI-Profile.');
}
if(glpiHeaders['GLPI-Entity-Recursive']!=='false'){
throw new Error('El piloto requiere entidad no recursiva.');
}
}
const timeout=validateTimeout(options);
const headers=buildHeaders(token,body,form,options);
const requestBody=buildBody(body,form);

if(authorization.type==='CREATE'){
pilotWriteAttempted=true;
console.log('GLPI_PILOTO_POST_INICIADO '+JSON.stringify({
path:url.pathname,
tmrUserId:String(options.tmrUserId),
entityId:headers['GLPI-Entity'],
profileId:headers['GLPI-Profile']
}));
}

let response;
try{
response=await fetch(url,{
method,
redirect:'error',
signal:AbortSignal.timeout(timeout),
headers,
body:requestBody
});
}catch(error){
if(error?.name==='TimeoutError'){
throw new Error(`Tiempo de espera agotado: ${method} ${url.pathname}.`);
}
if(error?.name==='AbortError'){
throw new Error(`Solicitud HTTP cancelada: ${method} ${url.pathname}.`);
}
throw new Error(`Error de conexion HTTP: ${method} ${url.pathname}.`);
}
if(!response.ok){
throw await parseError(response,url);
}
const data=await parseResponse(response);
if(options.responseMetadata===true){
return {data,status:response.status,contentRange:response.headers.get('content-range')};
}
return data;
}
