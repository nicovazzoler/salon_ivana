<#
Backup automático de la base de la peluquería, para correr en la PC con Windows.

Hace un pg_dump de la base de Railway y lo deja en una carpeta sincronizada con
Google Drive (o OneDrive). Con eso queda una copia en el disco y otra en la nube
de una sola pasada, y las dos afuera de Railway: los backups que hace Railway
viven adentro de Railway, así que si algún día se pierde esa cuenta se pierden
con ella. Esta es la copia que es tuya.

No se ejecuta a mano: lo agenda instalar_tarea.ps1 para que corra todas las
noches. Ver LEEME.md.

La URL de la base NO está acá: el repositorio es público y el dump tiene datos
de clientes (DNI, teléfono, dirección) y los hash de las contraseñas. La
configuración vive en %USERPROFILE%\.salon_ivana\config.txt, fuera del repo.
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ConfigPath = Join-Path $env:USERPROFILE ".salon_ivana\config.txt"

# ---------- configuración ----------

if (-not (Test-Path $ConfigPath)) {
    Write-Error "No existe $ConfigPath. Corré primero instalar_tarea.ps1."
    exit 1
}

$cfg = @{}
foreach ($linea in Get-Content $ConfigPath) {
    $l = $linea.Trim()
    if ($l -eq "" -or $l.StartsWith("#")) { continue }
    $i = $l.IndexOf("=")
    if ($i -gt 0) { $cfg[$l.Substring(0, $i).Trim()] = $l.Substring($i + 1).Trim() }
}

$UrlBase  = $cfg["DATABASE_URL"]
$Carpeta  = $cfg["CARPETA_DESTINO"]
$DiasGuardar = 30
if ($cfg["DIAS_A_GUARDAR"]) { $DiasGuardar = [int]$cfg["DIAS_A_GUARDAR"] }
# Nunca se borran los últimos N aunque sean viejos: si la PC estuvo un mes
# apagada, la limpieza por antigüedad se llevaría puesto el único backup que hay.
$MinimosAConservar = 7

if (-not $UrlBase)  { Write-Error "Falta DATABASE_URL en $ConfigPath"; exit 1 }
if (-not $Carpeta)  { Write-Error "Falta CARPETA_DESTINO en $ConfigPath"; exit 1 }
if (-not (Test-Path $Carpeta)) { New-Item -ItemType Directory -Path $Carpeta -Force | Out-Null }

$LogPath    = Join-Path $Carpeta "backup.log"
$MarcaOk    = Join-Path $Carpeta "_ULTIMO_BACKUP.txt"
$MarcaFallo = Join-Path $Carpeta "_FALLO_BACKUP.txt"

function Escribir($msg) {
    $t = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    "$t  $msg" | Tee-Object -FilePath $LogPath -Append
}

# Deja el aviso donde se ve: un archivo en la carpeta de Drive. Un backup que
# falla en silencio es peor que no tener backup, porque uno se queda tranquilo.
function Morir($msg) {
    Escribir "ERROR: $msg"
    @(
        "El backup automático viene fallando."
        ""
        "Último intento: $((Get-Date).ToString('dd/MM/yyyy HH:mm'))"
        "Motivo: $msg"
        ""
        "Mirá backup.log en esta misma carpeta."
    ) | Set-Content -Path $MarcaFallo -Encoding UTF8
    exit 1
}

# ---------- encontrar pg_dump ----------

$PgDump = $cfg["PG_DUMP"]
if (-not $PgDump) {
    $enPath = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
    if ($enPath) {
        $PgDump = $enPath.Source
    } else {
        # El instalador oficial de PostgreSQL deja todo acá. Se toma la versión
        # más alta: pg_dump puede con servidores más viejos que él, pero no al
        # revés, así que ante la duda conviene el más nuevo.
        $c = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
             Sort-Object { [int]($_.Directory.Parent.Name) } -Descending
        if ($c) { $PgDump = $c[0].FullName }
    }
}
if (-not $PgDump -or -not (Test-Path $PgDump)) {
    Morir "No encuentro pg_dump.exe. Instalá el cliente de PostgreSQL (ver LEEME.md) o poné la ruta en PG_DUMP dentro de config.txt."
}
$PgRestore = Join-Path (Split-Path $PgDump) "pg_restore.exe"

# ---------- el dump ----------

$sello   = (Get-Date).ToString("yyyyMMdd_HHmm")
$nombre  = "salon_ivana_$sello.dump"
# Se escribe primero en temporal: si Drive ve nacer un archivo a medio escribir,
# lo sube igual, y en la nube queda un backup roto que parece sano.
$temporal = Join-Path $env:TEMP $nombre
$destino  = Join-Path $Carpeta $nombre

Escribir "Arranca backup -> $destino"

try {
    # --format=custom es el que lee pg_restore y permite restaurar selectivo.
    # --no-owner y --no-privileges para que se pueda restaurar en cualquier
    # servidor sin que existan los mismos roles que en Railway.
    & $PgDump --dbname=$UrlBase --format=custom --no-owner --no-privileges --file=$temporal 2>&1 |
        ForEach-Object { Escribir "  pg_dump: $_" }
    if ($LASTEXITCODE -ne 0) { Morir "pg_dump terminó con código $LASTEXITCODE" }
} catch {
    Morir "pg_dump falló: $_"
}

if (-not (Test-Path $temporal)) { Morir "pg_dump no dejó ningún archivo" }

# ---------- verificar antes de darlo por bueno ----------

$tam = (Get-Item $temporal).Length
if ($tam -lt 5000) {
    Remove-Item $temporal -Force
    Morir "El dump salió de $tam bytes: está vacío o cortado."
}

# Que el archivo se pueda LEER, no solo que exista. Un dump corrupto pesa igual.
$tablas = 0
if (Test-Path $PgRestore) {
    $listado = & $PgRestore --list $temporal 2>&1
    if ($LASTEXITCODE -ne 0) {
        Remove-Item $temporal -Force
        Morir "pg_restore no puede leer el dump: está corrupto."
    }
    $tablas = ($listado | Select-String "TABLE DATA").Count
    if ($tablas -lt 10) {
        Remove-Item $temporal -Force
        Morir "El dump trae solo $tablas tablas con datos y la base tiene 20. Algo salió mal."
    }
}

Move-Item -Path $temporal -Destination $destino -Force
Escribir "OK: $([math]::Round($tam/1KB)) KB, $tablas tablas"

# ---------- limpieza ----------

$viejos = Get-ChildItem (Join-Path $Carpeta "salon_ivana_*.dump") | Sort-Object LastWriteTime -Descending
$limite = (Get-Date).AddDays(-$DiasGuardar)
$i = 0
foreach ($f in $viejos) {
    $i++
    if ($i -le $MinimosAConservar) { continue }
    if ($f.LastWriteTime -lt $limite) {
        Remove-Item $f.FullName -Force
        Escribir "  borrado por viejo: $($f.Name)"
    }
}

# ---------- marcas visibles ----------

if (Test-Path $MarcaFallo) { Remove-Item $MarcaFallo -Force }
$cuantos = (Get-ChildItem (Join-Path $Carpeta "salon_ivana_*.dump")).Count
@(
    "Último backup OK: $((Get-Date).ToString('dddd d/MM/yyyy HH:mm'))"
    "Archivo: $nombre"
    "Tamaño: $([math]::Round($tam/1KB)) KB"
    "Backups guardados en esta carpeta: $cuantos"
    ""
    "Si esta fecha tiene más de un par de días, el backup dejó de correr."
) | Set-Content -Path $MarcaOk -Encoding UTF8

# El log no crece para siempre.
if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 500KB) {
    Get-Content $LogPath -Tail 1000 | Set-Content "$LogPath.tmp" -Encoding UTF8
    Move-Item "$LogPath.tmp" $LogPath -Force
}

exit 0
