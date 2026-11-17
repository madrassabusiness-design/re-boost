<?php
// POST api/saspay-webhook.php — notifications envoyées par SasPay
// À enregistrer dans le tableau de bord SasPay > Développeur > Webhooks
// (événement : transaction.success).
require __DIR__ . '/boot.php';
require_method('POST');

$raw = file_get_contents('php://input') ?: '';
$signature = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
$timestamp = $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] ?? '';

if (!saspay_signature_valid($raw, $timestamp, $signature)) {
    fail('Signature invalide.', 401);
}

$payload = json_decode($raw, true) ?: [];
$event = (string) ($payload['event'] ?? ($_SERVER['HTTP_X_WEBHOOK_EVENT'] ?? ''));

if ($event === 'transaction.success') {
    // La notification ne contient pas notre numéro de commande :
    // on revérifie les commandes en attente auprès de SasPay.
    try {
        foreach (fs_pending_order_ids(20) as $orderId) {
            try {
                finalize_order($orderId);
            } catch (Throwable $e) {
                log_error($e);
            }
        }
    } catch (Throwable $e) {
        log_error($e);
        fail('Erreur temporaire.', 500); // SasPay renverra la notification
    }
}

json_response(['received' => true]);
