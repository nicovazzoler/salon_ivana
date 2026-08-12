# Salón Ivana — Sistema de gestión para comercios

Aplicación web full-stack para la gestión diaria de una peluquería: facturación con cuenta corriente, clientes, agenda de turnos, caja, inventario, reportes y administración, con control de acceso por roles. **En producción y en uso diario real** desde una tablet en el local.

---

## 💡 El problema que resuelve

El comercio llevaba las ventas, los gastos, los turnos y el fiado de forma manual: cuadernos para escribir ventas, mensajes para anotar turnos y mucha memoria de los empleados jaja. Este sistema centraliza todo en una sola herramienta pensada para el día a día del local: cobra, agenda, registra deudas de clientes, cierra la caja con arqueo de efectivo y muestra la evolución del negocio en gráficos.

---

## 📸 Capturas

### Facturación
Catálogo navegable por categorías con buscador, dos precios visibles por ítem (efectivo / transferencia), descuentos, y las tres formas de cobro: efectivo, transferencia o mixto. También se puede dejar la venta a cuenta del cliente.

![Pantalla de Facturación](docs/facturacion.png)

### Cuenta corriente
Ficha del cliente con sus comprobantes, saldos pendientes y registro de pagos parciales. Desde acá se saldan las deudas.

![Cuenta corriente](docs/cuenta.png)

### Historial
Todos los comprobantes emitidos, con estado de pago y botón "Abonar" que abre directamente la deuda en la cuenta del cliente.

![Historial](docs/historial.png)

### Agenda
Turnos en vista día, semana o mes. La vista día combina el formulario de turnos con un panel de notas del día, lado a lado.

![Agenda semanal](docs/agenda.png)

### Caja
Cierre diario con ingresos y egresos por forma de pago, arqueo de efectivo con fondo inicial (con arrastre del último valor) y edición en línea de egresos.

![Pantalla de Caja](docs/caja.png)

### Reportes
Resumen por período, gráficos de evolución de los más vendidos, ingresos por forma de pago y deuda total de clientes. Exportación a Excel.

![Pantalla de Reportes](docs/reportes.png)

---

## ✨ Funcionalidades

- **Facturación** — Catálogo por categorías con buscador en vivo y agrupado por variantes (talles). Dos listas de precios (efectivo/transferencia), descuentos porcentuales, recargo por dificultad, pago mixto y venta a cuenta. Registro de egresos en la misma pantalla.
- **Clientes y cuenta corriente** — Alta y búsqueda de clientes con teléfono y alias de transferencia. Ficha con comprobantes, saldos pendientes y pagos parciales: cada cliente tiene su historial completo con lo que debe y lo que pagó.
- **Historial** — Listado completo de tickets y presupuestos con estado de pago, forma de pago original y acceso directo a saldar cada deuda.
- **Agenda** — Turnos con vista día / semana / mes (lunes a domingo), cancelación de turnos y notas diarias para recordatorios del local.
- **Caja** — Cierre diario con ingresos/egresos por forma de pago, arqueo de efectivo con fondo por día (con arrastre), y edición/anulación de movimientos sin salir de la pantalla.
- **Reportes** — Resumen por período, ranking de más vendidos, gráficos de evolución temporal, deuda total de clientes y exportación a Excel.
- **Inventario** — Control de stock con alertas de reposición y carga de entradas de mercadería.
- **Administración** — ABM de productos, categorías, precios, descuentos, formas de pago, alias, tipos de egreso y usuarios.

---

## 🛠️ Stack técnico

| Capa | Tecnologías |
|---|---|
| **Backend** | Python · FastAPI · SQLAlchemy (ORM) · Pydantic · Uvicorn (ASGI) |
| **Base de datos** | SQLite (desarrollo) · PostgreSQL (producción) |
| **Frontend** | HTML · CSS (tokens en capas) · JavaScript vanilla · Chart.js |
| **Autenticación** | Tokens firmados con HMAC (stateless) · hashing de contraseñas con PBKDF2 + salt |
| **Despliegue** | Railway (deploy automático desde GitHub) · variables de entorno para configuración |

---

## 🏗️ Arquitectura

Arquitectura **cliente-servidor desacoplada**: el backend expone una **API REST** que devuelve JSON, y el frontend (servido como archivos estáticos por el mismo servidor) consume esa API y renderiza la interfaz.

```
  Navegador (HTML + JS + Chart.js)
        │  HTTP / JSON  (fetch con token)
        ▼
  Uvicorn → FastAPI (main.py)
        ├── auth.py            (hashing + tokens firmados)
        ├── esquemas Pydantic  (validación de entrada/salida)
        └── SQLAlchemy (models.py) → SQLite / PostgreSQL
```

### Decisiones de diseño destacadas

- **Totales calculados en el servidor:** el frontend nunca envía precios; el backend los resuelve contra su propia base. La interfaz muestra, pero el servidor tiene la última palabra (evita manipulación desde el cliente).
- **Snapshot de precios:** cada línea de venta guarda el nombre y el precio del momento, no solo una referencia al ítem. Cambiar un precio hoy no altera el historial de ventas pasadas.
- **Una sola lista de precios como fuente de verdad:** el precio efectivo es el base; el de transferencia se deriva con un factor y redondeo, y el descuento vive a nivel comprobante. Un solo lugar para cambiar precios, sin inconsistencias.
- **Estado de deuda calculado, no almacenado:** el saldo de un comprobante se resuelve siempre a partir de sus pagos registrados. No hay un campo "deuda" que pueda quedar desincronizado.
- **Soft delete en cascada:** los ítems y comprobantes se marcan como inactivos en vez de borrarse; anular un comprobante anula también sus pagos asociados, para que la caja y los reportes cierren siempre.
- **Fondo de caja por día con arrastre:** cada día puede tener su propio fondo; si no lo tiene, hereda el del último día cargado, sin reescribir los anteriores.
- **Fechas en UTC, presentación en hora local:** la base guarda todo en UTC y la conversión a hora argentina se hace solo al mostrar. Los reportes y cierres de caja no se corren de día.
- **CSS con tokens en capas:** variables de diseño centralizadas (`tokens.css`) que alimentan base, layout y componentes. Cambiar el tema completo es tocar un solo archivo, y no hay ni un `!important` en el proyecto.
- **Autenticación stateless:** tokens firmados con HMAC que no requieren guardar sesión en el servidor (sobreviven a reinicios y escalan horizontalmente).

---

## 🚀 Correr en local

Requisitos: Python 3.10+

```bash
# 1. Crear y activar un entorno virtual ((opcional))
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS / Linux

# 2. Instalar dependencias
pip install -r requirements.txt

# 3. Levantar el servidor (al iniciar siembra catálogo y usuarios si la base está vacía)
uvicorn main:app --reload --port 8000

# 4. Abrir en el navegador
#    http://127.0.0.1:8000/login
```

### Usuarios iniciales

| Usuario | Contraseña | Rol |
|---|---|---|
| `dueno` | `dueno1234` | Acceso total |
| `empleado` | `empleado1234` | Facturación y agenda |

Para acceder desde otro dispositivo en la misma red (ej: una tablet), levantar con `--host 0.0.0.0` y entrar a `http://[IP-de-la-PC]:8000`.

---

## ⚙️ Variables de entorno (producción)

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión a PostgreSQL. Si no está definida, usa SQLite local. |
| `SECRET_KEY` | Clave secreta para firmar los tokens de sesión. **Obligatoria en producción.** |

---

## 📁 Estructura del proyecto

```
salon_ivana/
├── main.py            # API REST + rutas que sirven las pantallas
├── models.py          # Modelos ORM (tablas de la base de datos)
├── database.py        # Conexión y sesión (SQLite local / PostgreSQL prod)
├── auth.py            # Hashing de contraseñas y tokens firmados
├── seed_datos.py      # Siembra inicial (catálogo + usuarios)
├── config_extra.py    # Parámetros de negocio iniciales
├── catalogo.json      # Catálogo de ítems iniciales
├── requirements.txt   # Dependencias de Python
├── Procfile           # Comando de arranque para el despliegue
└── static/            # Frontend
    ├── facturar.html  # Facturación y cobro
    ├── clientes.html  # Listado y alta de clientes
    ├── cuenta.html    # Cuenta corriente del cliente
    ├── historial.html # Historial de comprobantes
    ├── agenda.html    # Turnos y notas diarias
    ├── caja.html      # Caja y arqueo
    ├── reportes.html  # Reportes y gráficos
    ├── inventario.html
    ├── admin.html
    ├── login.html
    ├── auth.js        # Lógica de sesión compartida
    └── css/           # tokens.css → base.css → layout.css → components.css → app.css
```

---

## 🗺️ Roadmap

Funcionalidades en evaluación / desarrollo:

- [ ] Impresión de tickets con impresora térmica Bluetooth (ESC/POS, 80mm).
- [ ] Envío de comprobantes con datos del cliente para contaduría.

---

## 👤 Sobre el proyecto y mi rol

Identifiqué la necesidad del comercio de mi amigo y diseñé el sistema a medida para sus preferencias. La app está en producción y se usa todos los días en el local; el dueño la prueba activamente y varias funcionalidades (como la agenda) surgieron de este ida y vuelta. Es mi primer proyecto de esta magnitud y estoy aprendiendo muchísimo mientras tanto.
