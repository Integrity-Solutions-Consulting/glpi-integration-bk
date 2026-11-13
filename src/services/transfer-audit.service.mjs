import {getTMRLogin,getTMREmail,getGLPILogin,getGLPIEmails,isValidEmail,identityOverlaps,findTMRDuplicates} from '../utils/identity.mjs';

const id=value=>/^[1-9]\d*$/.test(String(value??'').trim())?String(value).trim():null;
const normalized=value=>String(value??'').trim().toLowerCase();
const protectedLogins=new Set(['glpi','glpi-system','tmr-sync','post-only','tech','normal']);

// Read-only reconciliation. A match without a verified mapping never adopts a local account.
export function auditTransfer({users,existing,mappings=[],inventoryComplete=false,detailErrors=0}){
if(!Array.isArray(users)||!Array.isArray(existing)||!Array.isArray(mappings)){
throw new Error('DATOS_CONCILIACION_INVALIDOS');
}
const duplicates=findTMRDuplicates(users);
const rows=users.map((user,index)=>{
const tmrUserId=id(user?.idUsuario??user?.id);
const personaId=id(user?.idPersona);
const login=getTMRLogin(user);
const email=getTMREmail(user);
const reasons=[...duplicates[index]];
const matches=existing.filter(target=>identityOverlaps(login,email,target));
const links=mappings.filter(item=>id(item.tmrUserId)===tmrUserId&&tmrUserId!==null);
let action='CREAR_CANDIDATO';
let glpiUserId=null;
if(!tmrUserId||!personaId||!login||!isValidEmail(email))reasons.push('IDENTIDAD_TMR_INCOMPLETA');
if(user?.activo!==true)reasons.push('USUARIO_TMR_NO_ACTIVO');
if(protectedLogins.has(login))reasons.push('CUENTA_PROTEGIDA');
if(mappings.some(item=>id(item.personaId)===personaId&&personaId!==null&&id(item.tmrUserId)!==tmrUserId)){
reasons.push('PERSONA_VINCULADA_A_OTRO_USUARIO');
}
if(links.length>1)reasons.push('VINCULACION_DUPLICADA');
if(links.length===1){
const link=links[0];
glpiUserId=id(link.glpiUserId);
const targets=existing.filter(item=>id(item.id)===glpiUserId&&glpiUserId!==null);
if(link.verified!==true||id(link.personaId)!==personaId||!glpiUserId){
reasons.push('VINCULACION_NO_VERIFICADA');
}
if(mappings.some(item=>item!==link&&id(item.glpiUserId)===glpiUserId))reasons.push('DESTINO_VINCULADO_A_OTRO_USUARIO');
if(targets.length!==1){
reasons.push('CUENTA_VINCULADA_NO_LOCALIZADA');
}else if(getGLPILogin(targets[0])!==login||normalized(link.login)!==login||
normalized(link.email)!==email||!getGLPIEmails(targets[0]).has(email)){
reasons.push('IDENTIDAD_VINCULADA_MODIFICADA');
}
if(Number(glpiUserId)<=7||targets.some(item=>protectedLogins.has(getGLPILogin(item))))reasons.push('CUENTA_PROTEGIDA');
if(matches.some(item=>id(item.id)!==glpiUserId))reasons.push('IDENTIDAD_GLPI_DUPLICADA');
action='YA_VINCULADO';
}else if(matches.length){
reasons.push(matches.length===1?'CUENTA_GLPI_EXISTENTE_SIN_VINCULO':'IDENTIDAD_GLPI_DUPLICADA');
}
if(reasons.length)action='REVISAR_MANUALMENTE';
return {tmrUserId,personaId,glpiUserId,action,reasons,
matchingGLPIIds:matches.map(item=>id(item.id)),
globalAbsenceVerified:action==='CREAR_CANDIDATO'&&inventoryComplete===true&&detailErrors===0,
writesEnabled:false};
});
return {
direction:'TMR_TO_GLPI',usersTMR:users.length,usersGLPI:existing.length,
inventoryComplete:inventoryComplete===true,detailErrors,
summary:rows.reduce((counts,row)=>{counts[row.action]=(counts[row.action]??0)+1;return counts;},{}),
writesEnabled:false,changesApplied:0,rows
};
}
