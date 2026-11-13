import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyLegacyContext,canAssignProfile,legacyUserInput} from '../src/clients/glpi-legacy.client.mjs';
import {TransferStore} from '../src/services/transfer-store.service.mjs';

const session={glpiID:7,glpiname:'tmr-sync',glpiactive_entity:0,glpiactiveentities:[0],
glpi_multientitiesmode:0,glpiactive_entity_recursive:0,
glpiactiveprofile:{id:9,user:7,profile:1,interface:'central',entities:[{id:0,is_recursive:0}]}};

test('cobertura legacy exige evidencia de instancia unica o concesion recursiva en raiz',()=>{
assert.equal(verifyLegacyContext(session,'tmr-sync').globalScope,true);
assert.equal(verifyLegacyContext({...session,glpi_multientitiesmode:1},'tmr-sync').globalScope,false);
assert.equal(verifyLegacyContext({...session,glpi_multientitiesmode:undefined},'tmr-sync').globalScope,false);
assert.equal(verifyLegacyContext({...session,glpiactive_entity:null},'tmr-sync').globalScope,false);
assert.equal(verifyLegacyContext(session,'otra-cuenta').globalScope,false);
const recursive={...session,glpi_multientitiesmode:1,glpiactive_entity_recursive:1,
glpiactiveprofile:{...session.glpiactiveprofile,entities:[{id:0,is_recursive:1}]}};
assert.equal(verifyLegacyContext(recursive,'tmr-sync').globalScope,true);
assert.equal(verifyLegacyContext({...recursive,glpiactive_entity_recursive:0},'tmr-sync').globalScope,false);
});

test('asignacion respeta jerarquia de perfiles, sin inventar privilegios',()=>{
const current={id:9,interface:'central',profile:1,user:7,ticket:0};
assert.equal(canAssignProfile(current,{id:1,interface:'helpdesk'}),true);
assert.equal(canAssignProfile(current,{id:6,interface:'central',user:1,ticket:7}),false);
assert.equal(canAssignProfile(current,{id:6,interface:'central'}),false);
assert.equal(canAssignProfile(current,{id:6,interface:'central',user:1,ticket:0,unknownRight:4}),false);
assert.equal(canAssignProfile({...current,profile:5},{id:6,interface:'central'}),true);
});

test('alta legacy incluye correo y asignacion efectiva; no envia contrasenas TMR',()=>{
const input=legacyUserInput({idUsuario:42,idPersona:80,email:'A@EXAMPLE.TEST',nombres:' Ana ',apellidos:' Pérez ',activo:true},
1,0,'tmr-glpi-sync:11111111-2222-3333-4444-555555555555');
assert.equal(input.name,'a@example.test');
assert.deepEqual(input._useremails,{'-1':'a@example.test'});
assert.equal(input._default_email,-1);
assert.equal(input._profiles_id,1);
assert.equal(input._entities_id,0);
assert.equal(input.firstname,'Ana');
assert.equal(Object.hasOwn(input,'password'),false);
assert.throws(()=>legacyUserInput({id:42,idPersona:80,email:'a@example.test',activo:false},1,0,'marker'));
});

test('lock impide escritores concurrentes y diario conserva intento incierto tras reinicio',async()=>{
const dir=await mkdtemp(join(tmpdir(),'tmr-transfer-'));
const a=new TransferStore(dir,'tmr','glpi'),b=new TransferStore(dir,'tmr','glpi');
try{
await a.acquire();
await assert.rejects(b.acquire(),/YA_EN_CURSO/);
await a.put(42,{status:'sent',personaId:'80',input:{comment:'marker'}});
await a.release();
await b.acquire();
assert.equal(b.get(42).status,'sent');
assert.equal(b.get(42).input.comment,'marker');
await b.put(42,{...b.get(42),status:'created',glpiUserId:50});
await b.release();
const other=new TransferStore(dir,'otro-tmr','glpi');
await assert.rejects(other.acquire(),/DIARIO_TRANSFERENCIA_INVALIDO/);
await a.acquire();
assert.equal(a.get(42).glpiUserId,50);
}finally{
await a.release();await b.release();await rm(dir,{recursive:true,force:true});
}
});
