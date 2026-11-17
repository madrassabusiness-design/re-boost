# =============================================================
#  RE-BOOST Admin — installation sur le bureau Windows
#  Crée un raccourci « RE-BOOST Admin » (Bureau + menu Démarrer)
#  qui ouvre l'application d'administration dans sa propre fenêtre.
#
#  Utilisation : clic droit sur ce fichier > « Exécuter avec PowerShell »
# =============================================================

$AppUrl  = 'https://reboost-cd96c.web.app'
$AppName = 'RE-BOOST Admin'

# Navigateur : Chrome de préférence, sinon Edge
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
    Write-Host "Chrome ou Edge introuvable : installez Google Chrome puis relancez ce script." -ForegroundColor Red
    exit 1
}

# Icône copiée dans un dossier stable
$installDir = Join-Path $env:LOCALAPPDATA 'RE-BOOST Admin'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$icon = Join-Path $installDir 'reboost-admin.ico'
Copy-Item -Path (Join-Path $PSScriptRoot 'reboost-admin.ico') -Destination $icon -Force

# Raccourcis
$shell = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"),
    (Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk")
)
foreach ($path in $targets) {
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $browser
    $lnk.Arguments = "--app=$AppUrl --window-size=1360,860"
    $lnk.IconLocation = "$icon,0"
    $lnk.Description = 'Gestion des licences et des paiements RE-BOOST'
    $lnk.WorkingDirectory = Split-Path $browser
    $lnk.Save()
    Write-Host "Raccourci créé : $path" -ForegroundColor Green
}

Write-Host ""
Write-Host "Installation terminée. Double-cliquez sur « $AppName » sur votre bureau." -ForegroundColor Cyan
