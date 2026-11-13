import {auditTransfer} from './transfer-audit.service.mjs';

const PROTECTED_LOGINS=new Set([
    'glpi','glpi-system','tmr-sync','post-only','tech','normal'
]);

const PROFILE_NAMES=new Set([
    'self-service','technician','supervisor'
]);

function normalize(value){
    return String(value??'').trim().toLowerCase();
}

function normalizeName(value){
    return normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
}

function validId(value){
    const id=String(value??'').trim();
    return /^[1-9]\d*$/.test(id)?id:null;
}

function firstText(...values){
    for(const value of values){
        if(typeof value==='string'&&value.trim())return value.trim();
    }
    return '';
}

function validEmail(value){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(value));
}

function getTMRId(user){
    return validId(user?.idUsuario??user?.id);
}

function getEmail(user){
    return normalize(firstText(
        user?.email,user?.correo,user?.correoElectronico,
        user?.correo_electronico,user?.emailUsuario,
        user?.emailAddress,user?.mail
    ));
}

function getLogin(user){
    const explicit=normalize(firstText(
        user?.login,user?.usuario,user?.nombreUsuario,
        user?.username,user?.userName,user?.nombreusuario,
        user?.name
    ));
    if(explicit)return explicit;
    const email=getEmail(user);
    return validEmail(email)?email:'';
}

function getGLPILogin(user){
    return normalize(user?.username??user?.name??user?.login);
}

function getGLPIEmails(user){
    const emails=new Set();
    const visited=new WeakSet();

    function collect(value){
        if(value==null)return;
        if(typeof value==='string'){
            const email=normalize(value);
            if(validEmail(email))emails.add(email);
            return;
        }
        if(typeof value!=='object'||visited.has(value))return;
        visited.add(value);
        if(Array.isArray(value)){
            for(const item of value)collect(item);
            return;
        }
        for(const key of ['email','mail','address','value','emails','useremails']){
            if(Object.hasOwn(value,key))collect(value[key]);
        }
    }

    for(const key of ['email','mail','emails','useremails','emailAddress']){
        collect(user?.[key]);
    }

    return emails;
}

function findConflicts(existing,login,email){
    return existing.filter(user=>
        getGLPILogin(user)===login||
        getGLPILogin(user)===email||
        getGLPIEmails(user).has(email)
    );
}

function result(operation,action,reason,extra={}){
    return {
        tmrUserId:operation?.tmrUserId??null,
        personaId:operation?.personaId??null,
        action,
        reason,
        proposedProfileName:operation?.proposedProfileName??null,
        proposedProfileId:operation?.proposedProfileId??null,
        glpiUserId:operation?.glpiUserId??null,
        changesApplied:0,
        ...extra
    };
}

function indexUsers(users){
    const usersById=new Map();
    const duplicateIds=new Set();
    const loginOwners=new Map();
    const emailOwners=new Map();

    for(const user of users){
        if(!user||typeof user!=='object'||Array.isArray(user))continue;
        const id=getTMRId(user);
        if(!id)continue;

        if(usersById.has(id)){
            duplicateIds.add(id);
        }else{
            usersById.set(id,user);
        }

        for(const [value,index] of [
            [getLogin(user),loginOwners],
            [getEmail(user),emailOwners]
        ]){
            if(!value)continue;
            if(!index.has(value))index.set(value,new Set());
            index.get(value).add(id);
        }
    }

    return {usersById,duplicateIds,loginOwners,emailOwners};
}

export class SyncService{
    constructor({tmr,glpi,mapping,config}){
        if(!glpi)throw new Error('GLPIClient obligatorio.');
        if(!mapping)throw new Error('MappingService obligatorio.');
        this.tmr=tmr;
        this.glpi=glpi;
        this.mapping=mapping;
        this.config=config??{};
    }

    async execute(plan,users,existing){
        if(!Array.isArray(plan)||!Array.isArray(users)||!Array.isArray(existing)){
            throw new Error('Datos de sincronizacion invalidos.');
        }

        await this.mapping.load();
        const reconciliation=auditTransfer({users,existing,mappings:this.mapping.getAll(),
            inventoryComplete:this.glpi.lastInventory?.inventoryComplete===true&&this.config.inventoryComplete===true,
            detailErrors:this.glpi.detailedInventoryCache?.detailErrors??null});
        console.log('CONCILIACION_TMR_GLPI '+JSON.stringify(reconciliation));

        const results=[];
        const seenOperations=new Set();
        const {
            usersById,
            duplicateIds,
            loginOwners,
            emailOwners
        }=indexUsers(users);

        const profiles=Array.isArray(this.config.availableProfiles)
            ?this.config.availableProfiles
            :await this.glpi.getProfiles();

        const profilesByName=new Map();
        const ambiguousProfiles=new Set();

        for(const profile of profiles){
            const name=normalizeName(profile?.name);
            if(!name)continue;
            if(profilesByName.has(name)){
                ambiguousProfiles.add(name);
            }else{
                profilesByName.set(name,profile);
            }
        }

        const inventoryComplete=
            this.glpi.lastInventory?.inventoryComplete===true&&
            this.config.inventoryComplete===true;

        console.log('SINCRONIZACION_DATOS_REALES '+JSON.stringify({
            mode:'PREVALIDACION',
            totalUsuariosTMR:users.length,
            totalUsuariosGLPI:existing.length,
            totalOperaciones:plan.length,
            perfilesDisponibles:profiles.length,
            inventoryComplete,
            writesEnabled:false
        }));

        for(const operation of plan){
            if(!operation||typeof operation!=='object'||Array.isArray(operation)){
                throw new Error('Operacion del plan invalida.');
            }

            const reject=(reason,action='REVISAR_MANUALMENTE',extra={})=>{
                results.push(result(operation,action,reason,extra));
            };

            const tmrId=validId(operation.tmrUserId);

            if(!tmrId){
                reject('ID_TMR_INVALIDO');
                continue;
            }

            if(seenOperations.has(tmrId)){
                reject('OPERACION_TMR_DUPLICADA');
                continue;
            }
            seenOperations.add(tmrId);

            if(operation.action==='EXCLUIR'){
                reject(operation.reason??'EXCLUIDO_POR_PLAN','OMITIR');
                continue;
            }

            if(!['CREAR_CANDIDATO','REVISAR_MANUALMENTE'].includes(operation.action)){
                reject('OPERACION_NO_AUTORIZADA');
                continue;
            }

            if(duplicateIds.has(tmrId)){
                reject('USUARIO_TMR_DUPLICADO');
                continue;
            }

            const user=usersById.get(tmrId);
            if(!user){
                reject('USUARIO_TMR_INEXISTENTE');
                continue;
            }

            const personaId=validId(user.idPersona);
            if(!personaId||personaId!==validId(operation.personaId)){
                reject('PERSONA_TMR_NO_COINCIDE');
                continue;
            }

            const reconciled=reconciliation.rows.find(row=>row.tmrUserId===tmrId);
            if(!reconciled||reconciled.action==='REVISAR_MANUALMENTE'){
                reject(reconciled?.reasons[0]??'IDENTIDAD_NO_CONCILIADA');
                continue;
            }
            if(reconciled.action==='YA_VINCULADO'){
                reject('VINCULACION_EXISTENTE_NO_RECREAR','YA_VINCULADO',{
                    glpiUserId:reconciled.glpiUserId,writesEnabled:false
                });
                continue;
            }

            if(operation.action==='REVISAR_MANUALMENTE'){
                reject(operation.reason??'REVISION_REQUERIDA');
                continue;
            }

            const profileName=normalizeName(operation.proposedProfileName);

            if(!profileName||!PROFILE_NAMES.has(profileName)){
                reject('PERFIL_GLPI_NO_AUTORIZADO');
                continue;
            }

            if(ambiguousProfiles.has(profileName)){
                reject('PERFIL_GLPI_AMBIGUO');
                continue;
            }

            const profile=profilesByName.get(profileName);
            const profileId=validId(profile?.id);

            if(!profileId){
                reject('PERFIL_GLPI_NO_ENCONTRADO');
                continue;
            }

            if(
                validId(operation.proposedProfileId)&&
                validId(operation.proposedProfileId)!==profileId
            ){
                reject('PERFIL_GLPI_ID_NO_COINCIDE');
                continue;
            }

            if(
                profileName==='supervisor'&&
                operation.liderVerificado!==true&&
                user.liderVerificado!==true
            ){
                reject('LIDER_SIN_IDENTIFICACION_VERIFICADA');
                continue;
            }

            const login=getLogin(user);
            const email=getEmail(user);

            if(!login||!validEmail(email)){
                reject('IDENTIDAD_TMR_INCOMPLETA');
                continue;
            }

            if(PROTECTED_LOGINS.has(login)){
                reject('LOGIN_PROTEGIDO','OMITIR');
                continue;
            }

            if((loginOwners.get(login)?.size??0)>1){
                reject('LOGIN_TMR_DUPLICADO');
                continue;
            }

            if((emailOwners.get(email)?.size??0)>1){
                reject('CORREO_TMR_DUPLICADO');
                continue;
            }

            const mapped=this.mapping.getByTMR(tmrId);
            const mappedByPersona=this.mapping.getByPersona(personaId);

            if(mappedByPersona&&mappedByPersona.tmrUserId!=tmrId){
                reject('PERSONA_VINCULADA_A_OTRO_USUARIO');
                continue;
            }

            if(mapped){
                if(validId(mapped.personaId)!==personaId){
                    reject('PERSONA_VINCULADA_DIFERENTE');
                    continue;
                }

                if(mapped.verified!==true){
                    reject('VINCULACION_GLPI_NO_VERIFICADA');
                    continue;
                }

                const glpiId=validId(mapped.glpiUserId);
                if(!glpiId){
                    reject('ID_GLPI_VINCULADO_INVALIDO');
                    continue;
                }

                const matches=existing.filter(item=>validId(item?.id)===glpiId);

                if(matches.length!==1){
                    reject('CUENTA_VINCULADA_NO_LOCALIZADA');
                    continue;
                }

                const target=matches[0];
                const targetLogin=getGLPILogin(target);

                if(
                    PROTECTED_LOGINS.has(targetLogin)||
                    targetLogin!==normalize(mapped.login)||
                    targetLogin!==login||
                    normalize(mapped.email)!==email
                ){
                    reject('IDENTIDAD_GLPI_MODIFICADA');
                    continue;
                }

                const conflicts=findConflicts(existing,login,email)
                    .filter(item=>validId(item.id)!==glpiId);

                if(conflicts.length){
                    reject('IDENTIDAD_GLPI_DUPLICADA');
                    continue;
                }

                reject('VINCULACION_EXISTENTE','ACTUALIZAR_CANDIDATO',{
                    glpiUserId:glpiId,
                    proposedProfileId:Number(profileId),
                    proposedProfileName:profile.name,
                    resolvedProfileName:profile.name,
                    profileVerified:true,
                    inventoryComplete,
                    writesEnabled:false
                });
                continue;
            }

            const conflicts=findConflicts(existing,login,email);

            if(conflicts.length){
                reject('CUENTA_GLPI_CONFLICTIVA');
                continue;
            }

            reject(
                inventoryComplete
                    ?'IDENTIDAD_SIN_CONFLICTO_EN_INVENTARIO_VERIFICADO'
                    :'IDENTIDAD_SIN_CONFLICTO_VISIBLE',
                'CREAR_CANDIDATO',
                {
                    personaId,
                    proposedProfileId:Number(profileId),
                    proposedProfileName:profile.name,
                    resolvedProfileName:profile.name,
                    profileVerified:true,
                    loginDesdeCorreo:login===email,
                    inventoryComplete,
                    writesEnabled:false,
                    readyToWrite:false
                }
            );
        }

        const summary=this.summarize(results);

        const response={
            mode:'PREVALIDACION',
            writesEnabled:false,
            changesApplied:0,
            inventoryComplete,
            results,
            summary,
            reconciliation
        };

        console.log('RESUMEN_SINCRONIZACION_DATOS_REALES '+JSON.stringify({
            usuariosTMR:users.length,
            usuariosGLPI:existing.length,
            operacionesProcesadas:results.length,
            resumen:summary,
            inventoryComplete,
            writesEnabled:false,
            changesApplied:0
        }));

        return response;
    }

    summarize(results){
        if(!Array.isArray(results)){
            throw new Error('Resultados de sincronizacion invalidos.');
        }

        return results.reduce((totals,item)=>{
            totals[item.action]=(totals[item.action]??0)+1;
            return totals;
        },{});
    }
}
