import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {loadConfig} from './config/env.mjs';
import {InventoryClient} from './clients/inventory.client.mjs';
import {GLPILegacyClient} from './clients/glpi-legacy.client.mjs';
import {assetPathForCategory} from './equipment-category.mjs';

try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}

const positive=value=>/^[1-9]\d*$/.test(String(value??''));
const text=value=>String(value??'').trim();

function inputForEquipment(equipment){
    const id=text(equipment?.id);
    const itemCode=text(equipment?.itemCode);
    const serial=text(equipment?.serialNumber);
    const category=text(equipment?.categoryName)||'Equipo';
    const brand=text(equipment?.brand);
    const model=text(equipment?.model);
    if(!positive(id)||!itemCode||!serial){
        throw new Error('EQUIPO_INVENTORY_DATOS_INCOMPLETOS');
    }
    return {
        name:`${itemCode}${brand||model?' - ':''}${brand}${brand&&model?' ':''}${model}`.slice(0,255),
        serial:serial.slice(0,255),
        otherserial:itemCode.slice(0,255),
        entities_id:0,
        is_dynamic:0,
        is_deleted:0,
        is_template:0,
        comment:`inventory-glpi-equipment:${id}; categoria:${category}`.slice(0,255)
    };
}

export async function runEquipmentTransfer({apply=false,maxCreates=1}={}){
    if(!Number.isSafeInteger(maxCreates)||maxCreates<1||maxCreates>1000)throw new Error('MAX_CREATES_INVALIDO');
    const config=loadConfig();
    const inventory=new InventoryClient(config.inventory);
    const legacy=new GLPILegacyClient({...config.glpi,appToken:process.env.GLPI_LEGACY_APP_TOKEN});
    await inventory.authenticate();
    await legacy.authenticate();
    const source=await inventory.getEquipment();
    const paths=['/Computer','/Phone','/Peripheral','/Monitor'];
    const existingByPath=new Map(await Promise.all(paths.map(async path=>[path,await legacy.inventoryAssets(path)])));
    const byPath=new Map(paths.map(path=>[path,{serial:new Map(existingByPath.get(path).map(row=>[text(row.serial).toLowerCase(),row]).filter(([key])=>key)),other:new Map(existingByPath.get(path).map(row=>[text(row.otherserial).toLowerCase(),row]).filter(([key])=>key))}]));
    const existing=paths.flatMap(path=>existingByPath.get(path));
    const sourceSerials=new Set();
    const sourceItemCodes=new Set();
    const result={mode:apply?'REAL':'PREVALIDACION',source:source.length,existing:existing.length,planned:0,created:0,review:0,rows:[]};
    for(const equipment of source){
        const sourceId=text(equipment?.id);
        const assetPath=assetPathForCategory(equipment?.categoryName);
        let input;
        try{input=inputForEquipment(equipment);}catch(error){result.review++;result.rows.push({inventoryEquipmentId:sourceId,action:'REVISAR',reason:error.message});continue;}
        const serialKey=input.serial.toLowerCase();
        const itemCodeKey=input.otherserial.toLowerCase();
        if(sourceSerials.has(serialKey)||sourceItemCodes.has(itemCodeKey)){
            result.review++;
            result.rows.push({inventoryEquipmentId:sourceId,action:'REVISAR',reason:'DUPLICADO_EN_INVENTARIO_FUENTE'});
            continue;
        }
        sourceSerials.add(serialKey);
        sourceItemCodes.add(itemCodeKey);
        const indexes=byPath.get(assetPath);
        const duplicate=indexes.serial.get(input.serial.toLowerCase())??indexes.other.get(input.otherserial.toLowerCase());
        if(duplicate){result.rows.push({inventoryEquipmentId:sourceId,action:'YA_EXISTE',glpiAssetType:assetPath,glpiAssetId:duplicate.id});continue;}
        if(result.created>=maxCreates){result.rows.push({inventoryEquipmentId:sourceId,action:'PENDIENTE_LIMITE'});continue;}
        if(!apply){result.planned++;result.rows.push({inventoryEquipmentId:sourceId,action:'LISTO_PARA_CREAR',glpiAssetType:assetPath});continue;}
        try{
            const id=await legacy.createAsset(assetPath,input);
            const created=await legacy.verifyAsset(assetPath,id,input);
            indexes.serial.set(input.serial.toLowerCase(),created);
            indexes.other.set(input.otherserial.toLowerCase(),created);
            result.created++;result.rows.push({inventoryEquipmentId:sourceId,action:'CREADO_Y_VERIFICADO',glpiAssetType:assetPath,glpiAssetId:id});
        }catch(error){result.review++;result.rows.push({inventoryEquipmentId:sourceId,action:'REVISAR',reason:error.message});break;}
    }
    const directory=resolve(process.env.SYNC_DATA_DIR??'./data');
    await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(join(directory,'last-equipment-transfer-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
    console.log('TRANSFERENCIA_EQUIPOS_RESULTADO '+JSON.stringify({...result,rows:undefined}));
    return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    const args=new Set(process.argv.slice(2));
    runEquipmentTransfer({apply:args.has('--apply'),maxCreates:Number(process.env.EQUIPMENT_MAX_WRITES??(args.has('--apply')?'1':'1000'))})
        .catch(error=>{console.error('ERROR_TRANSFERENCIA_EQUIPOS '+error.message);process.exitCode=1;});
}
