# Usar Distributed Skills en tu empresa

Levantá un único servidor MCP, agregá las skills de tu empresa en una carpeta y
conectá los agentes de tus empleados a su URL. El login es opcional. Las skills
pueden estar agrupadas por equipo o área, con tantos niveles de carpetas como
necesites.

Esta guía usa HTTP para compartir un servidor entre empleados. Necesitás
Node.js 22 o superior, npm y una máquina con acceso desde los clientes que lo
van a usar. El proyecto tiene licencia MIT y se puede usar comercialmente.

## 1. Instalar

Cloná este repositorio y entrá en su carpeta (o descargalo desde GitHub y abrí
una terminal en la carpeta descargada):

```sh
git clone https://github.com/mehLabs/distributed-skills.git
cd distributed-skills
npm ci
npm run build
```

Los siguientes comandos se ejecutan desde esa misma carpeta. El proyecto se
instala desde el repositorio; no requiere un paquete publicado en npm.

## 2. Agregar las skills de la empresa

Usá la carpeta `skills/` incluida en el repositorio o una carpeta propia. Cada
skill debe tener su propio directorio con un archivo llamado **`SKILL.md`**,
respetando las mayúsculas.

```text
skills/
└── empresa/
    ├── ingenieria/
    │   └── revision-codigo/
    │       ├── SKILL.md
    │       └── references/
    │           └── checklist.md
    └── soporte/
        └── respuesta-incidente/
            ├── SKILL.md
            └── assets/
                └── plantilla.md
```

Las carpetas de agrupación, como `empresa/` o `ingenieria/`, no necesitan un
`SKILL.md`. El MCP busca skills **recursivamente**, incluyendo las que estén
dentro de otras skills. Los ejemplos que ya vienen en `skills/` también se
publican si usás esa carpeta.

Para crear la primera skill, guardá este contenido en
`skills/empresa/ingenieria/revision-codigo/SKILL.md`:

```markdown
---
name: revision-codigo
description: Revisar cambios de código cuando el usuario pide evaluar un parche o una pull request.
---

Revisá los cambios buscando errores de comportamiento y regresiones.
Explicá cada problema con un ejemplo concreto y su impacto.
Si no encontrás problemas, indicá qué verificaste y qué quedó pendiente.
```

Los dos campos iniciales son obligatorios:

| Campo | Qué poner |
| --- | --- |
| `name` | Un nombre de 1 a 64 caracteres con letras minúsculas sin acentos, números y guiones. Usá el mismo nombre que la carpeta de la skill. Sin guiones iniciales, finales ni consecutivos. |
| `description` | Cuándo debe usarla el agente. Entre 1 y 1024 caracteres. |

Debajo del encabezado van las instrucciones. Podés escribirlas en el idioma
que prefieras. Para agregar material de apoyo, colocá archivos en la carpeta
de la skill y referencialos desde las instrucciones, por ejemplo:

```markdown
Antes de finalizar la revisión, leé [el checklist](references/checklist.md).
```

El ID de esta skill será `empresa/ingenieria/revision-codigo`. El agente usa
ese ID para leer las instrucciones y sus archivos. Dos áreas pueden tener
skills con el mismo nombre si sus rutas son distintas.

Todos los archivos dentro de una skill pueden ser leídos por los usuarios con
acceso al catálogo: guardá ahí solo material que quieras compartir. Los archivos
tienen un límite de 1 MiB cada uno. Los enlaces simbólicos y las carpetas
`.git`, `node_modules` y `.cache` se excluyen. El MCP entrega archivos; los
scripts que incluyas no se ejecutan en el servidor.

Validá la carpeta antes de levantar el servidor:

```sh
node dist/cli.js --skills-dir ./skills --check
```

La salida lista las skills y sus `diagnostics`. Si una skill tiene un encabezado
inválido, corregí el archivo indicado; el comando termina con código 1 cuando
hay diagnósticos. Una carpeta vacía es válida.

## 3. Levantar el MCP sin login

Copiá [skills-mcp.config.example.json](../skills-mcp.config.example.json) a
`skills-mcp.config.json` en la raíz del repositorio. Su contenido es:

```json
{
  "authentication": {
    "enabled": false
  }
}
```

Levantá el servidor:

```sh
node dist/cli.js --transport http --config ./skills-mcp.config.json --skills-dir ./skills --port 3000
```

La URL local es **`http://127.0.0.1:3000/mcp`**. Dejá el proceso en ejecución;
podés detenerlo con `Ctrl+C`. Con `enabled: false`, cualquier cliente que pueda
acceder al servidor y pase las restricciones de Host puede leer las skills.

### Compartirlo con otras máquinas

Para atender conexiones desde otras máquinas, cambiá el host y permití el
nombre con el que los clientes o el proxy accederán al servidor:

```sh
node dist/cli.js --transport http --config ./skills-mcp.config.json --skills-dir ./skills --host 0.0.0.0 --port 3000 --allowed-hosts skills.example.org,localhost,127.0.0.1
```

Reemplazá `skills.example.org` por el dominio de tu empresa. Si los empleados
acceden directamente por una IP, agregá también esa IP a `--allowed-hosts`.
Esta opción recibe nombres o IPs separados por comas, sin protocolo ni puerto.

Publicá el servicio con la infraestructura habitual de tu empresa: un servicio
que mantenga el proceso activo y, para acceso remoto, un proxy con HTTPS. Con
ese dominio, los empleados se conectarán a **`https://skills.example.org/mcp`**.
El comando anterior inicia el servidor HTTP; el dominio, el certificado HTTPS
y el proxy se configuran en tu infraestructura.

## 4. Configurar el login, si lo necesitás

Para habilitarlo, reemplazá el contenido de `skills-mcp.config.json` por el de
[examples/config/auth.enabled.json](../examples/config/auth.enabled.json) y
completá las URLs de tu proveedor OAuth:

```json
{
  "authentication": {
    "enabled": true,
    "resourceUrl": "https://skills.example.org/mcp",
    "issuerUrl": "https://identity.example.org",
    "loginUrl": "https://identity.example.org/login",
    "validationUrl": "https://identity.example.org/oauth/introspect",
    "scopes": ["skills:read"],
    "validationClientIdEnv": "SKILLS_AUTH_CLIENT_ID",
    "validationClientSecretEnv": "SKILLS_AUTH_CLIENT_SECRET",
    "timeoutMs": 5000
  }
}
```

| Opción | Valor que necesitás |
| --- | --- |
| `resourceUrl` | URL pública de este MCP. También debe ser la audiencia del token. |
| `issuerUrl` | Identificador del proveedor OAuth que emite los tokens. |
| `loginUrl` | Página donde el empleado puede iniciar sesión u obtener credenciales. |
| `validationUrl` | Endpoint de introspección que verifica los tokens. |
| `scopes` | Permisos necesarios para leer las skills. Usá `[]` si no exigís scopes. |
| `validationClientIdEnv` / `validationClientSecretEnv` | Nombres de las variables que contienen las credenciales del servidor para consultar la introspección. |

Las URLs van en el JSON; las credenciales van en variables de entorno. Con
los nombres del ejemplo, configurá estas dos variables en el proceso del MCP:

Linux/macOS, en bash:

```sh
export SKILLS_AUTH_CLIENT_ID='id-del-cliente-de-introspeccion'
export SKILLS_AUTH_CLIENT_SECRET='secreto-del-cliente-de-introspeccion'
```

Windows, en PowerShell:

```powershell
$env:SKILLS_AUTH_CLIENT_ID = 'id-del-cliente-de-introspeccion'
$env:SKILLS_AUTH_CLIENT_SECRET = 'secreto-del-cliente-de-introspeccion'
```

Para un despliegue permanente, inyectá esos valores mediante el servicio o el
gestor de secretos que levanta el MCP. El servidor **no carga archivos `.env`
automáticamente**. Estas credenciales pertenecen al servidor: cada empleado
obtiene su propio access token al iniciar sesión desde su cliente MCP.

Reiniciá el servidor con el mismo comando de la sección anterior. El agente
puede consultar `get_auth_info` sin credenciales para descubrir el login.
El cliente MCP gestiona la sesión y envía el token en las lecturas de skills;
los empleados no necesitan pasar sus credenciales al agente por chat.

El proveedor OAuth debe ofrecer un flujo compatible con el cliente MCP y una
introspección que devuelva `active`, `iss`, `aud`, `exp` y los scopes requeridos.
El MCP usa ese proveedor existente para el login y la emisión de tokens.
La [documentación de autenticación](authentication.md) describe el contrato
completo, la configuración del proveedor y los endpoints que debe exponer el
proxy: `/mcp`, `/auth` y los metadatos OAuth anunciados por el servidor.

Para desactivar el login, cambiá únicamente `enabled` a `false` y reiniciá.
Podés conservar las URLs y retirar las variables de credenciales. Todos los
usuarios autorizados comparten el mismo catálogo; no hay filtros por empleado.

## 5. Conectar los agentes de los empleados

En cada herramienta que soporte MCP por **Streamable HTTP**, agregá un servidor
con estos datos:

| Dato | Valor |
| --- | --- |
| Nombre | `distributed-skills` o el nombre que prefieras. |
| Transporte | Streamable HTTP. |
| URL | `https://skills.example.org/mcp`, reemplazando el dominio. Para una prueba en la misma máquina: `http://127.0.0.1:3000/mcp`. |
| Autenticación | Sin credenciales cuando está desactivada; flujo OAuth del cliente cuando está activada. |

La ubicación y el formato de esta configuración dependen de la herramienta.
Para OAuth, usá un cliente con soporte de autenticación MCP. Los empleados
apuntan al mismo servidor; no necesitan instalar ni ejecutar el repositorio.

Para comprobar la conexión, pedile al agente:

> Consultá `get_auth_info` y después listá las skills disponibles con
> `list_skills`. Si hace falta, indicame cómo iniciar sesión desde el cliente.

Después puede buscar y leer una skill:

```text
search_skills({"query":"revision"})
get_skill({"id":"empresa/ingenieria/revision-codigo"})
```

### Consultar las skills al empezar una tarea

Si querés una instrucción reutilizable para empleados, copiá la carpeta
[examples/discover-shared-skills](../examples/discover-shared-skills) a la
ubicación de skills que soporte su herramienta. También podés agregar esta
instrucción persistente en el cliente:

> Antes de empezar una tarea de trabajo, consultá el MCP distributed-skills,
> descubrí si requiere login y leé las skills aplicables antes de actuar.

La conexión MCP se configura por separado. La selección automática de skills
depende del agente y su herramienta; leer instrucciones remotas no las instala
como skills locales.

## 6. Actualizar y comprobar el servicio

Agregá, editá o quitá carpetas y archivos dentro de la raíz de skills. Los cambios
se ven en la siguiente consulta, **sin reiniciar el MCP**. Si movés una skill,
su ID cambia. Para usar otra raíz, cambiá `--skills-dir` y reiniciá.

Podés indicar una carpeta fuera del repositorio para mantener las skills
internas por separado, por ejemplo:

```sh
node dist/cli.js --transport http --config ./skills-mcp.config.json --skills-dir /srv/company-skills
```

En Windows, usá una ruta como `C:/Company/Skills`. Si contiene espacios, ponela
entre comillas. También podés definir la variable `SKILLS_DIR`; `--skills-dir`
tiene prioridad. Para el archivo de configuración existe `SKILLS_MCP_CONFIG`;
`--config` tiene prioridad. Las rutas relativas se resuelven desde la carpeta
de trabajo del proceso.

Para comprobar el proceso y la información pública de login desde la máquina
del servidor:

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/auth
```

En Windows podés usar `curl.exe`. `/health` responde `{"status":"ok"}`;
`/auth` indica si el login está habilitado y cómo hacerlo. Para comprobar el
contenido de las skills, ejecutá `--check` con su carpeta o consultá
`list_skills` desde un cliente MCP. El endpoint `/mcp` usa el protocolo MCP;
abrirlo como una página web no comprueba que la conexión funcione.

## Resolver problemas frecuentes

| Problema | Qué revisar |
| --- | --- |
| No aparece una skill | Archivo llamado exactamente `SKILL.md`, encabezado con `name` y `description` válidos, carpeta dentro de la raíz servida. Ejecutá `--check` para ver diagnósticos. |
| No se puede leer la configuración | Verificá la ruta de `--config` y que el archivo sea JSON válido. Un archivo seleccionado explícitamente debe existir. |
| No conecta desde otra máquina | Dirección de escucha `--host`, puerto, firewall, proxy y dominio. `127.0.0.1` solo acepta conexiones locales. |
| HTTP 401 al leer skills | Iniciá sesión en el cliente. Si ya lo hiciste, revisá que el token no esté vencido y que su issuer y audiencia coincidan con el JSON. |
| HTTP 403 por Host u Origin | Permití el hostname enviado por el cliente o proxy. Para clientes de navegador, revisá `SKILLS_MCP_ALLOWED_ORIGINS` y la configuración CORS del gateway, como explica el [README](../README.md#share-one-http-server). |
| HTTP 403 por scopes | El token debe incluir todos los scopes configurados. |
| HTTP 503 al validar credenciales | Revisá la disponibilidad y respuesta de `validationUrl`, el timeout y las credenciales de introspección del servidor. |
| Error de credenciales al arrancar | Configurá ambas variables nombradas en `validationClientIdEnv` y `validationClientSecretEnv` en el entorno del proceso. |

Para otros modos de conexión, herramientas disponibles y detalles del catálogo,
consultá el [README](../README.md). Para integrar el proveedor de identidad,
consultá [Autenticación](authentication.md).
