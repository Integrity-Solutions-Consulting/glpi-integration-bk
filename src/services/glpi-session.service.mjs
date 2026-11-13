// GLPI 11: CoreController Session schema (API >= 2.2).
// CREATE = 4: https://glpi-developer-documentation.readthedocs.io/en/latest/devapi/acl.html
const id=value=>Number.isSafeInteger(value)&&value>=0;

export function inspectSession(session,configuredLogin){
if(!session||typeof session!=='object'||Array.isArray(session)){
throw new Error('GLPI_SESION_RESPUESTA_INVALIDA');
}
const rights=session.active_profile?.rights?.user;
const validRights=Number.isSafeInteger(rights)&&rights>=0&&rights<=0x7fffffff;
const activeEntityIds=Array.isArray(session.active_entities)&&session.active_entities.every(id)
?session.active_entities:null;
const userId=id(session.user_id)&&session.user_id>0?session.user_id:null;
const profileId=id(session.active_profile?.id)&&session.active_profile.id>0?session.active_profile.id:null;
const entityId=id(session.active_entity?.id)?session.active_entity.id:null;
const loginMatches=typeof session.name==='string'&&
session.name.trim().toLowerCase()===String(configuredLogin??'').trim().toLowerCase();
return {
fields:Object.keys(session),
userId,
loginMatches,
activeProfileId:profileId,
activeEntityId:entityId,
recursive:[0,1,true,false].includes(session.active_entity?.recursive)
?Boolean(session.active_entity.recursive):null,
activeEntityIds,
userRights:validRights?rights:null,
createRight:validRights?(rights&4)===4:null,
sessionStructureVerified:userId!==null&&profileId!==null&&entityId!==null&&
activeEntityIds!==null&&activeEntityIds.includes(entityId)&&loginMatches
};
}

export function inspectEntityTree(tree){
if(!Array.isArray(tree))throw new Error('GLPI_ARBOL_ENTIDADES_INVALIDO');
const ids=new Set();
const pending=[...tree];
let count=0;
while(pending.length){
const node=pending.pop();
if(++count>100000||!node||!id(node.key)||!Array.isArray(node.children)){
throw new Error('GLPI_ARBOL_ENTIDADES_INVALIDO');
}
ids.add(node.key);
pending.push(...node.children);
}
return {entityIds:[...ids].sort((a,b)=>a-b),nodesRead:count};
}
