import {resolve} from 'node:path';
const required=[
    'TMR_URL',
    'TMR_USER',
    'TMR_PASSWORD',
    'GLPI_URL',
    'GLPI_CLIENT_ID',
    'GLPI_CLIENT_SECRET',
    'GLPI_USER',
    'GLPI_PASSWORD',
    'INVENTORY_URL',
    'INVENTORY_USER',
    'INVENTORY_PASSWORD',
    'SUPPORT_PROJECT_CODE'
];

function readBoolean(key,defaultValue){
    const raw=process.env[key];

    if(raw===undefined||String(raw).trim()===''){
        return defaultValue;
    }

    const value=String(raw).trim().toLowerCase();

    if(value==='true')return true;
    if(value==='false')return false;

    throw new Error(`${key} debe ser true o false.`);
}

function readPositiveInteger(key,defaultValue){
    const raw=process.env[key];

    if(raw===undefined||String(raw).trim()===''){
        return defaultValue;
    }

    const value=Number(raw);

    if(!Number.isSafeInteger(value)||value<1){
        throw new Error(`${key} debe ser un entero positivo.`);
    }

    return value;
}

function readOptionalId(key){
    const raw=String(process.env[key]??'').trim();

    if(!raw){
        return null;
    }

    if(!/^[1-9]\d*$/.test(raw)){
        throw new Error(`${key} debe ser un ID positivo valido.`);
    }

    return raw;
}

function readRequired(key){
    const value=process.env[key];

    if(
        typeof value!=='string'||
        !value.trim()||
        value.trim().toUpperCase().startsWith('REEMPLAZAR')
    ){
        throw new Error(`Falta configurar ${key}.`);
    }

    return value.trim();
}

function validateURL(key){
    const raw=readRequired(key);
    let url;

    try{
        url=new URL(raw);
    }catch{
        throw new Error(`${key} contiene una URL invalida.`);
    }

    if(url.protocol!=='https:'){
        throw new Error(`${key} requiere HTTPS.`);
    }

    if(
        url.username||
        url.password||
        url.search||
        url.hash
    ){
        throw new Error(`${key} contiene componentes no permitidos.`);
    }

    return url.origin;
}

function validateSyncMode(){
    const mode=String(
        process.env.SYNC_MODE??'PREVALIDACION'
    ).trim().toUpperCase();

    if(!['PREVALIDACION','REAL'].includes(mode)){
        throw new Error('SYNC_MODE invalido.');
    }

    return mode;
}

export function loadConfig(){
    for(const key of required){
        readRequired(key);
    }

    const tmrUrl=validateURL('TMR_URL');
    const glpiUrl=validateURL('GLPI_URL');
    const inventoryUrl=validateURL('INVENTORY_URL');
    const inventoryAuthUrl=process.env.INVENTORY_AUTH_URL?.trim()
        ?validateURL('INVENTORY_AUTH_URL')
        :inventoryUrl;

    const mode=validateSyncMode();
    const enabled=readBoolean('SYNC_ENABLED',false);
    const dryRun=readBoolean('SYNC_DRY_RUN',true);
    const maxWrites=readPositiveInteger('SYNC_MAX_WRITES',1);
    const allowedTmrUserId=readOptionalId('SYNC_ALLOWED_TMR_USER_ID');

    const realRequested=mode==='REAL'&&enabled&&!dryRun;

    if(mode==='PREVALIDACION'&&enabled&&!dryRun){
        throw new Error(
            'No se permiten escrituras reales en modo PREVALIDACION.'
        );
    }

    if(mode==='REAL'&&!enabled&&!dryRun){
        throw new Error(
            'SYNC_MODE=REAL requiere SYNC_ENABLED=true para ejecutar escrituras.'
        );
    }

    if(realRequested&&!allowedTmrUserId){
        throw new Error(
            'La primera ejecucion real requiere SYNC_ALLOWED_TMR_USER_ID.'
        );
    }

    if(realRequested&&maxWrites!==1){
        throw new Error(
            'La primera ejecucion real permite solamente SYNC_MAX_WRITES=1.'
        );
    }

    const writesEnabled=false;

    const config={
        tmr:{
            url:tmrUrl,
            user:readRequired('TMR_USER'),
            password:readRequired('TMR_PASSWORD')
        },
        glpi:{
            url:glpiUrl,
            clientId:readRequired('GLPI_CLIENT_ID'),
            clientSecret:readRequired('GLPI_CLIENT_SECRET'),
            user:readRequired('GLPI_USER'),
            password:readRequired('GLPI_PASSWORD')
        },
        inventory:{
            url:inventoryUrl,
            authUrl:inventoryAuthUrl,
            user:readRequired('INVENTORY_USER'),
            password:readRequired('INVENTORY_PASSWORD')
        },
        supportProjectCode:readRequired('SUPPORT_PROJECT_CODE'),
        sync:{
            mode,
            requestedMode:mode,
            scope:allowedTmrUserId
                ?'USUARIO_TMR_AUTORIZADO'
                :'TODOS_LOS_USUARIOS_TMR',
            enabled,
            dryRun,
            writesEnabled,
            maxWrites,
            allowedTmrUserId,
            mappingPath:resolve(process.env.SYNC_DATA_DIR??'./data','mappings.json'),
            validationRequired:true,
            realRequested,
            reason:writesEnabled
                ?'ESCRITURA_HABILITADA'
                :'VERIFICACIONES_GLPI_PENDIENTES'
        }
    };

    console.log('CONFIGURACION_SINCRONIZACION '+JSON.stringify({
        mode:config.sync.mode,
        scope:config.sync.scope,
        enabled:config.sync.enabled,
        dryRun:config.sync.dryRun,
        writesEnabled:config.sync.writesEnabled,
        maxWrites:config.sync.maxWrites,
        allowedTmrUserId:config.sync.allowedTmrUserId,
        reason:config.sync.reason
    }));

    return config;
}
