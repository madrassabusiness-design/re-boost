// =============================================================
//  RE-BOOST — publication des règles Firestore (firestore.rules)
//  par l'API Firebase Rules, avec la clé du compte de service.
//  Utilisé par le déploiement automatique GitHub (aucune dépendance).
//
//  Usage : GOOGLE_APPLICATION_CREDENTIALS=cle.json node deploy/publier-regles.mjs [--verifier]
//    --verifier : lecture seule, affiche la version actuellement publiée
// =============================================================
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT = 'reboost-cd96c';
const API = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}`;
const RELEASE = `projects/${PROJECT}/releases/cloud.firestore`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyFile) { console.error('GOOGLE_APPLICATION_CREDENTIALS manquant'); process.exit(1); }
const sa = JSON.parse(readFileSync(keyFile, 'utf8'));

async function accessToken() {
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 600
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('Jeton Google refusé : ' + JSON.stringify(data));
    return data.access_token;
}

async function call(token, method, url, body) {
    const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} : ${data.error?.message || JSON.stringify(data)}`);
    return data;
}

const token = await accessToken();
const current = await call(token, 'GET', `${API}/releases/cloud.firestore`);
console.log(`Règles publiées actuellement : ${current.rulesetName} (${current.updateTime})`);

if (process.argv.includes('--verifier')) process.exit(0);

const source = readFileSync(join(root, 'firestore.rules'), 'utf8');
const ruleset = await call(token, 'POST', `${API}/rulesets`, {
    source: { files: [{ name: 'firestore.rules', content: source }] }
});
console.log(`Règles compilées : ${ruleset.name}`);

await call(token, 'PATCH', `${API}/releases/cloud.firestore`, {
    release: { name: RELEASE, rulesetName: ruleset.name }
});
console.log('Règles Firestore publiées ✔');
