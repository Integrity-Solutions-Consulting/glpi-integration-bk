
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDate,validDate} from '../src/utils/dates.mjs';

test('fecha TMR dd-mm-yyyy',()=>{
    assert.equal(normalizeDate('01-04-2027'),'2027-04-01');
});

test('fecha ISO',()=>{
    assert.equal(normalizeDate('2027-04-01'),'2027-04-01');
});

test('fecha invalida',()=>{
    assert.throws(()=>normalizeDate('31-02-2027'));
});

test('formato desconocido',()=>{
    assert.throws(()=>normalizeDate('otra'));
});

test('salida del mismo dia es vigente',()=>{
    assert.equal(validDate('10-11-2026','2026-11-10',false),true);
});

test('entrada futura no es vigente',()=>{
    assert.equal(validDate('01-12-2026','2026-11-10',true),false);
});
