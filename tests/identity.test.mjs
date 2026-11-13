
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeId,sameId,mail} from '../src/utils/normalize.mjs';

test('identificadores equivalentes',()=>{
    assert.equal(sameId(2,'2'),true);
});

test('identificadores distintos',()=>{
    assert.equal(sameId(2,3),false);
});

test('identificador ausente',()=>{
    assert.equal(sameId(null,null),false);
});

test('identificador invalido',()=>{
    assert.throws(()=>normalizeId('abc'));
});

test('correo normalizado',()=>{
    assert.equal(mail(' USER@TMR.COM '),'user@tmr.com');
});
