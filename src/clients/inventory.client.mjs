import {request} from './http.client.mjs';

const normalize=value=>String(value??'').trim();

export class InventoryClient{
    constructor(config){
        this.config=config??{};
        this.baseUrl=normalize(this.config.url).replace(/\/+$/,'');
        this.authUrl=normalize(this.config.authUrl||this.baseUrl).replace(/\/+$/,'');
        if(!this.baseUrl)throw new Error('INVENTORY_URL no configurada.');
        const url=new URL(this.baseUrl);
        const authUrl=new URL(this.authUrl);
        if(url.protocol!=='https:')throw new Error('La conexion INVENTORY requiere HTTPS.');
        if(authUrl.protocol!=='https:')throw new Error('La conexion INVENTORY_AUTH requiere HTTPS.');
        this.token=null;
    }

    async authenticate(){
        const raw=await request(this.authUrl,'/api/v1/auth/login',null,{
            email:this.config.user,
            password:this.config.password
        });
        const data=raw?.data??raw;
        this.token=data?.token??data?.accessToken??data?.access_token??null;
        if(typeof this.token!=='string'||!this.token.trim()){
            throw new Error('INVENTORY no devolvio un token valido.');
        }
        console.log('INVENTORY_AUTENTICACION: OK');
        return true;
    }

    ensureAuthenticated(){
        if(!this.token)throw new Error('INVENTORY no esta autenticado.');
    }

    async get(path){
        this.ensureAuthenticated();
        const raw=await request(this.baseUrl,path,this.token);
        if(raw==null)throw new Error(`INVENTORY devolvio una respuesta vacia: ${path}`);
        return raw;
    }

    unwrap(raw){return raw?.data??raw;}

    getList(raw){
        const data=this.unwrap(raw);
        if(Array.isArray(data))return data;
        for(const key of ['content','items','results','rows']){
            if(Array.isArray(data?.[key]))return data[key];
        }
        throw new Error('La respuesta INVENTORY no contiene una lista valida.');
    }

    async getEquipment(){
        const items=this.getList(await this.get('/api/v1/equipment'));
        console.log('INVENTORY_EQUIPOS_CONSULTADOS '+items.length);
        return items;
    }

    async getEquipmentDetail(id){
        const value=Number(id);
        if(!Number.isSafeInteger(value)||value<=0)throw new Error('ID_EQUIPO_INVENTORY_INVALIDO');
        const raw=await this.get(`/api/v1/equipment/detail/${value}`);
        const detail=this.unwrap(raw);
        if(!detail||typeof detail!=='object'||Array.isArray(detail)){
            throw new Error(`DETALLE_EQUIPO_INVENTORY_INVALIDO:${value}`);
        }
        if(String(detail.id)!==String(value))throw new Error(`DETALLE_EQUIPO_INVENTORY_ID_INCONSISTENTE:${value}`);
        return detail;
    }

    async diagnose(){
        const equipment=await this.getEquipment();
        return {
            backend:this.baseUrl,
            authenticated:true,
            equipment:equipment.length,
            fields:equipment[0]&&typeof equipment[0]==='object'?Object.keys(equipment[0]):[]
        };
    }
}
