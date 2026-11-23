import test from 'node:test';
import assert from 'node:assert/strict';
import {InventoryClient} from '../src/clients/inventory.client.mjs';

test('InventoryClient autentica y consulta equipos',async()=>{
    const originalFetch=globalThis.fetch;
    const calls=[];
    globalThis.fetch=async(url,options)=>{
        calls.push({url,options});
        if(String(url).endsWith('/api/v1/auth/login')){
            return new Response(JSON.stringify({data:{token:'inventory-token'}}),{status:200});
        }
        return new Response(JSON.stringify({data:[{id:7,itemCode:'EQ-007'}]}),{status:200});
    };
    try{
        const client=new InventoryClient({url:'https://inventory.example',authUrl:'https://auth.example',user:'svc@example',password:'secret'});
        await client.authenticate();
        const equipment=await client.getEquipment();
        assert.deepEqual(equipment,[{id:7,itemCode:'EQ-007'}]);
        assert.equal(calls[0].options.method,'POST');
        assert.equal(calls[1].options.headers.Authorization,'Bearer inventory-token');
    }finally{
        globalThis.fetch=originalFetch;
    }
});

test('InventoryClient rechaza URLs no HTTPS',()=>{
    assert.throws(
        ()=>new InventoryClient({url:'http://inventory.example',user:'u',password:'p'}),
        /requiere HTTPS/
    );
});
