
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';

const PROTECTED_GLPI_IDS=new Set(['1','2','3','4','5','6','7']);

const PROTECTED_LOGINS=new Set([
    'glpi',
    'glpi-system',
    'tmr-sync',
    'post-only',
    'tech',
    'normal'
]);

function validId(value){
    if(value===null||value===undefined){
        return null;
    }

    const id=String(value).trim();

    return /^[1-9]\d*$/.test(id)?id:null;
}

function validEntityId(value){
    return /^(0|[1-9]\d*)$/.test(String(value??'').trim());
}

function normalize(value){
    return String(value??'').trim().toLowerCase();
}

function validEmail(value){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(value));
}

function validateMapping(item){
    if(!item||typeof item!=='object'||Array.isArray(item)){
        throw new Error('Vinculacion invalida.');
    }

    const tmrUserId=validId(item.tmrUserId);
    const personaId=validId(item.personaId);
    const glpiUserId=validId(item.glpiUserId);
    const login=normalize(item.login);
    const email=normalize(item.email);

    if(!tmrUserId||!personaId||!glpiUserId){
        throw new Error('Vinculacion con IDs invalidos.');
    }

    if(PROTECTED_GLPI_IDS.has(glpiUserId)){
        throw new Error('Vinculacion con usuario GLPI protegido.');
    }

    if(!login||PROTECTED_LOGINS.has(login)){
        throw new Error('Login de vinculacion invalido o protegido.');
    }

    if(!validEmail(email)){
        throw new Error('Correo de vinculacion invalido.');
    }

    if(item.verified!==true){
        throw new Error('Vinculacion sin verificar.');
    }

    return {
        tmrUserId,
        personaId,
        glpiUserId,
        login,
        email,
        verified:true,
        createdAt:item.createdAt??null,
        updatedAt:item.updatedAt??null
    };
}

export class MappingService{
    constructor(path='/app/data/mappings.json'){
        this.path=path;
        this.mappings=new Map();
        this.loaded=false;
    }

    async load(){
        if(this.loaded){
            return this;
        }

        let data;

        try{
            const content=await readFile(this.path,'utf8');
            data=JSON.parse(content);
        }catch(error){
            if(error.code!=='ENOENT'){
                throw error;
            }

            data={
                version:1,
                mappings:[]
            };
        }

        if(
            !data||
            data.version!==1||
            !Array.isArray(data.mappings)
        ){
            throw new Error('Archivo de vinculaciones invalido.');
        }

        const mappings=new Map();
        const usedGLPI=new Set();
        const usedPersonas=new Set();

        for(const item of data.mappings){
            const mapping=validateMapping(item);

            if(
                mappings.has(mapping.tmrUserId)||
                usedGLPI.has(mapping.glpiUserId)||
                usedPersonas.has(mapping.personaId)
            ){
                throw new Error('Vinculacion duplicada.');
            }

            mappings.set(mapping.tmrUserId,mapping);
            usedGLPI.add(mapping.glpiUserId);
            usedPersonas.add(mapping.personaId);
        }

        this.mappings=mappings;
        this.loaded=true;

        console.log('MAPPINGS_CARGADOS '+JSON.stringify({
            total:this.mappings.size,
            filtroPiloto:false
        }));

        return this;
    }

    ensureLoaded(){
        if(!this.loaded){
            throw new Error('MappingService no inicializado.');
        }
    }

    getByTMR(tmrUserId){
        this.ensureLoaded();

        const id=validId(tmrUserId);

        return id?this.mappings.get(id)??null:null;
    }

    getByGLPI(glpiUserId){
        this.ensureLoaded();

        const id=validId(glpiUserId);

        if(!id){
            return null;
        }

        for(const mapping of this.mappings.values()){
            if(mapping.glpiUserId===id){
                return {...mapping};
            }
        }

        return null;
    }

    getByPersona(personaId){
        this.ensureLoaded();

        const id=validId(personaId);

        if(!id){
            return null;
        }

        for(const mapping of this.mappings.values()){
            if(mapping.personaId===id){
                return {...mapping};
            }
        }

        return null;
    }

    getAll(){
        this.ensureLoaded();

        return [...this.mappings.values()].map(mapping=>({
            ...mapping
        }));
    }

    async save(){
        this.ensureLoaded();

        const directory=dirname(this.path);

        await mkdir(directory,{
            recursive:true,
            mode:0o700
        });

        const data={
            version:1,
            mappings:this.getAll()
        };

        const temp=join(
            directory,
            `.${basename(this.path)}.${randomUUID()}.tmp`
        );

        try{
            await writeFile(
                temp,
                JSON.stringify(data,null,2),
                {
                    encoding:'utf8',
                    mode:0o600,
                    flag:'wx'
                }
            );

            await rename(temp,this.path);
        }catch(error){
            await unlink(temp).catch(()=>{});
            throw error;
        }
    }

    async register({
        tmrUserId,
        personaId,
        glpiUserId,
        login,
        email,
        verified
    }){
        this.ensureLoaded();

        const tmrId=validId(tmrUserId);
        const personId=validId(personaId);
        const glpiId=validId(glpiUserId);
        const normalizedLogin=normalize(login);
        const normalizedEmail=normalize(email);

        if(!tmrId||!personId||!glpiId){
            throw new Error('IDs de vinculacion invalidos.');
        }

        if(PROTECTED_GLPI_IDS.has(glpiId)){
            throw new Error(
                'No se permite vincular usuarios GLPI protegidos.'
            );
        }

        if(verified!==true){
            throw new Error('Identidad no verificada.');
        }

        if(
            !normalizedLogin||
            PROTECTED_LOGINS.has(normalizedLogin)
        ){
            throw new Error('Login invalido o protegido.');
        }

        if(!validEmail(normalizedEmail)){
            throw new Error('Correo invalido.');
        }

        const existing=this.getByTMR(tmrId);
        const owner=this.getByGLPI(glpiId);
        const personaOwner=this.getByPersona(personId);

        if(existing&&existing.glpiUserId!==glpiId){
            throw new Error(
                'Usuario TMR ya vinculado a otro GLPI.'
            );
        }

        if(existing&&existing.personaId!==personId){
            throw new Error(
                'Persona TMR modificada: revision obligatoria.'
            );
        }

        if(owner&&owner.tmrUserId!==tmrId){
            throw new Error(
                'Usuario GLPI vinculado a otro TMR.'
            );
        }

        if(personaOwner&&personaOwner.tmrUserId!==tmrId){
            throw new Error(
                'Persona vinculada a otro usuario TMR.'
            );
        }

        if(existing&&(
            existing.login!==normalizedLogin||
            existing.email!==normalizedEmail
        )){
            throw new Error(
                'Identidad de vinculacion modificada: revision obligatoria.'
            );
        }

        if(existing){
            return {...existing};
        }

        const now=new Date().toISOString();

        const mapping=validateMapping({
            tmrUserId:tmrId,
            personaId:personId,
            glpiUserId:glpiId,
            login:normalizedLogin,
            email:normalizedEmail,
            verified:true,
            createdAt:now,
            updatedAt:now
        });

        this.mappings.set(tmrId,mapping);

        try{
            await this.save();
        }catch(error){
            this.mappings.delete(tmrId);
            throw error;
        }

        console.log('VINCULACION_REGISTRADA '+JSON.stringify({
            tmrUserId:tmrId,
            personaId:personId,
            glpiUserId:glpiId,
            verified:true
        }));

        return {...mapping};
    }
}
