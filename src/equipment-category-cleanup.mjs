import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {loadConfig} from './config/env.mjs';
import {InventoryClient} from './clients/inventory.client.mjs';
import {GLPILegacyClient} from './clients/glpi-legacy.client.mjs';
import {isComputerCategory} from './equipment-category.mjs';

try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
const text=value=>String(value??'').trim();
const marker=/inventory-glpi-equipment:(\d+)/;

export async function runEquipmentCategoryCleanup({apply=false}={}){
    const config=loadConfig();
    const inventory=new InventoryClient(config.inventory);
    const legacy=new GLPILegacyClient({...config.glpi,appToken:process.env.GLPI_LEGACY_APP_TOKEN});
    await inventory.authenticate();
    await legacy.authenticate();
    const source=await inventory.getEquipment();
    const excluded=new Map(source.filter(row=>!isComputerCategory(row.categoryName)).map(row=>[String(row.id),row]));
    const computers=await legacy.inventoryComputers();
    const rows=[];
    for(const computer of computers){
        const match=marker.exec(text(computer.comment));
        const sourceRow=match?excluded.get(match[1]):null;
        if(!sourceRow)continue;
        const row={inventoryEquipmentId:match[1],glpiComputerId:computer.id,categoria:text(sourceRow.categoryName),name:computer.name,action:apply?'ELIMINADO':'LISTO_PARA_ELIMINAR'};
        if(apply){
            try{await legacy.deleteComputer(computer.id);}catch(error){row.action='REVISAR';row.reason=error.message;}
        }
        rows.push(row);
    }
    const result={mode:apply?'REAL':'PREVALIDACION',source:source.length,computers:computers.length,excludedSource:excluded.size,matched:rows.length,deleted:rows.filter(row=>row.action==='ELIMINADO').length,review:rows.filter(row=>row.action==='REVISAR').length,rows};
    const directory=resolve(process.env.SYNC_DATA_DIR??'./data');
    await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(join(directory,'last-equipment-category-cleanup-report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
    console.log('LIMPIEZA_CATEGORIAS_EQUIPOS_RESULTADO '+JSON.stringify({...result,rows:undefined}));
    return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    const args=new Set(process.argv.slice(2));
    runEquipmentCategoryCleanup({apply:args.has('--apply')}).catch(error=>{console.error('ERROR_LIMPIEZA_CATEGORIAS '+error.message);process.exitCode=1;});
}
