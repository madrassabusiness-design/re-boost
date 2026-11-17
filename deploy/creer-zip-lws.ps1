# =============================================================
#  RE-BOOST — création du fichier zip à envoyer sur LWS (méthode manuelle)
#  Résultat : dist\reboost-lws.zip, à extraire dans « htdocs » sur LWS.
#  (Avec le déploiement automatique GitHub, ce zip n'est plus nécessaire.)
#
#  Utilisation : clic droit sur ce fichier > « Exécuter avec PowerShell »
#  ATTENTION : le zip contient vos clés secrètes (SasPay, Firebase).
#  Ne l'envoyez à personne et ne le publiez pas.
# =============================================================

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$zipPath = Join-Path $dist 'reboost-lws.zip'

# --- Vérification des secrets ---------------------------------
$config = Join-Path $root 'api\config.php'
$serviceAccount = Join-Path $root 'api\private\service-account.json'
if (-not (Test-Path $config)) { throw "api\config.php est introuvable." }
if ((Get-Content $config -Raw -Encoding UTF8) -match 'VOTRE_CLE_SECRETE|VOTRE_SIGNING_SECRET|REMPLACEZ_PAR') {
    throw "api\config.php contient encore des valeurs à remplacer (clé SasPay, secret du webhook…)."
}
if (-not (Test-Path $serviceAccount)) { throw "api\private\service-account.json est introuvable." }

# --- Liste des fichiers (deploy\fichiers-lws.txt + secrets) ---
$files = @()
foreach ($line in Get-Content (Join-Path $PSScriptRoot 'fichiers-lws.txt') -Encoding UTF8) {
    $entry = $line.Trim()
    if ($entry -eq '' -or $entry.StartsWith('#')) { continue }
    $path = Join-Path $root ($entry -replace '/', '\')
    if ($entry.EndsWith('/')) {
        $files += Get-ChildItem $path -File -Recurse | ForEach-Object { $_.FullName.Substring($root.Length + 1) }
    } else {
        $files += ($entry -replace '/', '\')
    }
}
$files += 'api\config.php', 'api\private\service-account.json'

# --- Création du zip -----------------------------------------
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $files) {
        $source = Join-Path $root $relative
        if (-not (Test-Path $source)) { throw "Fichier manquant : $relative" }
        $entryName = $relative -replace '\\', '/'   # chemins Linux pour LWS
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $source, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        Write-Host "  + $entryName"
    }
} finally {
    $zip.Dispose()
}

$size = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host ""
Write-Host "Zip créé : $zipPath ($size Mo, $($files.Count) fichiers)" -ForegroundColor Green
Write-Host "Envoyez-le dans « htdocs » sur LWS puis extrayez-le." -ForegroundColor Cyan
