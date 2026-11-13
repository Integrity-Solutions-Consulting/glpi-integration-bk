
function normalize(value){
    return String(value??'').trim().toLowerCase();
}

function firstText(...values){
    for(const value of values){
        if(typeof value==='string'&&value.trim()){
            return value.trim();
        }
    }

    return '';
}

export function getTMREmail(user){
    if(!user||typeof user!=='object'){
        return '';
    }

    return normalize(firstText(
        user.email,
        user.correo,
        user.correoElectronico,
        user.correo_electronico,
        user.emailUsuario,
        user.emailAddress,
        user.mail
    ));
}

export function isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        normalize(email)
    );
}

export function getTMRLogin(user){
    if(!user||typeof user!=='object'){
        return '';
    }

    const login=normalize(firstText(
        user.login,
        user.usuario,
        user.nombreUsuario,
        user.username,
        user.userName,
        user.nombreusuario,
        user.name
    ));

    if(login){
        return login;
    }

    const email=getTMREmail(user);

    return isValidEmail(email)?email:'';
}

export function getGLPILogin(user){
    if(!user||typeof user!=='object'){
        return '';
    }

    return normalize(firstText(
        user.username,
        user.name,
        user.login
    ));
}

export function getGLPIEmails(user){
    const emails=new Set();
    const visited=new WeakSet();
    const keys=['email','correo','mail','address','value','emails','useremails','email_address','emailAddress'];
    function collect(value){
        if(typeof value==='string'){
            if(isValidEmail(value))emails.add(normalize(value));
            return;
        }
        if(!value||typeof value!=='object'||visited.has(value))return;
        visited.add(value);
        if(Array.isArray(value)){
            for(const item of value)collect(item);
        }else{
            for(const key of keys)if(Object.hasOwn(value,key))collect(value[key]);
        }
    }
    for(const key of keys)collect(user?.[key]);
    return emails;
}

export function identityOverlaps(login,email,glpiUser){
    const identities=new Set([normalize(login),normalize(email)].filter(Boolean));
    return [getGLPILogin(glpiUser),...getGLPIEmails(glpiUser)]
        .some(value=>value&&identities.has(value));
}

// Index by row, not by ID: repeated IDs must also be detected.
export function findTMRDuplicates(users){
    const indexes=new Map();
    const conflicts=users.map(()=>new Set());
    users.forEach((user,index)=>{
        const keys=new Set([
            `id:${String(user?.idUsuario??user?.id??'').trim()}`,
            `persona:${String(user?.idPersona??'').trim()}`,
            ...[getTMRLogin(user),getTMREmail(user)].filter(Boolean).map(value=>`identity:${value}`)
        ]);
        for(const key of keys){
            if(key.endsWith(':'))continue;
            if(!indexes.has(key))indexes.set(key,[]);
            indexes.get(key).push(index);
        }
    });
    for(const [key,rows] of indexes){
        if(rows.length<2)continue;
        const reason=key.startsWith('id:')?'USUARIO_TMR_DUPLICADO'
            :key.startsWith('persona:')?'PERSONA_TMR_DUPLICADA':'IDENTIDAD_TMR_DUPLICADA';
        for(const index of rows)conflicts[index].add(reason);
    }
    return conflicts.map(reasons=>[...reasons]);
}
