
import {mail} from '../utils/normalize.mjs';
import {
    findEmployeeMatches,
    findGLPICandidates,
    hasDuplicateEmail,
    findLeaderCandidates
} from './identity.service.mjs';
import {
    getSupportContext,
    isSupportEmployee,
    getSupportLeaders
} from './support.service.mjs';

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

function isValidEmail(value){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getLogin(user,email){
    const explicitLogin=normalize(firstText(
        user.login,
        user.usuario,
        user.nombreUsuario,
        user.username,
        user.userName,
        user.nombreusuario,
        user.name
    ));

    if(explicitLogin){
        return explicitLogin;
    }

    return isValidEmail(email)?email:'';
}

export function propose(
    users,
    employees,
    leaders,
    projects,
    existing,
    code,
    today
){
    const context=getSupportContext(
        projects,
        code,
        today
    );

    const supportLeaders=getSupportLeaders(
        leaders,
        context
    );

    return users.map(user=>{
        const id=user.idUsuario??user.id;
        const email=normalize(mail(user.email));
        const login=getLogin(user,email);

        const candidates=findGLPICandidates(
            user,
            existing
        );

        const duplicates=hasDuplicateEmail(
            user,
            users
        );

        const employeeMatches=findEmployeeMatches(
            user,
            employees
        );

        const leaderMatches=findLeaderCandidates(
            user,
            supportLeaders
        );

        const isSupport=isSupportEmployee(
            employeeMatches,
            context
        );

        let propuesta;

        if(
            !isValidEmail(email)||
            duplicates||
            candidates.length>1
        ){
            propuesta='REVISAR_IDENTIDAD';
        }else if(candidates.length>0){
            propuesta='REVISAR_CUENTA_EXISTENTE_NO_MODIFICAR';
        }else if(user.activo!==true){
            propuesta='OMITIR_INACTIVO';
        }else if(leaderMatches.length>0){
            propuesta='REVISAR_LIDER_POR_CORREO';
        }else if(isSupport){
            propuesta='SOPORTE_PROPUESTO';
        }else{
            propuesta='AUTOSERVICIO_PROPUESTO';
        }

        return {
            tmrUserId:id,
            personaId:user.idPersona??null,
            login,
            email,
            estado:user.activo===true
                ?'activo'
                :'inactivo',
            coincidenciasGLPI:candidates.map(g=>g.id),
            propuesta,
            liderVerificado:false,
            lideresCandidatos:leaderMatches.map(l=>l.id),
            proyectoSoporteId:context.project.id
        };
    });
}
