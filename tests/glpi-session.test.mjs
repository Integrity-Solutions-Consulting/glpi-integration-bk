import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectSession,inspectEntityTree} from '../src/services/glpi-session.service.mjs';
import {request} from '../src/clients/http.client.mjs';
import {GLPIClient} from '../src/clients/glpi.client.mjs';

test('derecho CREATE se calcula por bit, sin convertir valores desconocidos',()=>{
for(const [rights,expected] of [[0,false],[1,false],[3,false],[4,true],[7,true],[31,true],
['7',null],[true,null],[-1,null],[null,null],[undefined,null],[2**32+4,null]]){
assert.equal(inspectSession({active_profile:{rights:{user:rights}}},'tmr-sync').createRight,expected);
}
});

test('sesion vacia, perfil predeterminado o identidad distinta no verifican contexto',()=>{
assert.equal(inspectSession({},'tmr-sync').sessionStructureVerified,false);
const session={user_id:7,name:'tmr-sync',active_profile:{id:9},
active_entity:{id:0,recursive:0},active_entities:[0]};
assert.equal(inspectSession(session,'tmr-sync').sessionStructureVerified,true);
assert.equal(inspectSession(session,'otra-cuenta').sessionStructureVerified,false);
assert.equal(inspectSession({...session,active_entities:[]},'tmr-sync').sessionStructureVerified,false);
assert.equal(inspectSession({...session,active_profile:null,default_profile:9},'tmr-sync').sessionStructureVerified,false);
assert.equal(inspectSession(session,'tmr-sync').recursive,false);
assert.equal(inspectSession({...session,active_entity:{id:0,recursive:'false'}},'tmr-sync').recursive,null);
});

test('respuestas malformadas no se consideran sesiones',()=>{
for(const value of [null,[],true,'ok'])assert.throws(()=>inspectSession(value,'tmr-sync'));
});

test('arbol recorre hijos y conserva entidad raiz cero',()=>{
assert.deepEqual(inspectEntityTree([{key:0,children:[{key:2,children:[]}]}]),
{entityIds:[0,2],nodesRead:2});
for(const value of [{},null,[{key:0}],[{key:'0',children:[]}]]){
assert.throws(()=>inspectEntityTree(value));
}
});

test('cliente nuevo bloquea permisos, sesion, cobertura e inventario desconocidos',()=>{
const client=new GLPIClient({url:'https://example.invalid'});
assert.equal(client.getWriteBlockers().readyToWrite,false);
assert.ok(client.getWriteBlockers().blockers.includes('CONTRATO_NO_VERIFICADO'));
client.sessionContext={session:{userId:7}};
client.invalidateInventory();
assert.equal(client.sessionContext,null);
});

test('transporte bloquea POST aunque el llamador envie todos los indicadores true',async()=>{
await assert.rejects(request('https://example.invalid','/api.php/v2.3/Administration/User','token',{},false,{
allowWrite:true,syncEnabled:true,confirmed:true,inventoryVerified:true,permissionsVerified:true,
identityVerified:true,contractVerified:true,dryRun:false,maxWrites:1,allowedTmrUserId:1,tmrUserId:1
}),/contrato de creacion y cobertura global pendientes/);
await assert.rejects(request('https://example.invalid','/api.php/v2/Administration/User','token',{}),
/Escritura HTTP no autorizada/);
});
