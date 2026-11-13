
import {request} from './http.client.mjs';
import {list} from '../utils/normalize.mjs';

export class TMRClient{
    constructor(config){
        this.config=config;
        this.token=null;
        this.baseUrl=String(config?.url??process.env.TMR_URL??'').trim().replace(/\/+$/,'');
        if(!this.baseUrl){
            throw new Error('TMR_URL no configurada.');
        }
        const url=new URL(this.baseUrl);
        if(url.protocol!=='https:'){
            throw new Error('La conexion TMR requiere HTTPS.');
        }
    }

    async authenticate(){
        const response=await request(
            this.baseUrl,
            '/api/auth/login',
            null,
            {
                user:this.config.user,
                password:this.config.password
            }
        );
        const data=response?.data??response;
        this.token=data?.accessToken??data?.access_token??data?.token??null;
        if(!this.token||typeof this.token!=='string'){
            throw new Error('TMR no devolvio un accessToken valido.');
        }
        console.log('TMR_AUTENTICACION: OK');
        return true;
    }

    ensureAuthenticated(){
        if(!this.token){
            throw new Error('TMR no esta autenticado.');
        }
    }

    async get(path){
        this.ensureAuthenticated();
        const raw=await request(this.baseUrl,path,this.token);
        if(raw===null||raw===undefined){
            throw new Error(`TMR devolvio una respuesta vacia: ${path}`);
        }
        return raw;
    }

    unwrap(raw){
        return raw?.data??raw;
    }

    getList(raw){
        const data=this.unwrap(raw);
        if(Array.isArray(data))return data;
        const items=list(data);
        if(!Array.isArray(items)){
            throw new Error('La respuesta TMR no contiene una lista valida.');
        }
        return items;
    }

    validateId(id,nombre='registro'){
        const value=Number(id);
        if(!Number.isSafeInteger(value)||value<=0){
            throw new Error(`ID de ${nombre} TMR invalido.`);
        }
        return value;
    }

    async getUsers(){
        const all=[];
        const pageSize=100;
        const maxPages=1000;
        const ids=new Set();

        for(let page=1;page<=maxPages;page++){
            const raw=await this.get(
                `/api/configuracion/usuarios/?pagenumber=${page}&pagesize=${pageSize}`
            );
            const data=this.unwrap(raw);
            const items=this.getList(raw);

            for(const item of items){
                const id=item?.idusuario??item?.idUsuario??item?.id??null;
                if(id!==null){
                    const key=String(id);
                    if(ids.has(key)){
                        throw new Error(`TMR devolvio un usuario duplicado: ${key}`);
                    }
                    ids.add(key);
                }
                all.push(item);
            }

            const pagination=data?.pagination??data?.meta?.pagination??raw?.meta?.pagination??{};
            const totalPages=
                data?.totalpages??
                data?.totalPages??
                pagination?.totalPages??
                pagination?.totalpages??
                raw?.totalPages??
                raw?.totalpages;

            const totalRecords=
                data?.totalCount??
                data?.totalcount??
                data?.totalRecords??
                pagination?.totalCount??
                pagination?.totalRecords??
                null;

            if(totalPages!==null&&totalPages!==undefined){
                const pages=Number(totalPages);
                if(!Number.isSafeInteger(pages)||pages<1){
                    throw new Error('TMR devolvio totalPages invalido.');
                }
                if(page>=pages){
                    if(totalRecords!=null&&all.length!==Number(totalRecords)){
                        throw new Error('El total de usuarios TMR no coincide con la paginacion.');
                    }
                    console.log('TMR_USUARIOS_CONSULTADOS '+all.length);
                    return all;
                }
            }else if(items.length<pageSize){
                if(totalRecords!=null&&all.length!==Number(totalRecords)){
                    throw new Error('La consulta de usuarios TMR esta incompleta.');
                }
                console.log('TMR_USUARIOS_CONSULTADOS '+all.length);
                return all;
            }

            if(items.length===0){
                throw new Error('TMR devolvio una pagina vacia antes de completar la paginacion.');
            }
        }
        throw new Error('Paginacion de usuarios TMR incompleta.');
    }

    async getUser(id){
        const userId=this.validateId(id,'usuario');
        const raw=await this.get(`/api/configuracion/usuarios/${userId}`);
        return this.unwrap(raw);
    }

    async getEmployees(params={}){
        const query=new URLSearchParams();
        if(params.busqueda!=null)query.set('busqueda',String(params.busqueda));
        if(params.activo!=null)query.set('activo',String(params.activo));
        if(params.asignacion!=null)query.set('asignacion',String(params.asignacion));
        const suffix=query.toString()?`?${query.toString()}`:'';
        const raw=await this.get(`/api/colaboradores/${suffix}`);
        const items=this.getList(raw);
        console.log('TMR_COLABORADORES_CONSULTADOS '+items.length);
        return items;
    }

    async getEmployee(id){
        const employeeId=this.validateId(id,'colaborador');
        const raw=await this.get(`/api/colaboradores/${employeeId}`);
        return this.unwrap(raw);
    }

    async getLeaders(params={}){
        const query=new URLSearchParams();
        if(params.activo!=null)query.set('activo',String(params.activo));
        const suffix=query.toString()?`?${query.toString()}`:'';
        const raw=await this.get(`/api/lideres/${suffix}`);
        const items=this.getList(raw);
        console.log('TMR_LIDERES_CONSULTADOS '+items.length);
        return items;
    }

    async getLeader(id){
        const leaderId=this.validateId(id,'lider');
        const raw=await this.get(`/api/lideres/${leaderId}`);
        return this.unwrap(raw);
    }

    async getLeaderLookup(){
        return this.getList(await this.get('/api/lideres/lookup'));
    }

    async getLeaderCounters(){
        return this.unwrap(await this.get('/api/lideres/contadores'));
    }

    async getLeaderTypes(){
        return this.getList(await this.get('/api/lideres/tipos'));
    }

    async getAvailableLeaderPersons(){
        return this.getList(await this.get('/api/lideres/personas-disponibles'));
    }

    async getNonLeaderPersons(){
        return this.getList(await this.get('/api/lideres/personasNoLideres'));
    }

    async getProjects(){
        const items=this.getList(await this.get('/api/proyectos/'));
        console.log('TMR_PROYECTOS_CONSULTADOS '+items.length);
        return items;
    }

    async getProject(id){
        const projectId=this.validateId(id,'proyecto');
        return this.unwrap(await this.get(`/api/proyectos/${projectId}`));
    }

    async getProjectLookups(){
        return this.unwrap(await this.get('/api/proyectos/lookups'));
    }

    async getRoles(){
        const items=this.getList(await this.get('/api/configuracion/roles/'));
        console.log('TMR_ROLES_CONSULTADOS '+items.length);
        return items;
    }

    async getRole(id){
        const roleId=this.validateId(id,'rol');
        return this.unwrap(await this.get(`/api/configuracion/roles/${roleId}`));
    }

    async getRoleModules(){
        return this.getList(await this.get('/api/configuracion/roles/modulos'));
    }

    async getEmployeePositions(idDepartamento){
        const id=this.validateId(idDepartamento,'departamento');
        return this.getList(
            await this.get(`/api/colaboradores/cargos?idDepartamento=${id}`)
        );
    }

    async getEmployeeCatalog(code){
        const codigo=String(code??'').trim().toUpperCase();
        if(!/^[A-Z0-9_]{2,10}$/.test(codigo)){
            throw new Error('Codigo de catalogo TMR invalido.');
        }
        return this.getList(
            await this.get(`/api/colaboradores/catalogos/${codigo}`)
        );
    }

    async diagnoseEndpoints(){
        this.ensureAuthenticated();

        const endpoints={
            usuarios:()=>this.getUsers(),
            lideres:()=>this.getLeaders(),
            colaboradores:()=>this.getEmployees(),
            proyectos:()=>this.getProjects(),
            roles:()=>this.getRoles()
        };

        const results={};

        for(const [name,execute] of Object.entries(endpoints)){
            try{
                const items=await execute();
                results[name]={
                    status:'OK',
                    total:items.length,
                    fields:items.length>0?Object.keys(items[0]??{}):[]
                };
            }catch(error){
                results[name]={
                    status:'ERROR',
                    message:error.message
                };
            }
        }

        const successful=Object.values(results).filter(
            item=>item.status==='OK'
        ).length;

        const summary={
            backend:this.baseUrl,
            authenticated:true,
            endpointsChecked:Object.keys(results).length,
            endpointsSuccessful:successful,
            endpointsFailed:Object.keys(results).length-successful,
            results
        };

        console.log('DIAGNOSTICO_ENDPOINTS_TMR '+JSON.stringify(summary));
        return summary;
    }
}
