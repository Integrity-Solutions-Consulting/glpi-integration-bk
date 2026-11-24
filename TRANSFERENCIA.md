# Transferir usuarios TMR a GLPI

Estado de la comprobación real del 12 de noviembre de 2026: ambas cuentas
autentican en TMR y GLPI HL. La API legacy pasó de «API disabled» a
`ERROR_NOT_ALLOWED_IP`; falta autorizar el origen en su cliente de API. No se
ha ejecutado ningún POST de alta. Las 44 pruebas locales pasan y Docker Compose
valida su configuración, pero falta validar una creación real y su repetición.

El comando `transfer` consulta TMR, resuelve el plan de perfiles y crea las
cuentas nuevas en GLPI con login, nombres, apellidos, correo y asignación de
perfil en la entidad raíz. No modifica cuentas locales existentes ni copia
contraseñas TMR. El acceso con contraseña/SSO de los usuarios es una gestión
distinta del alta de sus datos.

Se conserva la API de alto nivel para catálogos GLPI. Las altas completas usan
la API REST legacy: el contrato v2.3 instalado no ofrece endpoints para guardar
correos de otros usuarios ni sus asignaciones de perfiles; incluir estas
relaciones en el JSON de User no prueba que se hayan guardado.

## Configuración necesaria en GLPI

1. Habilitar la API REST legacy y el acceso con credenciales.
2. Configurar un cliente legacy activo que autorice la IP de salida del equipo
   o contenedor ejecutor. Si exige App-Token, guardarlo en `.env` como
   `GLPI_LEGACY_APP_TOKEN`. Es distinto del secreto OAuth.
3. La cuenta de integración debe poder leer y crear usuarios, ver todas las
   entidades y asignar los perfiles del plan. El programa verifica estos
   permisos; no concede privilegios a la cuenta de integración.
4. Conservar `SYNC_DATA_DIR` en un almacenamiento persistente compartido por
   todos los procesos de esta integración. Por defecto es `./data` en local y
   `/app/data` en Docker Compose.

## Ejecutar

En local, `.env` se carga automáticamente:

```sh
# Plan y comprobaciones reales, sin altas
npm run transfer

# Primera alta controlada: como máximo un usuario del plan
npm run transfer -- --apply --max=1

# Procesar un usuario concreto
npm run transfer -- --apply --id=ID_TMR --max=1

# Transferir el resto de candidatos autorizados, máximo 200 altas
npm run transfer -- --apply --max=200
```

Con Docker, `transferencia` comparte el volumen de vinculaciones de `revision`:

```sh
docker compose run --rm --build transferencia
docker compose run --rm transferencia node src/transfer.mjs --apply --max=1
docker compose run --rm transferencia node src/transfer.mjs --apply --max=200
```

Para ejecución automática en Dokploy, despliega el servicio `automatizacion`.
Ejecuta usuarios, proyectos, perfiles, equipos y detalles de equipos cada
`SYNC_INTERVAL_MINUTES` minutos (5 por defecto) y se reinicia automáticamente
si el contenedor se detiene. Para pruebas, `SYNC_INTERVAL_SECONDS` tiene
prioridad sobre los minutos. Los límites se controlan con `SYNC_MAX_WRITES`,
`EQUIPMENT_MAX_WRITES` y `EQUIPMENT_DETAIL_MAX_WRITES`.

La limpieza de categorías (`equipment-category-cleanup`) no forma parte de la
automatización porque elimina activos de GLPI; debe ejecutarse manualmente y
con aprobación explícita.
El journal persistente evita duplicados entre ciclos.

`--apply` es el indicador explícito de escritura de este comando. No es
necesario cambiar los indicadores del antiguo piloto de `src/app.mjs`.
`npm start` conserva el diagnóstico anterior; para transferir usar `transfer`.

## Proyectos TMR para la tiquetera GLPI

La sincronización de proyectos usa el módulo `Project` de GLPI, conserva el
código TMR en el nombre y una marca técnica en el comentario, y mantiene un
journal independiente para no crear dos veces el mismo proyecto.

```sh
# Prevalidar proyectos y detectar duplicados, sin escribir
npm run project-transfer

# Crear y verificar los proyectos autorizados
npm run project-transfer -- --apply --max=200
```

La cuenta de integración debe tener en su perfil GLPI los derechos `Project`
de lectura y creación, además del alcance de la entidad raíz. Si falta lectura,
el proceso se detiene antes de cualquier POST con `GLPI_LEGACY_SIN_PERMISO_PROJECT_READ`.

## Duplicados y recuperación

- Compara IDs de usuario/persona TMR, login, correo y coincidencias cruzadas.
- Consulta cuentas activas, inactivas y eliminadas de GLPI; una coincidencia sin
  vínculo verificado se envía a revisión, sin crear ni adoptar otra cuenta.
- Antes del POST guarda un intento durable y una marca única. Tras el POST,
  verifica por GET el usuario, el correo y la relación Profile_User.
- Guarda `mappings.json` y `transfer-journal.json`. Una segunda ejecución
  reconoce las cuentas creadas y no vuelve a crearlas.
- Si el POST tiene resultado incierto, no lo reintenta. Solo recupera el vínculo
  cuando encuentra exactamente la cuenta con la marca del intento y todos sus
  datos verificados. Si el alta quedó incompleta, detiene el lote.
- `transfer.lock` impide dos escritores sobre el mismo directorio. Si queda
  tras una caída, comprobar que no hay otro proceso activo antes de retirarlo;
  conservar siempre el diario para resolver el último intento.

El informe `data/last-transfer-report.json` contiene IDs, acciones y motivos.
El diario contiene los datos necesarios para recuperar altas y debe mantenerse
privado. No se incluye en Git ni en la imagen Docker.

Las cuentas con identidad incompleta, líderes sin validar o perfiles que la
integración no puede asignar permanecen en revisión. No se cambia su perfil por
otro para forzar un alta. El bloqueo local no coordina aplicaciones externas que
escriban en GLPI: evitar importaciones simultáneas desde otras herramientas.

## Errores de configuración

| Código | Corrección |
| --- | --- |
| GLPI_LEGACY_DESHABILITADA | Habilitar y guardar la API legacy |
| ERROR_NOT_ALLOWED_IP | Autorizar IP de salida en un cliente legacy activo |
| ERROR_LOGIN_WITH_CREDENTIALS_DISABLED | Habilitar autenticación con credenciales |
| ERROR_APP_TOKEN_PARAMETERS_MISSING / ERROR_WRONG_APP_TOKEN_PARAMETER | Configurar el App-Token del cliente legacy |
| GLPI_LEGACY_COBERTURA_GLOBAL_NO_VERIFICADA | Revisar alcance de entidades de la cuenta |
| GLPI_PERFIL_NO_ASIGNABLE | Revisar los permisos para asignar ese perfil |
| INTENTO_PREVIO_NO_RESUELTO_NO_REINTENTAR | Revisar el intento persistido antes de cualquier nueva alta |

Referencias: [API legacy de GLPI](https://github.com/glpi-project/glpi/blob/11.0/bugfixes/apirest.md),
[creación y correos de User](https://github.com/glpi-project/glpi/blob/11.0/bugfixes/src/User.php),
[limitación de relaciones de la API HL](https://github.com/glpi-project/glpi/blob/11.0/bugfixes/src/Glpi/Api/HL/ResourceAccessor.php).
