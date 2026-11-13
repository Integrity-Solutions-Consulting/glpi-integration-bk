
const PROFILES={
    AUTOSERVICIO_PROPUESTO:'Self-Service',
    SOPORTE_PROPUESTO:'Technician',
    SUPERVISOR_PROPUESTO:'Supervisor'
};

const PROTECTED_LOGINS=new Set([
    'glpi',
    'glpi-system',
    'tmr-sync',
    'post-only',
    'tech',
    'normal'
]);

function normalize(value){
    return String(value??'').trim().toLowerCase();
}

function normalizeName(value){
    return normalize(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'')
        .replace(/\s+/g,' ');
}

function getId(value){
    if(value===null||value===undefined){
        return null;
    }

    const id=String(value).trim();

    return /^[1-9]\d*$/.test(id)?id:null;
}

function firstText(...values){
    for(const value of values){
        if(typeof value==='string'&&value.trim()){
            return value.trim();
        }
    }

    return '';
}

function getEmail(row){
    return normalize(firstText(
        row.email,
        row.correo,
        row.correoElectronico,
        row.correo_electronico,
        row.emailUsuario,
        row.emailAddress,
        row.mail
    ));
}

function isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getLogin(row){
    const explicitLogin=normalize(firstText(
        row.login,
        row.usuario,
        row.nombreUsuario,
        row.username,
        row.userName,
        row.nombreusuario,
        row.name
    ));

    if(explicitLogin){
        return explicitLogin;
    }

    const email=getEmail(row);

    return isValidEmail(email)?email:'';
}

function getGLPILogin(user){
    return normalize(
        user?.username??
        user?.name??
        user?.login
    );
}

function getGLPIEmails(user){
    const emails=new Set();
    const visited=new WeakSet();

    function collect(value){
        if(value===null||value===undefined){
            return;
        }

        if(typeof value==='string'){
            const email=normalize(value);

            if(isValidEmail(email)){
                emails.add(email);
            }

            return;
        }

        if(typeof value!=='object'||visited.has(value)){
            return;
        }

        visited.add(value);

        if(Array.isArray(value)){
            for(const item of value){
                collect(item);
            }

            return;
        }

        for(const key of [
            'email',
            'mail',
            'address',
            'value',
            'email_address',
            'emailAddress',
            'emails',
            'useremails'
        ]){
            if(Object.hasOwn(value,key)){
                collect(value[key]);
            }
        }
    }

    for(const key of [
        'email',
        'correo',
        'mail',
        'emails',
        'useremails',
        'email_address',
        'emailAddress'
    ]){
        collect(user?.[key]);
    }

    return emails;
}

function getMatches(row){
    return Array.isArray(row.coincidenciasGLPI)
        ?row.coincidenciasGLPI
        :[];
}

function isActive(row){
    if(row.activo===true||row.activo===1){
        return true;
    }

    if(row.activo===false||row.activo===0){
        return false;
    }

    const status=normalize(row.estado??row.activo);

    return [
        'activo',
        'active',
        'true',
        '1'
    ].includes(status);
}

function getExistingLogins(existing){
    const logins=new Set();

    for(const user of existing){
        const login=getGLPILogin(user);

        if(login){
            logins.add(login);
        }
    }

    return logins;
}

function getExistingEmails(existing){
    const emails=new Set();

    for(const user of existing){
        for(const email of getGLPIEmails(user)){
            emails.add(email);
        }
    }

    return emails;
}

function getIdentityCounts(report){
    const loginCounts=new Map();
    const emailCounts=new Map();
    const personaCounts=new Map();
    const tmrCounts=new Map();

    for(const row of report){
        if(!row||typeof row!=='object'||Array.isArray(row)){
            throw new Error('Registro TMR invalido.');
        }

        const login=getLogin(row);
        const email=getEmail(row);
        const personaId=getId(row.personaId);
        const tmrId=getId(row.tmrUserId);

        if(login){
            loginCounts.set(
                login,
                (loginCounts.get(login)??0)+1
            );
        }

        if(email){
            emailCounts.set(
                email,
                (emailCounts.get(email)??0)+1
            );
        }

        if(personaId){
            personaCounts.set(
                personaId,
                (personaCounts.get(personaId)??0)+1
            );
        }

        if(tmrId){
            tmrCounts.set(
                tmrId,
                (tmrCounts.get(tmrId)??0)+1
            );
        }
    }

    return {
        loginCounts,
        emailCounts,
        personaCounts,
        tmrCounts
    };
}

function getProfileName(proposal){
    if(!Object.hasOwn(PROFILES,proposal)){
        return null;
    }

    return PROFILES[proposal];
}

function getProfileFromAvailable(profileName,availableProfiles){
    if(!Array.isArray(availableProfiles)){
        return {
            name:profileName,
            verified:false,
            reason:'CATALOGO_GLPI_NO_PROPORCIONADO'
        };
    }

    const expected=normalizeName(profileName);

    const matches=availableProfiles.filter(profile=>
        normalizeName(
            typeof profile==='string'
                ?profile
                :profile?.name
        )===expected
    );

    if(matches.length===0){
        return {
            name:profileName,
            verified:false,
            reason:'PERFIL_GLPI_NO_ENCONTRADO'
        };
    }

    if(matches.length>1){
        return {
            name:profileName,
            verified:false,
            reason:'PERFIL_GLPI_AMBIGUO'
        };
    }

    const profile=matches[0];

    return {
        name:typeof profile==='string'
            ?profile
            :profile.name,
        verified:true,
        reason:null
    };
}

export function buildSyncPlan(report,existing=[],options={}){
    if(
        !Array.isArray(report)||
        !Array.isArray(existing)||
        !options||
        typeof options!=='object'||
        Array.isArray(options)
    ){
        throw new Error('Datos de sincronizacion invalidos.');
    }

    const plan=[];

    const existingLogins=getExistingLogins(existing);
    const existingEmails=getExistingEmails(existing);

    const existingIds=new Set(
        existing
            .map(user=>getId(user?.id))
            .filter(Boolean)
    );

    const {
        loginCounts,
        emailCounts,
        personaCounts,
        tmrCounts
    }=getIdentityCounts(report);

    const availableProfiles=options.availableProfiles??null;
    const inventoryComplete=options.inventoryComplete===true;

    for(const row of report){
        const tmrUserId=row.tmrUserId??null;
        const personaId=row.personaId??null;

        const tmrKey=getId(tmrUserId);
        const personaKey=getId(personaId);

        const login=getLogin(row);
        const email=getEmail(row);

        const proposal=row.propuesta;
        const matches=getMatches(row);

        let action='REVISAR_MANUALMENTE';
        let reason='IDENTIDAD_NO_CONFIRMADA';
        let profileName=null;
        let profileVerified=false;
        let glpiUserId=null;

        if(!tmrKey){
            reason='ID_TMR_INVALIDO';
        }else if((tmrCounts.get(tmrKey)??0)>1){
            reason='USUARIO_TMR_DUPLICADO';
        }else if(PROTECTED_LOGINS.has(login)){
            action='EXCLUIR';
            reason='CUENTA_PROTEGIDA';
        }else if(!isActive(row)){
            reason='ESTADO_TMR_NO_ACTIVO';
        }else if(proposal==='REVISAR_LIDER_POR_CORREO'){
            reason='LIDER_SIN_IDENTIFICACION_VERIFICADA';
        }else if(
            proposal==='SUPERVISOR_PROPUESTO'&&
            row.liderVerificado!==true
        ){
            reason='LIDER_SIN_IDENTIFICACION_VERIFICADA';
        }else if(!getProfileName(proposal)){
            reason='PROPUESTA_NO_RECONOCIDA';
        }else{
            const resolved=getProfileFromAvailable(
                getProfileName(proposal),
                availableProfiles
            );

            profileName=resolved.name;
            profileVerified=resolved.verified;

            if(!personaKey){
                reason='PERSONA_TMR_NO_IDENTIFICADA';
            }else if((personaCounts.get(personaKey)??0)>1){
                reason='PERSONA_TMR_DUPLICADA';
            }else if(!login){
                reason='LOGIN_TMR_AUSENTE';
            }else if(!email){
                reason='CORREO_TMR_AUSENTE';
            }else if(!isValidEmail(email)){
                reason='CORREO_TMR_INVALIDO';
            }else if((loginCounts.get(login)??0)>1){
                reason='LOGIN_TMR_DUPLICADO';
            }else if((emailCounts.get(email)??0)>1){
                reason='CORREO_TMR_DUPLICADO';
            }else if(matches.length>1){
                reason='MULTIPLES_COINCIDENCIAS_GLPI';
            }else if(matches.length===1){
                const match=matches[0];

                const matchId=getId(
                    typeof match==='object'
                        ?match?.id
                        :match
                );

                if(!matchId||!existingIds.has(matchId)){
                    reason='COINCIDENCIA_GLPI_INVALIDA';
                }else{
                    glpiUserId=matchId;
                    reason='VINCULACION_GLPI_NO_VERIFICADA';
                }
            }else if(existingLogins.has(login)){
                reason='LOGIN_GLPI_EXISTENTE';
            }else if(existingEmails.has(email)){
                reason='CORREO_GLPI_EXISTENTE';
            }else if(!profileVerified){
                reason=resolved.reason;
            }else{
                action='CREAR_CANDIDATO';
                reason=inventoryComplete
                    ?'SIN_COINCIDENCIA_EN_INVENTARIO_DECLARADO_COMPLETO'
                    :'SIN_COINCIDENCIA_EN_INVENTARIO_VISIBLE';
            }
        }

        plan.push({
            tmrUserId,
            personaId,
            action,
            reason,
            proposedProfileName:profileName,
            profileVerified,
            glpiUserId,
            inventoryComplete,
            writesEnabled:false
        });
    }

    return plan;
}

export function summarizeSyncPlan(plan){
    if(!Array.isArray(plan)){
        throw new Error('Plan de sincronizacion invalido.');
    }

    return plan.reduce((totals,row)=>{
        totals[row.action]=(totals[row.action]??0)+1;
        return totals;
    },{});
}
