
export function normalizeDate(value){
    if(value==null||value==='')return null;
    if(typeof value!=='string')throw new Error('Fecha de asignacion no reconocida.');
    const raw=value.trim();
    const iso=raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    const local=raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    const parts=iso?[iso[1],iso[2],iso[3]]:local?[local[3],local[2],local[1]]:null;
    if(!parts)throw new Error('Formato de fecha de asignacion no reconocido.');
    const [year,month,day]=parts.map(Number);
    const date=new Date(Date.UTC(year,month-1,day));
    if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new Error('Fecha de asignacion invalida.');
    return parts.join('-');
}

export function validDate(value,today,start){
    const normalized=normalizeDate(value);
    return normalized===null||(start?normalized<=today:normalized>=today);
}

export function todayEcuador(){
    const parts=new Intl.DateTimeFormat('en-US',{
        timeZone:'America/Guayaquil',
        year:'numeric',
        month:'2-digit',
        day:'2-digit'
    }).formatToParts(new Date());
    const get=type=>parts.find(p=>p.type===type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}
