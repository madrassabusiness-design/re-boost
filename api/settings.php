<?php
// =============================================================
//  RE-BOOST — réglages publics du paiement (sans secret)
//  Ce fichier est sur GitHub : une modification ici (prix, devise…)
//  est mise en ligne automatiquement après un push.
//  Les secrets (clés SasPay, Firebase) sont dans config.php.
// =============================================================

return [
    // Devise et offre vendue. months = 0 : accès à vie (pas d'expiration)
    'currency' => 'CDF',
    'plans' => [
        'lifetime' => ['name' => 'Formation boostage réseaux sociaux — accès à vie', 'months' => 0, 'price' => '1000.00'],
    ],
];
