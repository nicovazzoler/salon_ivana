<#
Deja el backup andando solo. Se corre UNA vez, con botón derecho sobre el
archivo -> "Ejecutar con PowerShell".

Hace tres cosas:
  1. crea el archivo de configuración (fuera del repo, que es público),
  2. agenda la tarea diaria en el Programador de tareas de Windows,
  3. corre un backup de prueba para que no te enteres dentro de seis meses de
     que nunca funcionó.

    .\instalar_tarea.ps1                 # todos los días a las 22:30
    .\instalar_tarea.ps1 -Hora "01:00"   # a otra hora
#>
param(
    [string]$Hora = "22:30",
    [string]$NombreTarea = "Backup Salon Ivana"
)

$ErrorActionPreference = "Stop"

$Carpeta    = Join-Path $env:USERPROFILE ".salon_ivana"
$ConfigPath = Join-Path $Carpeta "config.txt"
$Script     = Join-Path $PSScriptRoot "backup_salon.ps1"

if (-not (Test-Path $Script)) { Write-Error "No encuentro backup_salon.ps1 al lado de este archivo."; exit 1 }
New-Item -ItemType Directory -Path $Carpeta -Force | Out-Null

# ---------- 1. configuración ----------

if (-not (Test-Path $ConfigPath)) {
    # Tanteo de dónde sincroniza Drive u OneDrive, para no hacerte buscar la ruta.
    $sugerida = "$env:USERPROFILE\Documentos\Backups Salon"
    foreach ($c in @("G:\Mi unidad", "G:\My Drive", "$env:USERPROFILE\Mi unidad",
                     "$env:USERPROFILE\Google Drive", $env:OneDrive)) {
        if ($c -and (Test-Path $c)) { $sugerida = Join-Path $c "Backups Salon"; break }
    }

    @(
        "# Configuración del backup de la peluquería."
        "# Este archivo NO va al repositorio: tiene la contraseña de la base."
        ""
        "# La URL PÚBLICA de Postgres en Railway. En Railway: servicio Postgres ->"
        "# pestaña Variables -> DATABASE_PUBLIC_URL. Ojo: NO sirve la que termina"
        "# en .railway.internal, esa solo funciona adentro de Railway."
        "DATABASE_URL=postgresql://usuario:contrasena@host:puerto/railway"
        ""
        "# Carpeta donde caen los backups. Poné una que sincronice con Google"
        "# Drive u OneDrive: así queda la copia en la PC y la de la nube juntas."
        "CARPETA_DESTINO=$sugerida"
        ""
        "# Cuántos días de backups conservar. Igual nunca borra los últimos 7."
        "DIAS_A_GUARDAR=30"
        ""
        "# Solo si pg_dump.exe no aparece solo, poné acá la ruta completa."
        "# PG_DUMP=C:\Program Files\PostgreSQL\17\bin\pg_dump.exe"
    ) | Set-Content -Path $ConfigPath -Encoding UTF8

    Write-Host ""
    Write-Host "Se creó $ConfigPath" -ForegroundColor Yellow
    Write-Host "Se abre ahora: completá DATABASE_URL y CARPETA_DESTINO, guardá y cerrá." -ForegroundColor Yellow
    Start-Process notepad.exe $ConfigPath -Wait
} else {
    Write-Host "Ya existe $ConfigPath, se deja como está."
}

# ---------- 2. la tarea ----------

$accion = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""

$disparador = New-ScheduledTaskTrigger -Daily -At $Hora

# StartWhenAvailable es la opción que importa: si a las 22:30 la PC estaba
# apagada, el backup corre igual la próxima vez que se prenda, en vez de saltear
# el día. Sin esto, una semana de vacaciones son siete días sin copia.
$opciones = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $NombreTarea -Action $accion -Trigger $disparador `
    -Settings $opciones -Description "Copia diaria de la base de la peluqueria a la nube." `
    -Force | Out-Null

Write-Host ""
Write-Host "Tarea '$NombreTarea' agendada todos los días a las $Hora." -ForegroundColor Green

# ---------- 3. probarla ahora ----------

Write-Host ""
Write-Host "Corriendo un backup de prueba..." -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Listo. El backup anda y queda corriendo solo." -ForegroundColor Green
    Write-Host "Cada tanto mirá el archivo _ULTIMO_BACKUP.txt en la carpeta de destino:" -ForegroundColor Green
    Write-Host "si esa fecha se quedó vieja, el backup dejó de correr." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "El backup de prueba falló. Revisá el mensaje de arriba y config.txt." -ForegroundColor Red
    Write-Host "La tarea igual quedó agendada: arreglá la config y volvé a correr backup_salon.ps1." -ForegroundColor Red
}
