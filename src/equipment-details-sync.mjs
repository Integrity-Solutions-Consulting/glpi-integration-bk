import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {loadConfig} from './config/env.mjs';
import {InventoryClient} from './clients/inventory.client.mjs';
import {GLPILegacyClient} from './clients/glpi-legacy.client.mjs';

try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
const text=value=>String(value??'').trim();
const marker=/inventory-glpi-equipment:(\d+)/;
const normalize=value=>text(value).toLowerCase();

function catalogId(rows,value){const key=normalize(value);if(!key)return null;const row=rows.find(item=>normalize(item.name)===key);return row?.id?Number(row.id):null;}
function characteristic(detail,name){const key=normalize(name);return (Array.isArray(detail.characteristics)?detail.characteristics:[]).find(item=>normalize(item.componentName)===key)?.description;}
function detailComment(detail){
    const characteristics=Array.isArray(detail.characteristics)?detail.characteristics.map(item=>`${text(item.componentName)||'componente'}: ${text(item.description)}`).filter(Boolean).join(' | '):'';
    return [`inventory-glpi-equipment:${detail.id}`,`categoria:${text(detail.categoryName)}`,`estado:${text(detail.equipmentStatusName)}`,`condicion:${text(detail.equipmentConditionName)}`,`empresa:${text(detail.companyName)}`,`factura:${text(detail.invoice)}`,`garantia:${text(detail.warranty)}`,`marca:${text(detail.brand)}`,`modelo:${text(detail.model)}`,`caracteristicas:${characteristics}`].join('; ').slice(0,4000);
}
function catalogConfig(path){
    if(path==='/Computer')return {modelKey:'computerModels',modelField:'computermodels_id',modelPath:'/ComputerModel',typeKey:'computerTypes',typeField:'computertypes_id',typePath:'/ComputerType'};
    if(path==='/Phone')return {modelKey:'phoneModels',modelField:'phonemodels_id',modelPath:'/PhoneModel',typeKey:'phoneTypes',typeField:'phonetypes_id',typePath:'/PhoneType'};
    if(path==='/Peripheral')return {modelKey:'peripheralModels',modelField:'peripheralmodels_id',modelPath:'/PeripheralModel',typeKey:'peripheralTypes',typeField:'peripheraltypes_id',typePath:'/PeripheralType'};
    return {modelKey:'monitorModels',modelField:'monitormodels_id',modelPath:'/MonitorModel',typeKey:'monitorTypes',typeField:'monitortypes_id',typePath:'/MonitorType'};
}
async function ensureCatalog({legacy,catalogs,key,path,value,apply,createdCatalogs}){
    const name=text(value);if(!name)return null;const existing=catalogId(catalogs[key],name);if(existing)return existing;if(!apply)return null;
    const id=await legacy.createCatalogValue(path,name);catalogs[key].push({id,name});createdCatalogs.push({catalog:path,name,id});return id;
}
async function inputForDetail(detail,{path,legacy,catalogs,apply,createdCatalogs}){
    const itemCode=text(detail.itemCode),brand=text(detail.brand),model=text(detail.model),config=catalogConfig(path);
    const input={name:`${itemCode}${brand||model?' - ':''}${brand}${brand&&model?' ':''}${model}`.slice(0,255),serial:text(detail.serialNumber).slice(0,255),otherserial:itemCode.slice(0,255),comment:detailComment(detail)};
    const fields={manufacturers_id:await ensureCatalog({legacy,catalogs,key:'manufacturers',path:'/Manufacturer',value:brand,apply,createdCatalogs}),[config.modelField]:await ensureCatalog({legacy,catalogs,key:config.modelKey,path:config.modelPath,value:model,apply,createdCatalogs}),[config.typeField]:await ensureCatalog({legacy,catalogs,key:config.typeKey,path:config.typePath,value:detail.categoryName,apply,createdCatalogs}),states_id:await ensureCatalog({legacy,catalogs,key:'states',path:'/State',value:detail.equipmentStatusName,apply,createdCatalogs}),locations_id:await ensureCatalog({legacy,catalogs,key:'locations',path:'/Location',value:detail.locationName,apply,createdCatalogs})};
    if(path==='/Computer')fields.operatingSystemId=await ensureCatalog({legacy,catalogs,key:'operatingSystems',path:'/OperatingSystem',value:characteristic(detail,'SISTEMA OPERATIVO'),apply,createdCatalogs});
    for(const [field,id] of Object.entries(fields))if(id!==null)input[field]=id;return input;
}
async function loadCatalogs(legacy){
    const paths={manufacturers:'/Manufacturer',states:'/State',locations:'/Location',operatingSystems:'/OperatingSystem',computerModels:'/ComputerModel',computerTypes:'/ComputerType',phoneModels:'/PhoneModel',phoneTypes:'/PhoneType',peripheralModels:'/PeripheralModel',peripheralTypes:'/PeripheralType',monitorModels:'/MonitorModel',monitorTypes:'/MonitorType'};
    return Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await legacy.inventoryCatalog(path)])));
}
export async function runEquipmentDetailsSync({apply=false,maxUpdates=1000}={}){
    if(!Number.isSafeInteger(maxUpdates)||maxUpdates<1||maxUpdates>1000)throw new Error('MAX_UPDATES_INVALIDO');
    const config=loadConfig(),inventory=new InventoryClient(config.inventory),legacy=new GLPILegacyClient({...config.glpi,appToken:process.env.GLPI_LEGACY_APP_TOKEN});
    await inventory.authenticate();await legacy.authenticate();const source=await inventory.getEquipment();
    const paths=['/Computer','/Phone','/Peripheral','/Monitor'];
    const assets=(await Promise.all(paths.map(async path=>(await legacy.inventoryAssets(path)).map(row=>({path,row}))))).flat();
    const catalogs=await loadCatalogs(legacy);const bySourceId=new Map(assets.map(({path,row})=>{const match=marker.exec(text(row.comment));return match?[match[1],{path,row}]:null;}).filter(Boolean));
    const result={mode:apply?'REAL':'PREVALIDACION',source:source.length,assets:assets.length,detailsRead:0,updated:0,planned:0,review:0,createdCatalogs:[],rows:[]};
    for(const summary of source){
        const sourceId=text(summary.id),target=bySourceId.get(sourceId);if(!target){result.review++;result.rows.push({inventoryEquipmentId:sourceId,action:'REVISAR',reason:'ACTIVO_GLPI_NO_ENCONTRADO'});continue;}
        let detail;try{detail=await inventory.getEquipmentDetail(sourceId);result.detailsRead++;}catch(error){result.review++;result.rows.push({inventoryEquipmentId:sourceId,action:'REVISAR',reason:error.message});continue;}
        const input=await inputForDetail(detail,{path:target.path,legacy,catalogs,apply,createdCatalogs:result.createdCatalogs});
        if(!apply){result.planned++;result.rows.push({inventoryEquipmentId:sourceId,action:'LISTO_PARA_ACTUALIZAR',glpiAssetType:target.path,glpiAssetId:target.row.id});continue;}
        if(result.updated>=maxUpdates){result.planned++;result.rows.push({inventoryEquipmentId:sourceId,action:'PENDIENTE_LIMITE',glpiAssetType:target.path,glpiAssetId:target.row.id});continue;}
        try{const {operatingSystemId,...assetInput}=input;await legacy.updateAsset(target.path,target.row.id,assetInput);if(target.path==='/Computer'&&operatingSystemId)await legacy.setComputerOperatingSystem(target.row.id,operatingSystemId);const verified=await legacy.verifyAsset(target.path,target.row.id,assetInput);result.updated++;result.rows.push({inventoryEquipmentId:sourceId,action:'ACTUALIZADO_Y_VERIFICADO',glpiAssetType:target.path,glpiAssetId:verified.id});}catch(error){result.review++;result.rows.push({inventoryEquipmentId:sourceId,action:'REVISAR',reason:error.message,glpiAssetType:target.path,glpiAssetId:target.row.id});break;}
    }
    const directory=resolve(process.env.SYNC_DATA_DIR??'./data');await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'last-equipment-details-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log('SINCRONIZACION_DETALLE_EQUIPOS_RESULTADO '+JSON.stringify({...result,rows:undefined}));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const args=new Set(process.argv.slice(2));runEquipmentDetailsSync({apply:args.has('--apply'),maxUpdates:Number(process.env.EQUIPMENT_DETAIL_MAX_WRITES??(args.has('--apply')?'1':'1000'))}).catch(error=>{console.error('ERROR_DETALLE_EQUIPOS '+error.message);process.exitCode=1;});}
