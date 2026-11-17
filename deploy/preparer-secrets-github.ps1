# =============================================================
#  RE-BOOST — aide pour créer les secrets GitHub du déploiement automatique
#  Copie chaque secret dans le presse-papier, l'un après l'autre.
#
#  1. Ouvrez https://github.com/madrassabusiness-design/re-boost/settings/secrets/actions
#  2. Clic droit sur ce fichier > « Exécuter avec PowerShell »
#  3. Pour chaque secret : « New repository secret », tapez le NOM affiché,
#     collez la valeur (Ctrl+V), puis « Add secret ».
# =============================================================

$root = Split-Path -Parent $PSScriptRoot

function Copy-Secret([string]$name, [string]$value, [string]$hint) {
    Set-Clipboard -Value $value
    Write-Host ""
    Write-Host "Secret : $name" -ForegroundColor Cyan
    Write-Host "  $hint"
    Write-Host "  -> Valeur copiée dans le presse-papier. Collez-la sur GitHub (Ctrl+V)." -ForegroundColor Green
    Read-Host "  Appuyez sur Entrée quand c'est fait"
}

$config = Join-Path $root 'api\config.php'
$serviceAccount = Join-Path $root 'api\private\service-account.json'
if (-not (Test-Path $config)) { Write-Host "api\config.php introuvable." -ForegroundColor Red; exit 1 }
if (-not (Test-Path $serviceAccount)) { Write-Host "api\private\service-account.json introuvable." -ForegroundColor Red; exit 1 }

Write-Host "Création des secrets GitHub pour le déploiement automatique" -ForegroundColor Yellow
Write-Host "Page : https://github.com/madrassabusiness-design/re-boost/settings/secrets/actions"

Copy-Secret 'LWS_API_CONFIG' (Get-Content $config -Raw -Encoding UTF8) 'Contenu de api\config.php (clés SasPay).'
Copy-Secret 'FIREBASE_SERVICE_ACCOUNT' (Get-Content $serviceAccount -Raw -Encoding UTF8) 'Contenu de la clé du compte de service Firebase.'

Set-Clipboard -Value ' '
Write-Host ""
Write-Host "Créez enfin ces 3 secrets avec vos identifiants FTP LWS" -ForegroundColor Yellow
Write-Host "(Panel LWS > votre hébergement > Accès FTP) :"
Write-Host "  LWS_FTP_SERVER    ex. ftp.votre-domaine.com"
Write-Host "  LWS_FTP_USERNAME  votre identifiant FTP"
Write-Host "  LWS_FTP_PASSWORD  votre mot de passe FTP"
Write-Host "Facultatif : LWS_FTP_DIR si le site n'est pas dans « htdocs/ »."
Write-Host ""
Write-Host "Presse-papier vidé. Terminé !" -ForegroundColor Green
Read-Host "Appuyez sur Entrée pour fermer"
