<?php
// =============================================================
//  RE-BOOST — configuration du serveur de paiement (modèle)
//  Copiez ce fichier en « config.php » et remplissez les valeurs.
//  config.php contient des SECRETS : ne le publiez jamais (il est
//  exclu de Git et bloqué par api/.htaccess).
// =============================================================

return [
    // --- SasPay (tableau de bord SasPay > Développeur) ----------
    'saspay' => [
        'api_base'       => 'https://api.saspay.me/api/v1',
        'secret_key'     => 'sk_live_VOTRE_CLE_SECRETE',      // clé API avec le scope PAYIN ou BOTH
        'webhook_secret' => 'VOTRE_SIGNING_SECRET_WEBHOOK',   // affiché une seule fois à la création du webhook
        'country'        => 'CD',                             // pays présélectionné sur la page de paiement
    ],

    // Le prix et la devise sont dans api/settings.php (fichier public, sans secret)

    // --- Firebase ------------------------------------------------
    'firebase' => [
        'project_id'           => 'reboost-cd96c',
        // Clé du compte de service : Console Firebase > Paramètres du projet >
        // Comptes de service > « Générer une nouvelle clé privée »
        'service_account_file' => __DIR__ . '/private/service-account.json',
        'firestore_base'       => 'https://firestore.googleapis.com/v1',
        'token_url'            => 'https://oauth2.googleapis.com/token',
    ],

    // Secret servant à fabriquer les clés de licence (longue chaîne aléatoire)
    'license_secret' => 'REMPLACEZ_PAR_UNE_LONGUE_CHAINE_ALEATOIRE',

    // Adresse publique du site, ex. 'https://www.mondomaine.com'
    // Laisser vide pour la détecter automatiquement.
    'site_url' => '',

    // Dossier privé (cache du jeton Google, limites anti-abus)
    'storage_dir' => __DIR__ . '/private',
];
