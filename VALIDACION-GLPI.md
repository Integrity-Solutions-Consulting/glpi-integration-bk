# Validación de sesión GLPI 11

**Actualización:** se añadió el comando `transfer` para las altas completas por
API legacy, con diario persistente y verificación posterior. Ver
[TRANSFERENCIA.md](TRANSFERENCIA.md). Los resultados siguientes documentan las
prevalidaciones anteriores; no prueban que se hayan realizado altas.

Se consultan por HTTPS los endpoints reales `/api.php/v2.3/session` y
`/api.php/v2.3/Session/EntityTree`. Usuarios continúa usando
`/api.php/v2.3/Administration/User`. No se usan Inventory/Agent ni Project
para identificar usuarios o comprobar permisos.

La autenticación automática conserva `POST /api.php/token` (OAuth password).
Las rutas authorize y swagger-oauth-redirect corresponden al flujo interactivo;
no son necesarias para esta integración automática.

## Resultado real del 12 de noviembre de 2026

- Autenticación y consultas de sesión y árbol satisfactorias.
- Usuario de integración ID 7, perfil activo ID 9, entidad activa ID 0.
- Identidad contrastada contra Administration/User y catálogos de perfiles y entidades.
- `active_profile.rights.user = 7`: incluye el bit CREATE (4).
- Entidades activas y árbol: solo ID 0; sesión no recursiva.
- Se leyeron 6 usuarios visibles. No existe un total declarado en esa respuesta.
- No se ejecutaron escrituras de usuarios.

El perfil predeterminado no demuestra el perfil efectivo. La validación usa los
campos activos de la sesión. Un derecho ausente o de tipo desconocido devuelve
`null`; un derecho válido sin CREATE devuelve `false`.

La cobertura global y el contrato de creación permanecen sin verificar. Ver una
entidad raíz no demuestra acceso a todas las entidades. Por eso el inventario
global permanece incompleto y el transporte bloquea POST de usuarios incluso
si un llamador entrega indicadores booleanos positivos. No hay una variable de
entorno que quite ese bloqueo. Se requiere completar esas verificaciones antes
de habilitar la creación.

## Repetir la prevalidación completa

Con las credenciales configuradas en `.env`:

```sh
docker compose run --rm --build -e SYNC_MODE=PREVALIDACION -e GLPI_ENABLE_PILOT_WRITE=false -e SYNC_ENABLED=false -e SYNC_DRY_RUN=true revision
```

Revisar `GLPI_CONTEXTO_SESION`, `DIAGNOSTICO_PERMISOS_GLPI` y
`DIAGNOSTICO_COBERTURA_ENTIDADES_GLPI`. El registro de contexto usa una lista
explícita de campos de diagnóstico; no vuelca tokens, nombres personales ni la
respuesta de sesión completa. La ejecución completa también consulta TMR;
la comprobación realizada en esta revisión se limitó a GLPI.

Las pruebas unitarias ejercitan los validadores y bloqueos sin hacer peticiones
de red ni sustituir las respuestas de producción. Ejecutar `npm test`.

## Referencias de implementación

- [API de GLPI y autenticación OAuth](https://help.glpi-project.org/documentation/modules/configuration/general/api/restful-api-v2)
- [Esquemas y endpoints de sesión de GLPI 11](https://github.com/glpi-project/glpi/blob/11.0/bugfixes/src/Glpi/Api/HL/Controller/CoreController.php)
- [Máscaras de permisos: CREATE = 4](https://glpi-developer-documentation.readthedocs.io/en/latest/devapi/acl.html)

## Validación conjunta TMR → GLPI

Se ejecutó el flujo completo en PREVALIDACION el 12 de noviembre de 2026,
con ambas autenticaciones reales y cero intentos de escritura. Resultados:

| Comprobación | Resultado |
| --- | --- |
| Usuarios TMR | 189 |
| Usuarios GLPI visibles, con detalles consultados | 6 |
| Endpoints TMR consultados satisfactoriamente | 5 de 5 |
| Candidatos según identidad visible | 183 |
| Candidatos tras aplicar reglas del plan | 182 |
| Identidades incompletas | 6 |
| Revisión adicional por condición de líder | 1 |
| Vinculaciones cargadas | 0 |
| Usuarios creados/modificados | 0 |

El reporte local `validacion-integracion.json` contiene los IDs conciliados y
los motivos de revisión, sin nombres, correos ni credenciales. Está excluido de Git.
`CONCILIACION_TMR_GLPI` identifica la etapa de comparación de identidades;
`RESULTADO_PREVALIDACION` incluye además las reglas de perfiles y liderazgo.

La conciliación compara IDs de usuario y persona TMR, login, correos GLPI
anidados y cruces entre login y correo. El plan usa detalles GLPI, no solamente
el listado resumido. Las cuentas existentes sin vínculo verificado requieren
revisión; no se adoptan automáticamente. Un vínculo persistido y consistente
se reporta como `YA_VINCULADO`, sin volver a crear la cuenta. Un vínculo cuyo
destino desapareció o cambió de identidad requiere revisión.

El payload preparado incluye `nombres → firstname`, `apellidos → realname`,
login (o correo cuando no existe login explícito) → `username`, y correo →
`emails`. Perfil y entidad se resuelven contra los catálogos GLPI. La asignación
efectiva de permisos de la cuenta nueva requiere validar el contrato; un perfil
predeterminado por sí solo no demuestra esa asignación. No se copian contraseñas.

Esta validación conjunta no demuestra una transferencia ejecutada. Las altas
siguen bloqueadas por cobertura global y contrato pendientes, y las
actualizaciones permanecen deshabilitadas. Tampoco constituye una garantía
frente a procesos concurrentes: antes de habilitar escrituras se requiere
control de exclusión entre procesos y recuperación de altas cuyo resultado sea
incierto (por ejemplo, un timeout después de que GLPI haya creado la cuenta).
