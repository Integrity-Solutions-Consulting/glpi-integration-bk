
import {validDate} from '../utils/dates.mjs';
import {normalizeId,sameId} from '../utils/normalize.mjs';

export function getSupportContext(projects,code,today){
    if(!Array.isArray(projects)){
        throw new Error('Listado de proyectos TMR invalido.');
    }

    const matches=projects.filter(p=>p.codigo===code);

    if(matches.length!==1){
        throw new Error('Proyecto de soporte inexistente o ambiguo.');
    }

    const project=matches[0];
    const projectActive=project.activo===true;

    const resources=projectActive?[
        ...(project.recursos??[]),
        ...(project.lideres??[]).flatMap(l=>l.recursos??[])
    ]:[];

    const activeResources=resources.filter(resource=>
        resource.estadoAsignacion===true&&
        validDate(resource.entrada,today,true)&&
        validDate(resource.salida,today,false)
    );

    const supportIds=new Set(
        activeResources
            .filter(resource=>resource.idEmpleado!=null)
            .map(resource=>normalizeId(resource.idEmpleado))
    );

    const leaderIds=projectActive?[
        project.idLider,
        ...(project.lideres??[]).map(l=>l.idLider)
    ].filter(id=>id!=null):[];

    return {
        project,
        resources,
        activeResources,
        supportIds,
        leaderIds
    };
}

export function isSupportEmployee(employeeMatches,context){
    if(!Array.isArray(employeeMatches)){
        return false;
    }

    return employeeMatches.some(employee=>
        employee?.id!=null&&
        context.supportIds.has(normalizeId(employee.id))
    );
}

export function getSupportLeaders(leaders,context){
    if(!Array.isArray(leaders)){
        return [];
    }

    return leaders.filter(leader=>
        leader.activo===true&&
        context.leaderIds.some(id=>sameId(id,leader.id))
    );
}