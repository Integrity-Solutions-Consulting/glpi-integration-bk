import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditTransfer} from '../src/services/transfer-audit.service.mjs';
import {MappingService} from '../src/services/mapping.service.mjs';
import {preparePilotSync} from '../src/services/pilot-sync.service.mjs';
import {getGLPIEmails,identityOverlaps} from '../src/utils/identity.mjs';
import {createPilotPayload} from '../src/app.mjs';

const user={idUsuario:101,idPersona:201,login:'persona',email:'persona@example.test',activo:true};
const target={id:50,username:'persona',emails:[{email:'persona@example.test'}]};
const link={tmrUserId:101,personaId:201,glpiUserId:50,login:user.login,email:user.email,verified:true};
const audit=(users=[user],existing=[],mappings=[])=>auditTransfer({users,existing,mappings});

test('payload transfiere nombres y apellidos TMR conservando identidad y destino',()=>{
const payload=createPilotPayload({user:{...user,nombres:' Ana María ',apellidos:' Pérez '},
login:user.login,email:user.email,profileId:1,profileName:'Self-Service',entityId:0,entityName:'Root entity'});
assert.equal(payload.firstname,'Ana María');
assert.equal(payload.realname,'Pérez');
assert.equal(payload.username,user.login);
assert.equal(payload.email,user.email);
assert.equal(payload.entityId,0);
});

test('cuenta existente sin vinculo nunca se recrea ni se adopta automaticamente',()=>{
const row=audit([user],[target]).rows[0];
assert.equal(row.action,'REVISAR_MANUALMENTE');
assert.ok(row.reasons.includes('CUENTA_GLPI_EXISTENTE_SIN_VINCULO'));
});

test('vinculo persistido sobrevive reinicio y segunda corrida no propone creacion',async()=>{
const directory=await mkdtemp(join(tmpdir(),'tmr-mapping-test-'));
try{
const path=join(directory,'mappings.json');
const first=new MappingService(path);
await first.load();
await first.register(link);
const second=new MappingService(path);
await second.load();
await second.register(link);
assert.equal(second.getAll().length,1);
assert.equal(audit([user],[target],second.getAll()).rows[0].action,'YA_VINCULADO');
await assert.rejects(second.register({...link,tmrUserId:102}),/vinculado a otro TMR/);
}finally{
await rm(directory,{recursive:true,force:true});
}
});

test('vinculo con cuenta ausente o identidad cambiada nunca vuelve a crear',()=>{
assert.equal(audit([user],[],[link]).rows[0].action,'REVISAR_MANUALMENTE');
assert.ok(audit([{...user,email:'nuevo@example.test'}],[target],[link]).rows[0]
.reasons.includes('IDENTIDAD_VINCULADA_MODIFICADA'));
});

test('detecta duplicados por ID, persona y cruce login-correo entre usuarios TMR',()=>{
for(const other of [user,{...user,idUsuario:102},
{...user,idUsuario:102,idPersona:202,login:user.email,email:'otra@example.test'}]){
const result=audit([user,other]);
assert.ok(result.rows.every(row=>row.action==='REVISAR_MANUALMENTE'));
}
});

test('cruce de login TMR con correo GLPI anidado bloquea duplicado',()=>{
const existing={id:50,username:'otro',useremails:[{emailAddress:{value:'PERSONA@EXAMPLE.TEST'}}]};
const source={...user,login:'persona@example.test',email:'nuevo@example.test'};
assert.ok(identityOverlaps(source.login,source.email,existing));
assert.equal(audit([source],[existing]).rows[0].action,'REVISAR_MANUALMENTE');
assert.deepEqual([...getGLPIEmails(existing)],['persona@example.test']);
});

test('coincidencias multiples y vinculos a un mismo destino requieren revision',()=>{
assert.ok(audit([user],[target,{...target,id:51}]).rows[0].reasons.includes('IDENTIDAD_GLPI_DUPLICADA'));
assert.ok(audit([user],[target],[link,{...link,tmrUserId:102,personaId:202}]).rows[0]
.reasons.includes('DESTINO_VINCULADO_A_OTRO_USUARIO'));
});

test('ausencia visible no equivale a ausencia global; errores de detalle bloquean certeza',()=>{
assert.equal(audit().rows[0].globalAbsenceVerified,false);
assert.equal(auditTransfer({users:[user],existing:[],inventoryComplete:true,detailErrors:1})
.rows[0].globalAbsenceVerified,false);
});

test('piloto tambien bloquea colisiones cruzadas TMR antes de cualquier escritura',()=>{
const users=[user,{...user,idUsuario:102,idPersona:202,login:user.email,email:'otro@example.test'}];
const plan=users.map(item=>({tmrUserId:item.idUsuario,personaId:item.idPersona,action:'CREAR_CANDIDATO',
profileVerified:true,proposedProfileName:'Self-Service'}));
const result=preparePilotSync({users,plan,existing:[],mappings:[]});
assert.equal(result.bloqueados,2);
assert.equal(result.changesApplied,0);
});
