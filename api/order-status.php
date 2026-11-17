<?php
// GET api/order-status.php?order=ID
// Vérifie le paiement auprès de SasPay et renvoie l'état de la commande.
require __DIR__ . '/boot.php';
require_method('GET');
rate_limit('status', 60, 60);

$orderId = (string) ($_GET['order'] ?? '');
if (!is_valid_order_id($orderId)) fail('Commande invalide.');

try {
    $order = finalize_order($orderId);
} catch (Throwable $e) {
    log_error($e);
    fail('Vérification momentanément impossible. Nouvel essai en cours…', 503);
}

if ($order === null) fail('Commande introuvable.', 404);

$response = [
    'status'   => $order['status'],          // pending | paid | expired | cancelled | failed | review
    'plan'     => $order['plan'],
    'planName' => $order['planName'] ?? $order['plan'],
];
if ($order['status'] === 'paid') {
    $response['licenseKey'] = $order['licenseKey'];
    $response['email'] = $order['customerEmail'];
    $response['name'] = $order['customerName'];
}

json_response($response);
