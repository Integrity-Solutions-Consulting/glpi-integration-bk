
export function list(value){
    if(Array.isArray(value))return value;
    for(const key of ['data','items','results']){
        if(Array.isArray(value?.[key]))return value[key];
        if(value?.[key]&&typeof value[key]==='object')return list(value[key]);
    }
    throw new Error('Formato de lista no reconocido; se detuvo la revision.');
}

export function mail(value){
    return typeof value==='string'?value.trim().toLowerCase():'';
}

export function emails(user){
    return [
        user.email,
        ...(Array.isArray(user.emails)?user.emails.map(e=>typeof e==='string'?e:e.email):[])
    ].map(mail).filter(Boolean);
}

export function normalizeId(value){
    if(value===null||value===undefined||value==='')return null;
    const id=String(value).trim();
    if(!/^\d+$/.test(id))throw new Error('Identificador TMR invalido.');
    return BigInt(id).toString();
}

export function sameId(a,b){
    const x=normalizeId(a);
    const y=normalizeId(b);
    return x!==null&&y!==null&&x===y;
}
