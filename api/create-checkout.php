<?php
// POST api/create-checkout.php
// Corps JSON : { plan, name, email, phone?, uid }
// Crée la commande puis la session de paiement SasPay, et renvoie l'adresse de paiement.
require __DIR__ . '/boot.php';
require_method('POST');
rate_limit('checkout', 10, 600);

$in = read_json_body();
$planId = (string) ($in['plan'] ?? '');
$name   = trim((string) ($in['name'] ?? ''));
$email  = strtolower(trim((string) ($in['email'] ?? '')));
$phone  = preg_replace('/[\s.\-()]/', '', (string) ($in['phone'] ?? ''));
$uid    = (string) ($in['uid'] ?? '');

$plan = plans()[$planId] ?? null;
if ($plan === null)                                         fail('Formule inconnue.');
if ($name === '' || mb_strlen($name) > 100)                 fail('Indiquez votre nom complet.');
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 200) fail('Adresse email invalide.');
if ($phone !== '' && !preg_match('/^\+?\d{8,15}$/', $phone)) fail('Numéro de téléphone invalide.');
if (!preg_match('/^[A-Za-z0-9]{10,128}$/', $uid))           fail('Session invalide. Rechargez la page.');

$orderId  = new_order_id();
$amount   = money($plan['price']);
$currency = cfg()['currency'];

try {
    fs_create('orders', $orderId, [
        'orderId'       => $orderId,
        'plan'          => $planId,
        'planName'      => $plan['name'],
        'months'        => (int) $plan['months'],
        'amount'        => $amount,
        'currency'      => $currency,
        'customerName'  => $name,
        'customerEmail' => $email,
        'customerPhone' => $phone !== '' ? $phone : null,
        'uid'           => $uid,
        'status'        => 'pending',
        'sessionId'     => null,
        'checkoutUrl'   => null,
        'licenseKey'    => null,
        'createdAt'     => new FsTimestamp(time()),
    ]);
} catch (Throwable $e) {
    log_error($e);
    fail('Service momentanément indisponible. Réessayez plus tard.', 503);
}

try {
    $body = [
        'amount'         => $amount,
        'currency'       => $currency,
        'description'    => 'RE-BOOST — ' . $plan['name'] . ((int) $plan['months'] > 0 ? ' (' . $plan['months'] . ' mois)' : ''),
        'country'        => cfg()['saspay']['country'],
        'customer_email' => $email,
        'customer_name'  => $name,
        'return_url'     => site_url() . '/?commande=' . $orderId,
        'metadata'       => ['order_id' => $orderId, 'plan' => $planId],
    ];
    if ($phone !== '') {
        $body['customer_phone'] = $phone;
    }
    $session = saspay_request('POST', '/checkout-sessions/', $body);

    if (empty($session['id']) || empty($session['checkout_url'])) {
        throw new RuntimeException('Réponse SasPay incomplète : ' . json_encode($session));
    }

    fs_update('orders/' . $orderId, [
        'sessionId'   => (string) $session['id'],
        'checkoutUrl' => (string) $session['checkout_url'],
    ]);
} catch (Throwable $e) {
    log_error($e);
    try { fs_update('orders/' . $orderId, ['status' => 'failed', 'note' => mb_substr($e->getMessage(), 0, 300)]); } catch (Throwable $ignored) {}
    fail('Impossible de démarrer le paiement. Réessayez dans un instant.', 502);
}

json_response(['orderId' => $orderId, 'checkoutUrl' => (string) $session['checkout_url']]);
