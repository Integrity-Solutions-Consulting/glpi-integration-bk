const COMPUTER_CATEGORIES=new Set(['laptop','cpu','equipo de escritorio']);

export function isComputerCategory(value){
    return COMPUTER_CATEGORIES.has(String(value??'').trim().toLowerCase());
}

export function assetPathForCategory(value){
    const category=String(value??'').trim().toLowerCase();
    if(isComputerCategory(category))return '/Computer';
    if(category==='telefono')return '/Phone';
    if(category==='monitor')return '/Monitor';
    return '/Peripheral';
}
