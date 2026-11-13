
import {sameId} from '../utils/normalize.mjs';

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

function getTMREmail(user){
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

function getTMRLogin(user){
    if(!user||typeof user!=='object'){
        return '';
    }

    return normalize(firstText(
        user.login,
        user.usuario,
        user.nombreUsuario,
        user.username,
        user.userName,
        user.nombreusuario,
        user.name
    ));
}

function isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getGLPILogin(user){
    if(!user||typeof user!=='object'){
        return '';
    }

    return normalize(firstText(
        user.username,
        user.name,
        user.login
    ));
}

function getGLPIEmails(user){
    const result=new Set();

    if(!user||typeof user!=='object'){
        return result;
    }

    const values=[
        user.email,
        user.correo,
        user.mail,
        user.useremails,
        user.emails
    ];

    for(const value of values){
        const items=Array.isArray(value)
            ?value
            :[value];

        for(const item of items){
            const email=normalize(
                typeof item==='string'
                    ?item
                    :item?.email??
                        item?.mail
            );

            if(isValidEmail(email)){
                result.add(email);
            }
        }
    }

    return result;
}

export function findEmployeeMatches(user,employees){
    if(
        !user||
        !Array.isArray(employees)||
        user.idPersona==null
    ){
        return [];
    }

    return employees.filter(employee=>
        employee!=null&&
        sameId(
            employee.idPersona,
            user.idPersona
        )&&
        employee.activo===true
    );
}

export function findGLPICandidates(user,existing){
    if(
        !user||
        !Array.isArray(existing)
    ){
        return [];
    }

    const email=getTMREmail(user);
    const login=getTMRLogin(user);

    if(!email&&!login){
        return [];
    }

    return existing.filter(glpiUser=>{
        if(!glpiUser||typeof glpiUser!=='object'){
            return false;
        }

        const glpiLogin=getGLPILogin(glpiUser);
        const glpiEmails=getGLPIEmails(glpiUser);

        const sameLogin=Boolean(login)&&
            glpiLogin===login;

        const loginMatchesEmail=Boolean(email)&&
            glpiLogin===email;

        const sameEmail=Boolean(email)&&
            glpiEmails.has(email);

        return sameLogin||
            loginMatchesEmail||
            sameEmail;
    });
}

export function hasDuplicateEmail(user,users){
    if(
        !user||
        !Array.isArray(users)
    ){
        return false;
    }

    const email=getTMREmail(user);

    if(!email){
        return false;
    }

    return users.filter(item=>
        getTMREmail(item)===email
    ).length>1;
}

export function findLeaderCandidates(user,leaders){
    if(
        !user||
        !Array.isArray(leaders)
    ){
        return [];
    }

    const email=getTMREmail(user);

    if(!email){
        return [];
    }

    return leaders.filter(leader=>{
        if(!leader||typeof leader!=='object'){
            return false;
        }

        const leaderEmails=[
            leader.email,
            leader.emailCorporativo,
            leader.correo,
            leader.correoElectronico,
            leader.correo_electronico,
            leader.emailUsuario,
            leader.emailAddress,
            leader.mail
        ].map(normalize);

        return leaderEmails.includes(email);
    });
}
