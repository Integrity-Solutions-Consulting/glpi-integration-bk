
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {propose} from '../src/services/proposal.service.mjs';

const user={id:1,idPersona:10,email:'a@example.test',activo:true};
const employee={id:2,idPersona:10,activo:true};
const resource={
    idEmpleado:2,
    estadoAsignacion:true,
    entrada:'2026-01-01',
    salida:'2026-12-31'
};
const project={
    id:64,
    codigo:'PR-0064',
    activo:true,
    recursos:[resource],
    lideres:[]
};

const run=(u=[user],p=[project],g=[],l=[])=>
    propose(u,[employee],l,p,g,'PR-0064','2026-11-10');

test('asignacion vigente propone soporte',()=>{
    assert.equal(run()[0].propuesta,'SOPORTE_PROPUESTO');
});

test('asignacion vencida no concede soporte',()=>{
    const p={...project,recursos:[{...resource,salida:'2026-10-01'}]};
    assert.equal(run([user],[p])[0].propuesta,'AUTOSERVICIO_PROPUESTO');
});

test('proyecto ambiguo detiene revision',()=>{
    assert.throws(()=>run([user],[project,project]));
});

test('cuenta local no se adopta',()=>{
    const existing=[{id:1,name:'glpi',email:user.email}];
    assert.equal(run([user],[project],existing)[0].propuesta,'REVISAR_CUENTA_EXISTENTE_NO_MODIFICAR');
});

test('cuenta sin persona no coincide',()=>{
    assert.equal(run([{...user,idPersona:null}])[0].propuesta,'AUTOSERVICIO_PROPUESTO');
});

test('correos duplicados requieren revision',()=>{
    const result=run([user,{...user,id:3}]);
    assert.ok(result.every(x=>x.propuesta==='REVISAR_IDENTIDAD'));
});

test('lider por correo requiere revision',()=>{
    const p={...project,idLider:8};
    const leaders=[{id:8,email:user.email,activo:true}];
    assert.equal(run([{...user,idPersona:99}],[p],[],leaders)[0].propuesta,'REVISAR_LIDER_POR_CORREO');
});

test('fecha TMR futura conserva soporte',()=>{
    const p={...project,recursos:[{...resource,entrada:'01-09-2026',salida:'01-04-2027'}]};
    assert.equal(run([user],[p])[0].propuesta,'SOPORTE_PROPUESTO');
});

test('salida vencida quita soporte',()=>{
    const p={...project,recursos:[{...resource,entrada:'01-09-2026',salida:'11-09-2026'}]};
    assert.equal(run([user],[p])[0].propuesta,'AUTOSERVICIO_PROPUESTO');
});

test('entrada futura no concede soporte',()=>{
    const p={...project,recursos:[{...resource,entrada:'01-12-2026',salida:null}]};
    assert.equal(run([user],[p])[0].propuesta,'AUTOSERVICIO_PROPUESTO');
});

test('salida de hoy conserva soporte',()=>{
    const p={...project,recursos:[{...resource,salida:'10-11-2026'}]};
    assert.equal(run([user],[p])[0].propuesta,'SOPORTE_PROPUESTO');
});

test('ids string y numericos coinciden',()=>{
    const p={...project,recursos:[{...resource,idEmpleado:'2'}]};
    assert.equal(run([user],[p])[0].propuesta,'SOPORTE_PROPUESTO');
});

test('usuario inactivo se omite',()=>{
    assert.equal(run([{...user,activo:false}])[0].propuesta,'OMITIR_INACTIVO');
});

test('proyecto inactivo no concede soporte',()=>{
    assert.equal(run([user],[{...project,activo:false}])[0].propuesta,'AUTOSERVICIO_PROPUESTO');
});
