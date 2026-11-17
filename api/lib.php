<?php
// =============================================================
//  RE-BOOST — fonctions communes du serveur de paiement
//  - accès à Firestore (API REST + compte de service Google)
//  - appels à l'API SasPay
//  - création des commandes et des licences
// =============================================================

declare(strict_types=1);

// REBOOST_CONFIG (variable d'environnement) permet d'utiliser une autre configuration pour les tests
define('REBOOST_CONFIG_FILE', getenv('REBOOST_CONFIG') ?: __DIR__ . '/config.php');

if (!is_file(REBOOST_CONFIG_FILE)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Configuration manquante : copiez api/config.example.php en api/config.php.']);
    exit;
}

// Configuration = réglages publics (settings.php : prix, devise) + secrets (config.php)
function cfg(): array
{
    static $config = null;
    if ($config === null) {
        $settings = require __DIR__ . '/settings.php';
        $config = array_replace($settings, require REBOOST_CONFIG_FILE);
    }
    return $config;
}

// -------------------------------------------------------------
//  Réponses HTTP
// -------------------------------------------------------------
function json_response(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400): void
{
    json_response(['error' => $message], $status);
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function require_method(string $method): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== $method) {
        header('Allow: ' . $method);
        fail('Méthode non autorisée.', 405);
    }
}

// -------------------------------------------------------------
//  Requêtes HTTP sortantes (cURL)
// -------------------------------------------------------------
function http_request(string $method, string $url, array $headers = [], ?string $body = null): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        throw new RuntimeException('Erreur réseau : ' . $error);
    }
    $json = json_decode($raw, true);
    return ['status' => $status, 'json' => is_array($json) ? $json : null, 'raw' => $raw];
}

// -------------------------------------------------------------
//  Stockage privé (cache, limites anti-abus)
// -------------------------------------------------------------
function storage_path(string $name): string
{
    $dir = cfg()['storage_dir'];
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }
    return $dir . '/' . $name;
}

// Limite simple par adresse IP : $max requêtes par fenêtre de $seconds
function rate_limit(string $bucket, int $max, int $seconds): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $file = storage_path('ratelimit-' . $bucket . '-' . hash('sha256', $ip) . '.json');
    $now = time();
    $hits = is_file($file) ? (json_decode((string) file_get_contents($file), true) ?: []) : [];
    $hits = array_values(array_filter($hits, fn($t) => $t > $now - $seconds));
    if (count($hits) >= $max) {
        fail('Trop de tentatives. Réessayez dans quelques minutes.', 429);
    }
    $hits[] = $now;
    file_put_contents($file, json_encode($hits), LOCK_EX);
}

// -------------------------------------------------------------
//  Jeton d'accès Google (compte de service → Firestore)
// -------------------------------------------------------------
function b64url(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function google_access_token(): string
{
    $cacheFile = storage_path('google-token.json');
    if (is_file($cacheFile)) {
        $cached = json_decode((string) file_get_contents($cacheFile), true);
        if (is_array($cached) && ($cached['expires_at'] ?? 0) > time() + 60) {
            return $cached['access_token'];
        }
    }

    $saFile = cfg()['firebase']['service_account_file'];
    if (!is_file($saFile)) {
        throw new RuntimeException('Clé du compte de service Firebase introuvable (' . basename($saFile) . ').');
    }
    $sa = json_decode((string) file_get_contents($saFile), true);
    $tokenUrl = cfg()['firebase']['token_url'];

    $now = time();
    $header = b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $claims = b64url(json_encode([
        'iss'   => $sa['client_email'],
        'scope' => 'https://www.googleapis.com/auth/datastore',
        'aud'   => $tokenUrl,
        'iat'   => $now,
        'exp'   => $now + 3600,
    ]));
    $signature = '';
    if (!openssl_sign("$header.$claims", $signature, $sa['private_key'], OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('Signature du jeton Google impossible.');
    }
    $jwt = "$header.$claims." . b64url($signature);

    $res = http_request('POST', $tokenUrl, ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion'  => $jwt,
    ]));
    if ($res['status'] !== 200 || empty($res['json']['access_token'])) {
        throw new RuntimeException('Jeton Google refusé : ' . substr($res['raw'], 0, 300));
    }

    file_put_contents($cacheFile, json_encode([
        'access_token' => $res['json']['access_token'],
        'expires_at'   => $now + (int) ($res['json']['expires_in'] ?? 3600),
    ]), LOCK_EX);
    return $res['json']['access_token'];
}

// -------------------------------------------------------------
//  Firestore (API REST)
// -------------------------------------------------------------
final class FsTimestamp
{
    public function __construct(public int $unix) {}
}

function fs_documents_url(): string
{
    $fb = cfg()['firebase'];
    return rtrim($fb['firestore_base'], '/') . '/projects/' . rawurlencode($fb['project_id']) . '/databases/(default)/documents';
}

function fs_encode(mixed $v): array
{
    return match (true) {
        $v === null               => ['nullValue' => null],
        is_bool($v)               => ['booleanValue' => $v],
        is_int($v)                => ['integerValue' => (string) $v],
        is_float($v)              => ['doubleValue' => $v],
        $v instanceof FsTimestamp => ['timestampValue' => gmdate('Y-m-d\TH:i:s\Z', $v->unix)],
        is_array($v)              => ['mapValue' => ['fields' => (object) fs_fields($v)]],
        default                   => ['stringValue' => (string) $v],
    };
}

function fs_fields(array $data): array
{
    $fields = [];
    foreach ($data as $key => $value) {
        $fields[$key] = fs_encode($value);
    }
    return $fields;
}

function fs_decode(array $value): mixed
{
    if (array_key_exists('nullValue', $value))  return null;
    if (isset($value['booleanValue']))          return (bool) $value['booleanValue'];
    if (isset($value['integerValue']))          return (int) $value['integerValue'];
    if (isset($value['doubleValue']))           return (float) $value['doubleValue'];
    if (isset($value['timestampValue']))        return new FsTimestamp(strtotime($value['timestampValue']));
    if (isset($value['stringValue']))           return $value['stringValue'];
    if (isset($value['mapValue']))              return fs_decode_fields($value['mapValue']['fields'] ?? []);
    return null;
}

function fs_decode_fields(array $fields): array
{
    $out = [];
    foreach ($fields as $key => $value) {
        $out[$key] = fs_decode($value);
    }
    return $out;
}

function fs_headers(): array
{
    return ['Authorization: Bearer ' . google_access_token(), 'Content-Type: application/json'];
}

function fs_error(array $res): RuntimeException
{
    $msg = $res['json']['error']['message'] ?? substr($res['raw'], 0, 300);
    return new RuntimeException('Firestore (' . $res['status'] . ') : ' . $msg);
}

// Lire un document, ex. fs_get('orders/abc') → tableau ou null
function fs_get(string $path): ?array
{
    $res = http_request('GET', fs_documents_url() . '/' . $path, fs_headers());
    if ($res['status'] === 404) return null;
    if ($res['status'] !== 200) throw fs_error($res);
    return fs_decode_fields($res['json']['fields'] ?? []);
}

// Créer un document avec un identifiant précis. Retourne false s'il existe déjà.
function fs_create(string $collection, string $id, array $data): bool
{
    $url = fs_documents_url() . '/' . $collection . '?documentId=' . rawurlencode($id);
    $res = http_request('POST', $url, fs_headers(), json_encode(['fields' => fs_fields($data)]));
    if ($res['status'] === 409) return false;
    if ($res['status'] !== 200) throw fs_error($res);
    return true;
}

// Modifier seulement les champs donnés
function fs_update(string $path, array $data): void
{
    $mask = implode('&', array_map(fn($k) => 'updateMask.fieldPaths=' . rawurlencode($k), array_keys($data)));
    $url = fs_documents_url() . '/' . $path . '?' . $mask . '&currentDocument.exists=true';
    $res = http_request('PATCH', $url, fs_headers(), json_encode(['fields' => fs_fields($data)]));
    if ($res['status'] !== 200) throw fs_error($res);
}

// Commandes en attente (pour le webhook)
function fs_pending_order_ids(int $limit = 20): array
{
    $query = ['structuredQuery' => [
        'from'  => [['collectionId' => 'orders']],
        'where' => ['fieldFilter' => [
            'field' => ['fieldPath' => 'status'],
            'op'    => 'EQUAL',
            'value' => ['stringValue' => 'pending'],
        ]],
        'limit' => $limit,
    ]];
    $res = http_request('POST', fs_documents_url() . ':runQuery', fs_headers(), json_encode($query));
    if ($res['status'] !== 200) throw fs_error($res);
    $ids = [];
    foreach ($res['json'] ?? [] as $row) {
        if (!empty($row['document']['name'])) {
            $ids[] = basename($row['document']['name']);
        }
    }
    return $ids;
}

// -------------------------------------------------------------
//  SasPay
// -------------------------------------------------------------
function saspay_request(string $method, string $path, ?array $body = null): array
{
    $sp = cfg()['saspay'];
    $res = http_request($method, rtrim($sp['api_base'], '/') . $path, [
        'Authorization: Bearer ' . $sp['secret_key'],
        'Content-Type: application/json',
        'Accept: application/json',
    ], $body === null ? null : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

    $json = $res['json'] ?? [];
    if ($res['status'] < 200 || $res['status'] >= 300) {
        // Deux formats d'erreur existent : {error:{message,code}} et {message,code}
        $err = $json['error'] ?? $json;
        $message = is_array($err) ? ($err['message'] ?? json_encode($err, JSON_UNESCAPED_UNICODE)) : (string) $err;
        throw new RuntimeException('SasPay (' . $res['status'] . ') : ' . $message);
    }
    // Réponse enveloppée {success, data} ou objet direct
    return (isset($json['data']) && is_array($json['data'])) ? $json['data'] : $json;
}

function saspay_signature_valid(string $rawBody, string $timestamp, string $signature): bool
{
    if ($timestamp === '' || $signature === '' || !ctype_digit($timestamp)) return false;
    if (abs(time() - (int) $timestamp) > 300) return false;
    $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, cfg()['saspay']['webhook_secret']);
    return hash_equals($expected, strtolower($signature));
}

// -------------------------------------------------------------
//  Commandes et licences
// -------------------------------------------------------------
function plans(): array
{
    return cfg()['plans'];
}

function money(string|float|int $amount): string
{
    return number_format((float) $amount, 2, '.', '');
}

function new_order_id(): string
{
    $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $id = '';
    for ($i = 0; $i < 20; $i++) {
        $id .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $id;
}

function is_valid_order_id(string $id): bool
{
    return (bool) preg_match('/^[A-Za-z0-9]{20}$/', $id);
}

// Clé de licence dérivée de la commande : la même commande donne toujours la même clé
function license_key_for_order(string $orderId): string
{
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $bytes = hash_hmac('sha256', 'license:' . $orderId, cfg()['license_secret'], true);
    $chars = '';
    for ($i = 0; $i < 12; $i++) {
        $chars .= $alphabet[ord($bytes[$i]) % 32];
    }
    return 'REBOOST-' . substr($chars, 0, 4) . '-' . substr($chars, 4, 4) . '-' . substr($chars, 8, 4);
}

function site_url(): string
{
    $configured = rtrim((string) (cfg()['site_url'] ?? ''), '/');
    if ($configured !== '') return $configured;
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $base = rtrim(str_replace('\\', '/', dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/api/x.php'))), '/');
    return ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . $base;
}

/**
 * Vérifie une commande auprès de SasPay et, si elle est payée, crée la licence.
 * Peut être appelée plusieurs fois sans risque (idempotente).
 * Retourne la commande à jour, ou null si elle n'existe pas.
 */
function finalize_order(string $orderId): ?array
{
    $order = fs_get('orders/' . $orderId);
    if ($order === null) return null;
    if ($order['status'] !== 'pending' || empty($order['sessionId'])) return $order;

    $session = saspay_request('GET', '/checkout-sessions/' . rawurlencode($order['sessionId']) . '/');
    $status = strtoupper((string) ($session['status'] ?? ''));

    if ($status === 'PAID') {
        // Sécurité : le montant payé doit correspondre à la commande
        if (money($session['amount'] ?? 0) !== money($order['amount'])
            || strtoupper((string) ($session['currency'] ?? '')) !== strtoupper($order['currency'])) {
            fs_update('orders/' . $orderId, ['status' => 'review', 'note' => 'Montant ou devise différents de la commande']);
            return fs_get('orders/' . $orderId);
        }

        $plan = plans()[$order['plan']] ?? null;
        $months = (int) ($plan['months'] ?? $order['months'] ?? 0);
        $paidAt = time();
        // months = 0 : accès à vie, pas de date d'expiration
        $expires = $months > 0
            ? new FsTimestamp((new DateTimeImmutable('@' . $paidAt))->modify('+' . $months . ' months')->getTimestamp())
            : null;
        $key = license_key_for_order($orderId);

        fs_create('licenses', $key, [
            'key'          => $key,
            'clientEmail'  => $order['customerEmail'],
            'clientName'   => $order['customerName'],
            'type'         => $order['plan'],
            'typeName'     => $plan['name'] ?? $order['plan'],
            'duration'     => $months,
            'expiresAt'    => $expires,
            'status'       => 'active',
            'activated'    => true,
            'activatedAt'  => new FsTimestamp($paidAt),
            'activatedBy'  => $order['customerEmail'],
            'activatedUid' => $order['uid'],
            'userName'     => $order['customerName'],
            'createdAt'    => new FsTimestamp($paidAt),
            'createdBy'    => 'saspay',
            'source'       => 'saspay',
            'orderId'      => $orderId,
            'amount'       => $order['amount'],
            'currency'     => $order['currency'],
        ]); // false = déjà créée lors d'un appel précédent : c'est normal

        fs_update('orders/' . $orderId, [
            'status'        => 'paid',
            'paidAt'        => new FsTimestamp($paidAt),
            'licenseKey'    => $key,
            'transactionId' => is_scalar($session['transaction'] ?? null) ? (string) $session['transaction'] : null,
        ]);
    } elseif ($status === 'EXPIRED' || $status === 'CANCELLED') {
        fs_update('orders/' . $orderId, ['status' => strtolower($status)]);
    }

    return fs_get('orders/' . $orderId);
}

function log_error(Throwable $e): void
{
    error_log('[RE-BOOST] ' . $e->getMessage());
    @file_put_contents(storage_path('errors.log'), date('c') . ' ' . $e->getMessage() . "\n", FILE_APPEND | LOCK_EX);
}
