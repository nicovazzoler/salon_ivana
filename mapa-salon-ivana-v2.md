# 🗺️ Salón Ivana V2 — Mapa del proyecto

Referencia para leer la estructura de una. Dos partes:

- **Parte A — Estructura de datos y API:** modelos (tablas), schemas Pydantic, todos los endpoints y las rutas del front. El "qué existe y cómo se conecta".
- **Parte B — Funciones por archivo:** inventario de funciones, archivo por archivo. El "dónde está cada cosa".

> Todo esto está reconstruido leyendo el repo. Un par de endpoints de ABM (descuentos y algunos `DELETE`) los deduje de los schemas + las llamadas del front; si alguno no coincide con tu `main.py` real, decímelo y lo corrijo. Al final de la Parte B te dejo un comando para regenerar el inventario exacto vos mismo.

---

## Índice

- [Parte A — Estructura de datos y API](#parte-a--estructura-de-datos-y-api)
  - [1. El flujo en una imagen](#1-el-flujo-en-una-imagen)
  - [2. Archivos del backend](#2-archivos-del-backend)
  - [3. Modelos / tablas (`models.py`)](#3-modelos--tablas-modelspy)
  - [4. Schemas Pydantic (`main.py`)](#4-schemas-pydantic-mainpy)
  - [5. Endpoints de la API](#5-endpoints-de-la-api)
  - [6. Rutas del frontend (páginas)](#6-rutas-del-frontend-páginas)
- [Parte B — Funciones por archivo](#parte-b--funciones-por-archivo)
  - [Backend](#backend)
  - [Frontend](#frontend)
  - [Regenerar el inventario exacto](#regenerar-el-inventario-exacto)

---

# Parte A — Estructura de datos y API

## 1. El flujo en una imagen

```
  Navegador (HTML + JS vanilla + Chart.js)
        │
        │  authFetch()  →  fetch con header  Authorization: Bearer <token>
        ▼
  Uvicorn → FastAPI (main.py)
        │
        ├── usuario_actual / solo_dueno   ← Depends() que validan el token (guardas)
        ├── schemas Pydantic (LineaIn, ComprobanteIn, …)  ← validan el body que entra
        ├── helpers (calcular_transfer, estado_comprobante, …)  ← lógica de negocio
        └── SQLAlchemy (models.py)  →  SQLite (local) / PostgreSQL (prod)
```

Regla de oro del proyecto: **el front muestra, el server decide.** El front nunca manda precios finales; manda `item_id` + cantidad y el backend resuelve el total contra su propia base.

---

## 2. Archivos del backend

| Archivo | Rol |
|---|---|
| `main.py` | La app FastAPI: schemas Pydantic + guardas de auth + helpers + **todos** los endpoints + rutas que sirven las páginas. |
| `models.py` | Modelos ORM (una clase = una tabla). También `fecha_hora_now_utc()` y `hora_argentina()`. |
| `database.py` | Crea el `engine` y `SessionLocal`. Elige SQLite o PostgreSQL según `DATABASE_URL`. Expone `get_db()`. |
| `auth.py` | Hashing de contraseñas (PBKDF2 + salt) y tokens firmados con HMAC (stateless). |
| `seed_datos.py` | Siembra inicial idempotente: catálogo, formas de pago, tipos de egreso, config y usuarios. |
| `config_extra.py` | Parámetros de negocio iniciales: `FORMAS_PAGO`, `TIPOS_EGRESO`, `EXTRA_DIFICULTAD`, `calcular_transfer`. |
| `catalogo.json` | Catálogo de ítems iniciales que lee `seed_datos.py`. |

---

## 3. Modelos / tablas (`models.py`)

Convención: PK = `id` salvo aviso. `activo` = borrado lógico (soft delete). Los snapshots guardan el valor **del momento** para no romper el histórico.

| Modelo | Tabla | Campos clave | Relaciones |
|---|---|---|---|
| `Item` | `items` | `categoria`(idx), `nombre`, `precio` (efectivo, fuente de verdad), `precio_transfer` (derivado), `es_producto`, `stock_actual`, `stock_minimo`, `activo` | — |
| `Venta` | `ventas` | `fecha`, `forma_pago`, `alias`, `cliente`, `peluquero`, `total` | → `VentaLinea` (cascade) |
| `VentaLinea` | `venta_lineas` | `venta_id`(FK), `item_id`(FK), `nombre`✱, `cantidad`, `precio_unit`✱, `dificultad`, `subtotal` | ← `Venta` |
| `Egreso` | `egresos` | `fecha`, `tipo`, `concepto`, `monto`, `forma_pago`, `notas` | — |
| `FormaPago` | `formas_pago` | `nombre`(unique), `activo` | — |
| `Usuario` | `usuarios` | `usuario`(unique), `salt`, `hash`, `rol` (`dueno`/`empleado`) | — |
| `TipoEgreso` | `tipos_egreso` | `nombre`(unique), `activo` | — |
| `Config` | `config` | `clave`(**PK**), `valor` | — |
| `FondoCaja` | `fondo_caja` | `fecha`(**PK**, `'YYYY-MM-DD'`), `monto` | — |
| `Alias` | `alias_transferencia` | `nombre`(unique), `activo` | — |
| `Cliente` | `clientes` | `nombre`(idx), `telefono`, `alias`, `notas`, `direccion`, `dni`, `activo`, `creado` | — |
| `Turno` | `turnos` | `fecha`(idx), `hora`, `cliente_id`(FK opcional), `cliente`, `servicio`, `peluquero`, `notas`, `activo` | — |
| `NotaDiaria` | `notas_diarias` | `fecha`(idx), `texto`, `creada`, `activo` | — |
| `MovimientoStock` | `movimientos_stock` | `item_id`(FK), `fecha`, `tipo`, `antes`, `despues`, `cambio`, `motivo`, `usuario` | — |
| `Comprobante` | `comprobantes` | `tipo` (`ticket`/`presupuesto`), `numero`, `fecha`, `cliente_id`(FK), `cliente_nombre`✱, `peluquero`, `total_lista`, `extra_dificultad`, `descuento_pct`, `descuento_nombre`✱, `forma_pago`✱, `mostrar_motivo`, `convertido_de`(FK a sí mismo), `activo` | → `Cliente`, → `ComprobanteLinea` (cascade) |
| `ComprobanteLinea` | `comprobante_lineas` | `comprobante_id`(FK), `item_id`(FK), `nombre`✱, `cantidad`, `precio_unit`✱ (transfer), `precio_efectivo`✱, `dificultad`, `subtotal` | ← `Comprobante` |
| `Pago` | `pagos` | `comprobante_id`(FK), `fecha`, `monto` (lo que entró), `saldado` (deuda que cubre), `forma_pago`, `alias`, `desc_aplicado` | → `Comprobante` |
| `Descuento` | `descuentos` | `nombre`, `porcentaje`, `mostrar_motivo`, `activo` | — |

✱ = **snapshot** (copia del valor al momento; no se recalcula si después cambia el catálogo).

**Dos familias de "venta":** `Venta`/`VentaLinea` es el modelo viejo/simple; `Comprobante`/`ComprobanteLinea`/`Pago` es el sistema nuevo (tickets, presupuestos, cuenta corriente, pagos parciales). La app opera hoy sobre comprobantes; las ventas siguen ahí para el histórico y algunos reportes.

**Deuda calculada, no guardada:** no hay campo "saldo" en `Comprobante`. El saldo se resuelve siempre sumando los `Pago` asociados (ver `estado_comprobante`).

---

## 4. Schemas Pydantic (`main.py`)

Validan lo que **entra** en el body. `X | None = None` = opcional.

| Schema | Campos | Se usa en |
|---|---|---|
| `LineaIn` | `item_id`, `cantidad=1`, `dificultad=False`, `precio_custom?` | crear/editar `Venta` |
| `VentaIn` | `forma_pago`, `alias?`, `cliente?`, `peluquero?`, `lineas[LineaIn]` | `POST/PUT /api/ventas` |
| `LineaCompIn` | `item_id`, `cantidad=1`, `dificultad=False`, `precio_custom?` | líneas de comprobante |
| `ComprobanteIn` | `tipo`, `cliente_id?`, `cliente_nombre?`, `peluquero?`, `forma_pago="efectivo"`, `descuento_pct=0`, `descuento_nombre?`, `mostrar_motivo=False`, `lineas[LineaCompIn]` | `POST /api/comprobantes` |
| `PagoIn` | `monto`, `forma_pago`, `alias?`, `saldado?` | registrar un pago |
| `ClienteIn` | `nombre`, `telefono?`, `alias?`, `notas?`, `direccion?`, `dni?` | alta de cliente |
| `ClienteEdit` | todos opcionales + `activo?` | editar cliente |
| `ItemIn` | `categoria`, `nombre`, `precio`, `es_producto=False` | alta de ítem |
| `ItemEdit` | `categoria?`, `nombre?`, `precio?`, `activo?` | editar ítem |
| `RenombrarCat` | `viejo`, `nuevo` | renombrar categoría |
| `DescuentoIn` | `nombre`, `porcentaje`, `mostrar_motivo=False` | alta descuento |
| `DescuentoEdit` | `nombre?`, `porcentaje?`, `mostrar_motivo?`, `activo?` | editar descuento |
| `EgresoIn` | `tipo`, `concepto?`, `monto`, `forma_pago?`, `notas?` | alta egreso |
| `EgresoEdit` | todos opcionales | editar egreso |
| `StockIn` | `stock_actual`, `stock_minimo=0` | ajustar stock |
| `LoginIn` | `usuario`, `password` | login |
| `UsuarioIn` | `usuario`, `password`, `rol="empleado"` | alta usuario |
| `UsuarioEdit` | `usuario?`, `password?`, `rol?` | editar usuario |
| `PasswordIn` | `nueva` | cambiar mi contraseña |
| `ExtraIn` | `valor` | setear extra por dificultad |
| `FondoIn` | `valor`, `fecha?` | setear fondo de caja |
| `FormaIn` / `NombreIn` | `nombre` | alta forma de pago / genérico (tipo egreso, alias) |
| `TurnoIn` | `fecha?`, `hora`, `cliente`, `cliente_id?`, `servicio`, `peluquero?`, `notas?` | alta/edición turno |
| `NotaIn` | `texto`, `fecha?` | alta nota diaria |

---

## 5. Endpoints de la API

Columna **Rol**: `login` = cualquier usuario logueado (`usuario_actual`); `dueño` = solo dueño (`solo_dueno`); `público` = sin token.

### Auth y sesión
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| POST | `/api/login` | público | Valida usuario/contraseña, devuelve token + rol. |
| GET | `/api/yo` | login | Devuelve el payload del usuario actual. |

### Usuarios
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/usuarios` | dueño | Lista usuarios (sin hash). |
| POST | `/api/usuarios` | dueño | Crea usuario. |
| PUT | `/api/usuarios/{uid}` | dueño | Edita usuario/rol/contraseña. |
| DELETE | `/api/usuarios/{uid}` | dueño | Borra usuario (no podés borrarte a vos mismo). |
| PUT | `/api/usuarios/password` | login | Cambia tu propia contraseña. |

### Catálogo (lectura)
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/categorias` | login | Categorías activas, ordenadas. |
| GET | `/api/items?categoria=` | login | Ítems de una categoría. |
| GET | `/api/items/all` | dueño | Todos los ítems (para Admin). |
| GET | `/api/catalogo` | login | Todo el catálogo activo de una (buscador + agrupado en Facturación). |

### Catálogo (ABM — Admin)
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| POST | `/api/items` | dueño | Crea ítem (calcula `precio_transfer`). |
| PUT | `/api/items/{item_id}` | dueño | Edita ítem (recalcula transfer si cambia el precio). |
| DELETE | `/api/items/{item_id}` | dueño | Baja lógica (`activo=False`). |
| PUT | `/api/categorias` | dueño | Renombra una categoría en masa. |

### Config
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/config` | login | Extra por dificultad + formas de pago + tipos de egreso + alias. |
| PUT | `/api/config/extra-dificultad` | dueño | Setea el recargo por dificultad. |
| PUT | `/api/config/fondo-caja` | dueño | Setea el fondo de caja de un día. |
| POST | `/api/admin/recalcular-transfer` | dueño | Recalcula `precio_transfer` de todo el catálogo. |

### Formas de pago / Tipos de egreso / Alias
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/formas` | login | Lista formas activas. |
| POST | `/api/formas` | dueño | Alta (reactiva si existía). |
| DELETE | `/api/formas/{forma_id}` | dueño | Baja lógica. |
| GET | `/api/tipos-egreso` | login | Lista tipos activos. |
| POST | `/api/tipos-egreso` | login | Alta (reactiva si existía). |
| DELETE | `/api/tipos-egreso/{tipo_id}` | dueño | Baja lógica. |
| GET | `/api/alias` | login | Lista alias activos. |
| POST | `/api/alias` | dueño | Alta (reactiva si existía). |
| DELETE | `/api/alias/{alias_id}` | dueño | Baja lógica. |

### Descuentos
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/descuentos` | login | Lista descuentos (usado por Facturación y Admin). |
| POST | `/api/descuentos` | dueño | Alta de descuento. |
| PUT | `/api/descuentos/{id}` | dueño | Edita descuento. |
| DELETE | `/api/descuentos/{id}` | dueño | Baja de descuento. |

*(el POST/PUT/DELETE de descuentos los deduje de `DescuentoIn`/`DescuentoEdit` + las llamadas de `admin.html` — verificá los nombres exactos en tu `main.py`.)*

### Clientes
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/clientes?q=` | login | Busca por nombre/teléfono. |
| POST | `/api/clientes` | login | Alta de cliente. |
| PUT | `/api/clientes/{id}` | login | Edita datos del cliente. |
| DELETE | `/api/clientes/{id}` | login | Baja lógica. |
| GET | `/api/clientes/{id}/cuenta` | login | Cuenta corriente: comprobantes + saldos + estado. |
| GET | `/api/clientes/{id}/proximo-turno` | login | Próximo turno del cliente. |
| GET | `/api/clientes/deudas` | login | Saldos pendientes por cliente (ranking de deudores). |

### Comprobantes y pagos
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/comprobantes?tipo=` | login | Lista tickets/presupuestos con su estado de pago. |
| GET | `/api/comprobantes/{id}` | login | Detalle completo + líneas + pagos + estado. |
| POST | `/api/comprobantes` | login | Crea ticket o presupuesto (ancla al precio transfer, descuenta stock). |
| POST | `/api/comprobantes/{id}/convertir` | login | Convierte un presupuesto en ticket. |
| POST | `/api/comprobantes/{id}/pagos` | login | Registra un pago (total o parcial). |
| DELETE | `/api/pagos/{pago_id}` | login | Anula un pago; el comprobante vuelve a quedar con saldo. |

### Ventas (modelo legacy)
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| POST | `/api/ventas` | login | Crea venta simple. |
| PUT | `/api/ventas/{id}` | login | Edita venta (revierte y re-aplica stock; el empleado solo del día). |
| DELETE | `/api/ventas/{id}` | login | Anula venta (devuelve stock). |
| GET | `/api/ventas/registro` | dueño | Registro de ventas con fecha formateada. |

### Egresos
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| POST | `/api/egresos` | login | Registra un egreso. |
| GET | `/api/egresos/dia` | login | Egresos de hoy. |
| PUT | `/api/egresos/{id}` | login | Edita egreso (empleado solo del día). |
| DELETE | `/api/egresos/{id}` | login | Anula egreso. |

### Caja y registro
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/caja/dia?fecha=` | login | Cierre de un día: ingresos/egresos por forma + arqueo de efectivo (fondo + esperado). |
| GET | `/api/caja/diario?dias=` | dueño | Serie de ingresos/egresos/neto por día. |
| GET | `/api/caja/semanal?semanas=` | dueño | Ídem por semana. |
| GET | `/api/registro?desde&hasta&dias` | dueño | Movimientos (pagos + egresos) del período. |

### Inventario
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/inventario` | dueño | Productos con stock y flag "reponer". |
| PUT | `/api/inventario/{item_id}` | dueño | Ajusta stock (loguea el movimiento). |
| GET | `/api/inventario/historial?item_id=` | dueño | Log de movimientos de stock. |

### Reportes
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/reportes/resumen` | dueño | Ingresos/egresos/neto/ventas + desglose por forma. |
| GET | `/api/reportes/top-items` | dueño | Ranking de más vendidos. |
| GET | `/api/reportes/por-categoria` | dueño | Total por categoría. |
| GET | `/api/reportes/deuda` | dueño | Foto de la deuda total de hoy. |
| GET | `/api/reportes/serie-items` | dueño | Serie temporal por ítem (gráfico de línea). |
| GET | `/api/reportes/serie-categorias` | dueño | Serie temporal por categoría. |
| GET | `/api/reportes/excel` | dueño | Descarga `.xlsx` de movimientos. |

### Turnos y notas (Agenda)
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/turnos?fecha=` (o `desde`/`hasta`) | login | Turnos de un día o rango, ordenados. |
| POST | `/api/turnos` | login | Agenda un turno. |
| PUT | `/api/turnos/{id}` | login | Edita turno. |
| DELETE | `/api/turnos/{id}` | login | Cancela turno (baja lógica). |
| GET | `/api/notas?fecha=` (o rango) | login | Notas del día / feed. |
| POST | `/api/notas` | login | Crea nota diaria. |
| DELETE | `/api/notas/{id}` | login | Borra nota (baja lógica). |

### Backup
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/api/backup` | dueño | Descarga un JSON con **toda** la base (catálogo, ventas, egresos, usuarios, config, etc.). |

---

## 6. Rutas del frontend (páginas)

Sirven los HTML estáticos. Definidas al final de `main.py` con `FileResponse`.

| Ruta | Archivo | Pantalla |
|---|---|---|
| `/login` | `login.html` | Ingreso |
| `/` y `/facturar` | `facturar.html` | Facturación y cobro |
| `/clientes` | `clientes.html` | Listado y alta de clientes |
| `/cuenta` | `cuenta.html` | Cuenta corriente de un cliente |
| `/historial` | `historial.html` | Historial de comprobantes |
| `/agenda` | `agenda.html` | Turnos + notas |
| `/caja` | `caja.html` | Caja y arqueo |
| `/reportes` | `reportes.html` | Reportes y gráficos |
| `/inventario` | `inventario.html` | Stock |
| `/admin` | `admin.html` | ABM general |
| `/static/*` | `static/` | Archivos estáticos (JS, CSS) |

Helpers de negocio que viven en `main.py` (no son endpoints, los usan los endpoints): `usuario_actual`, `solo_dueno`, `get_extra`, `calcular_transfer`, `get_fondo`, `get_fondo_dia`, `log_stock`, `siguiente_numero`, `_puede_modificar`, `forma_comprobante`, `estado_comprobante`, `_cliente_json`, `_venta_detalle`, `_pago_detalle`, `_rango_dia`, `_sv`, `_se`, `_ventana`, `_filtrar`, `_movimientos`, `_resolver_ventana`, `_buckets`, `_serie`, `migrar`.

---

# Parte B — Funciones por archivo

## Backend

### `main.py`
Además de los helpers listados arriba (`usuario_actual`, `solo_dueno`, `get_extra`, `calcular_transfer`, `get_fondo`, `get_fondo_dia`, `log_stock`, `siguiente_numero`, `_puede_modificar`, `forma_comprobante`, `estado_comprobante`, `_cliente_json`, `_venta_detalle`, `_pago_detalle`, `_rango_dia`, `_sv`, `_se`, `_ventana`, `_filtrar`, `_movimientos`, `_resolver_ventana`, `_buckets`, `_serie`, `migrar`), están **todas las funciones-endpoint** de la sección 5. Regla útil: si tiene `@app.<método>` arriba, es endpoint; si no, es helper interno.

### `models.py`
`fecha_hora_now_utc()`, `hora_argentina(dt)` + las 18 clases-modelo de la sección 3.

### `database.py`
`get_db()` (generador de sesión). Además crea a nivel módulo: `engine`, `SessionLocal`, `Base`.

### `auth.py`
`hash_password(password, salt)`, `nuevo_salt()`, `_firmar(data)`, `crear_token(usuario, rol)`, `verificar_token(token)`.

### `seed_datos.py`
`seed()`.

### `config_extra.py`
`calcular_transfer(...)` + constantes `FORMAS_PAGO`, `TIPOS_EGRESO`, `EXTRA_DIFICULTAD`.

## Frontend

### `static/auth.js` (compartido por todas las páginas)
`getToken()`, `getRol()`, `getUser()`, `logout()`, `authFetch(url, opts)`, `requireLogin()`, `requireDueno()`, `pintarNav()`, `titulo(str)`.

### `static/facturar.html` (la más grande)
`init()`, `precioBtn(it)`, `categorias()`, `renderCategorias()`, `abrirCategoria(cat)`, `abrirGrupo(base, arr)`, `parseNombre(nombre)`, `buscar(q)`, `agregar(it)`, `agregarItem()`, `renderTicket()`, `crearComprobante()`, `abrirCobro()`, `limpiar()`, `cargarEgresosHoy()`, `toast(m)` + helpers referenciados (`restaurarBorrador`, `totalEfectivoComp`, `ticketListo`, `disableBotones`, `mostrarBotones`, `ordenVar`).

### `static/agenda.html`
`mover(dir)`, `lunesDeSemana(d)`, `render()`, `renderDia()`, `renderSemana()`, `renderMes()`, `renderNotasDia()`, `ajustarAltoNotas()`, `cargarEnForm(t)`, `formBody()`, `limpiarForm()`, `agregarTurno()`, `agregarNota()`, `toast()` + utilidades de fecha (`parseISO`, `iso`, `cap`, `hoyStr`).

### `static/reportes.html`
`recargarTodo()`, `dibujarLinea(rootSel, data)`, `loadResumen(s)`, `loadGrafico(s)`, `loadReg(s)`, `loadDeuda()`, `pintarRanking()`, `descargarExcel()`, `qbase(s)` + wiring de filtros.

### `static/caja.html`
`cargarDia()`, `anularPagoCaja(id)`, `editarEgresoCaja(id)`, `guardarEgresoCaja(id)`, `cancelarEgresoCaja(id)`, `anularEgresoCaja(id)`, `money(n)`, `toast()`.

### `static/cuenta.html`
`cargar()`, `toast(m)`, `numTicket(n)`, `parseISO2(s)` + render de comprobantes/pagos.

### `static/admin.html`
`cargarCats()`, `filtrarItems()`, `cargarItems()`, `renderItems(items, mostrarCat)`, `cargarFormas()`, `cargarExtra()`, `cargarTipos()`, `cargarDescuentos()`, `toast()` + handlers de alta.

### `static/clientes.html` y `static/historial.html`
Siguen el mismo patrón (`cargar…()` + `render…()` + `toast()`). El inventario listado abajo te da los nombres exactos.

## Regenerar el inventario exacto

Mi Parte B es lo que pude leer; para tener la lista **exacta y siempre al día**, corré esto en la raíz del repo. Es la forma más confiable (y de paso, buen ejercicio de leer tu propio código):

**Funciones y clases de Python, archivo por archivo:**
```bash
grep -rnE "^(def |class |    def |async def )" *.py
```

**Endpoints (con su método y ruta):**
```bash
grep -rnE "@app\.(get|post|put|delete)" main.py
```

**Funciones de JavaScript en el front:**
```bash
grep -rnE "^(async )?function |^const [a-zA-Z]+ ?= ?(async )?\(" static/*.html static/*.js
```

Cada uno te devuelve `archivo:línea: definición`, así saltás directo con Ctrl-clic en VS Code.
