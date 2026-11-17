<?php
// Vérifie la version de PHP avant de charger le reste (syntaxe compatible avec les vieux PHP).
// Sur LWS : Panel > votre hébergement > « Configuration PHP » > choisir PHP 8.1 ou plus récent.
if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array('error' => 'Le serveur utilise PHP ' . PHP_VERSION . ' : activez PHP 8.1 ou plus récent dans le panel LWS.'));
    exit;
}
require __DIR__ . '/lib.php';
