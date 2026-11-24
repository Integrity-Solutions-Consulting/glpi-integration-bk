import {runTransfer} from './transfer.mjs';
import {runProjectTransfer} from './project-transfer.mjs';
import {runRoleTransfer} from './role-transfer.mjs';
import {runEquipmentTransfer} from './equipment-transfer.mjs';
import {runEquipmentDetailsSync} from './equipment-details-sync.mjs';

const rawInterval=Number(process.env.SYNC_INTERVAL_MINUTES??5);
if(!Number.isSafeInteger(rawInterval)||rawInterval<1||rawInterval>1440){
throw new Error('SYNC_INTERVAL_MINUTES debe estar entre 1 y 1440.');
}
const maxCreates=Number(process.env.SYNC_MAX_WRITES??1000);
const maxEquipmentCreates=Number(process.env.EQUIPMENT_MAX_WRITES??1000);
const maxEquipmentUpdates=Number(process.env.EQUIPMENT_DETAIL_MAX_WRITES??1000);
for(const [name,value] of [['SYNC_MAX_WRITES',maxCreates],['EQUIPMENT_MAX_WRITES',maxEquipmentCreates],['EQUIPMENT_DETAIL_MAX_WRITES',maxEquipmentUpdates]]){
if(!Number.isSafeInteger(value)||value<1||value>1000)throw new Error(`${name} debe estar entre 1 y 1000.`);
}
const intervalMs=rawInterval*60*1000;
let stopping=false;
let running=false;

async function cycle(){
if(stopping||running)return;
running=true;
const startedAt=new Date().toISOString();
console.log('SINCRONIZACION_AUTOMATICA_INICIO '+JSON.stringify({startedAt,intervalMinutes:rawInterval}));
try{
const users=await runTransfer({apply:true,maxCreates});
const projects=await runProjectTransfer({apply:true,maxCreates});
const roles=await runRoleTransfer({apply:true,maxWrites:maxCreates});
const equipment=await runEquipmentTransfer({apply:true,maxCreates:maxEquipmentCreates});
const equipmentDetails=await runEquipmentDetailsSync({apply:true,maxUpdates:maxEquipmentUpdates});
console.log('SINCRONIZACION_AUTOMATICA_RESULTADO '+JSON.stringify({
users:{created:users.created,alreadyLinked:users.alreadyLinked,review:users.review},
projects:{created:projects.created,alreadyLinked:projects.alreadyLinked,review:projects.review},
roles:{assigned:roles.assigned,alreadyLinked:roles.alreadyLinked,review:roles.review,skipped:roles.skipped},
equipment:{created:equipment.created,review:equipment.review},
equipmentDetails:{updated:equipmentDetails.updated,review:equipmentDetails.review}
}));
}catch(error){
console.error('SINCRONIZACION_AUTOMATICA_ERROR '+error.message);
}finally{running=false;}
}

process.on('SIGTERM',()=>{stopping=true;console.log('SINCRONIZACION_AUTOMATICA_DETENIENDO');});
process.on('SIGINT',()=>{stopping=true;console.log('SINCRONIZACION_AUTOMATICA_DETENIENDO');});

await cycle();
const timer=setInterval(()=>{if(stopping){clearInterval(timer);return;}void cycle();},intervalMs);
