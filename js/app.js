// =============================================================
//  RE-BOOST — site public : licences, achat SasPay, tableau de bord
// -------------------------------------------------------------
//  Base de données : Firestore (projet Firebase « reboost »)
//    licenses/{CLÉ}   une licence (l'identifiant du document = la clé)
//  Paiement : serveur PHP du dossier api/ (SasPay)
//    api/plans.php            prix des formules
//    api/create-checkout.php  crée la commande et la session de paiement
//    api/order-status.php     vérifie le paiement et crée la licence
//
//  Les clients sont connectés de façon anonyme (aucun mot de passe) :
//  la licence est liée à cet appareil.
//  L'administration est une application séparée (dossier admin/).
//
//  Les fonctions d'interface (showAlert, showDashboard, populateDashboard,
//  openAuthTab…) sont définies dans le script de index.html.
// =============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signInAnonymously, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
    getFirestore, doc, getDoc, updateDoc, collection, query, where, limit, getDocs, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const SESSION_KEY = 'reboost_session';
const PENDING_ORDER_KEY = 'reboost_pending_order';
const API = 'api';

const $ = id => document.getElementById(id);

// Anciennes données locales de la toute première version
try { localStorage.removeItem('reboost_licenses'); } catch (e) { /* stockage indisponible */ }

// -------------------------------------------------------------
//  Initialisation Firebase
// -------------------------------------------------------------
const isConfigured = Boolean(firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('VOTRE'));
let auth = null;
let db = null;

if (isConfigured) {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
} else {
    console.warn('[RE-BOOST] Firebase n\'est pas configuré : remplissez js/firebase-config.js');
}

window.reboostAppReady = true;

const firstAuthState = new Promise(resolve => {
    if (!auth) return resolve(null);
    const unsubscribe = onAuthStateChanged(auth, user => { unsubscribe(); resolve(user); });
});

// -------------------------------------------------------------
//  Outils
// -------------------------------------------------------------
function requireFirebase() {
    if (isConfigured) return true;
    showAlert("La base de données n'est pas encore configurée (fichier js/firebase-config.js).", 'error');
    return false;
}

function setLoading(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('is-loading', on);
}

function userError(message) {
    const err = new Error(message);
    err.userMessage = message;
    return err;
}

function errorMessage(err) {
    if (err && err.userMessage) return err.userMessage;
    console.error(err);
    const messages = {
        'auth/network-request-failed': 'Connexion internet indisponible.',
        'auth/too-many-requests': 'Trop de tentatives. Réessayez dans quelques minutes.',
        'auth/operation-not-allowed': "La connexion anonyme n'est pas activée dans Firebase.",
        'auth/admin-restricted-operation': "La connexion anonyme n'est pas activée dans Firebase.",
        'auth/unauthorized-domain': "Ce domaine n'est pas autorisé dans Firebase Authentication.",
        'permission-denied': 'Accès refusé par la base de données.',
        'unavailable': 'Base de données injoignable. Vérifiez votre connexion.'
    };
    return messages[err && err.code] || 'Une erreur est survenue. Réessayez.';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function formatDate(ts) {
    if (!ts) return 'À vie';
    const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
    return date.toLocaleDateString('fr-FR');
}

function isExpired(license) {
    return Boolean(license.expiresAt && license.expiresAt.toMillis() < Date.now());
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}
function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignoré */ }
}
function removeKey(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignoré */ }
}

function sessionFromLicense(key, license) {
    return {
        userName: license.userName,
        userEmail: license.activatedBy,
        licenseKey: key,
        licenseType: license.type,
        licenseExpiry: formatDate(license.expiresAt)
    };
}

async function ensureUser() {
    await firstAuthState;
    if (auth.currentUser) return auth.currentUser;
    const cred = await signInAnonymously(auth);
    return cred.user;
}

async function apiFetch(path, options = {}) {
    let res;
    try {
        res = await fetch(`${API}/${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        });
    } catch (e) {
        throw userError('Connexion au serveur impossible. Vérifiez votre connexion internet.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* réponse vide */ }
    if (!res.ok) {
        const err = userError(data.error || 'Le serveur de paiement ne répond pas correctement.');
        err.status = res.status;
        throw err;
    }
    return data;
}

// -------------------------------------------------------------
//  Licence liée à cet appareil
// -------------------------------------------------------------
async function findLicenseForUser(user) {
    const snap = await getDocs(query(collection(db, 'licenses'), where('activatedUid', '==', user.uid), limit(1)));
    const found = snap.docs[0];
    return found ? { key: found.id, data: found.data() } : null;
}

function openDashboardWith(key, license) {
    const session = sessionFromLicense(key, license);
    writeJson(SESSION_KEY, session);
    populateDashboard(session);
    showDashboard();
}

async function restoreSession() {
    if (!isConfigured) { removeKey(SESSION_KEY); return; }

    const cached = readJson(SESSION_KEY);
    if (cached) { populateDashboard(cached); showDashboard(); }

    const user = await firstAuthState;
    if (!user) {
        if (cached) { removeKey(SESSION_KEY); showHomePage(); }
        return;
    }

    try {
        const found = await findLicenseForUser(user);
        if (found && found.data.status === 'active' && !isExpired(found.data)) {
            openDashboardWith(found.key, found.data);
        } else if (cached) {
            removeKey(SESSION_KEY);
            showHomePage();
            showAlert(found && isExpired(found.data)
                ? 'Votre licence a expiré. Renouvelez-la depuis la section Tarifs.'
                : 'Votre licence n\'est plus active. Contactez l\'administrateur.', 'error');
        }
    } catch (err) {
        console.error(err); // hors ligne : on garde l'affichage du cache
    }
}

// -------------------------------------------------------------
//  Activation avec une clé
// -------------------------------------------------------------
$('license-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = this.querySelector('button[type="submit"]');

    const licenseKey = $('license-key').value.trim().toUpperCase();
    const userEmail = $('user-email').value.trim().toLowerCase();
    const userName = $('user-name').value.trim();

    if (!licenseKey || !userEmail || !userName) return showAlert('Veuillez remplir tous les champs.', 'error');
    if (!isValidEmail(userEmail)) return showAlert('Veuillez saisir une adresse email valide.', 'error');
    if (licenseKey.includes('/')) return showAlert('Clé de licence invalide.', 'error');
    if (!requireFirebase()) return;

    setLoading(btn, true);
    try {
        const user = await ensureUser();
        const ref = doc(db, 'licenses', licenseKey);
        const snap = await getDoc(ref);
        const license = snap.exists() ? snap.data() : null;

        if (!license || license.status !== 'active') throw userError('Clé de licence invalide ou inactive. Contactez l\'administrateur.');
        if (isExpired(license)) throw userError('Cette licence a expiré. Renouvelez-la depuis la section Tarifs.');
        if (license.clientEmail && license.clientEmail !== userEmail) throw userError('Cette licence n\'est pas associée à cet email.');
        // Même email = réactivation autorisée (nouvel appareil, navigateur vidé…)
        if (license.activated && license.activatedBy !== userEmail) throw userError('Cette licence a déjà été activée.');

        await updateDoc(ref, {
            activated: true,
            activatedAt: serverTimestamp(),
            activatedBy: userEmail,
            activatedUid: user.uid,
            userName: userName
        });

        this.reset();
        showAlert('Licence activée avec succès ! Redirection...', 'success');
        setTimeout(() => openDashboardWith(licenseKey, { ...license, activatedBy: userEmail, userName }), 1500);
    } catch (err) {
        showAlert(errorMessage(err), 'error');
    } finally {
        setLoading(btn, false);
    }
});

// -------------------------------------------------------------
//  Déconnexion
// -------------------------------------------------------------
$('logout-btn').addEventListener('click', async function () {
    if (!confirm('Êtes-vous sûr de vouloir vous déconnecter ?')) return;
    removeKey(SESSION_KEY);
    try { if (auth) await signOut(auth); } catch (err) { console.error(err); }
    showHomePage();
});

// =============================================================
//  ACHAT EN LIGNE (SasPay)
// =============================================================
let plansInfo = null; // { currency, plans: [{id, name, months, price}] }

function formatPrice(amount, currency) {
    const digits = Number(amount) % 1 ? 2 : 0;
    // Franc congolais : notation locale « FC »
    if (currency === 'CDF') {
        return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(amount)) + ' FC';
    }
    try {
        return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(amount));
    } catch (e) {
        return `${amount} ${currency}`;
    }
}

function selectedPlan() {
    return $('buy-plan').value || null;
}

function updateTotal() {
    const plan = plansInfo && plansInfo.plans.find(p => p.id === selectedPlan());
    $('buy-total').textContent = plan ? formatPrice(plan.price, plansInfo.currency) : '—';
}

async function loadPlans() {
    try {
        const data = await apiFetch('plans.php');
        if (!data || !Array.isArray(data.plans)) throw new Error('réponse inattendue du serveur');
        plansInfo = data;
        plansInfo.plans.forEach(plan => {
            document.querySelectorAll(`[data-price="${plan.id}"]`).forEach(el => {
                el.textContent = formatPrice(plan.price, plansInfo.currency);
            });
        });
        updateTotal();
    } catch (err) {
        console.warn('[RE-BOOST] Prix indisponibles :', err.message);
    }
}

// Bouton « Obtenir mon accès à vie » de la section Tarifs
document.querySelectorAll('.choose-plan').forEach(btn => {
    btn.addEventListener('click', () => {
        $('buy-plan').value = btn.dataset.plan;
        updateTotal();
        openAuthTab('buy');
        document.getElementById('activation').scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => $('buy-name').focus({ preventScroll: true }), 700);
    });
});

$('buy-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = $('buy-submit');
    const plan = selectedPlan();
    const name = $('buy-name').value.trim();
    const email = $('buy-email').value.trim().toLowerCase();
    const phone = $('buy-phone').value.trim();

    if (!plan) return showAlert('Choisissez une formule.', 'error');
    if (!name) return showAlert('Indiquez votre nom complet.', 'error');
    if (!isValidEmail(email)) return showAlert('Veuillez saisir une adresse email valide.', 'error');
    if (phone && !/^\+?[\d\s.\-()]{8,20}$/.test(phone)) return showAlert('Numéro de téléphone invalide.', 'error');
    if (!requireFirebase()) return;

    setLoading(btn, true);
    try {
        const user = await ensureUser();
        const result = await apiFetch('create-checkout.php', {
            method: 'POST',
            body: JSON.stringify({ plan, name, email, phone, uid: user.uid })
        });
        writeJson(PENDING_ORDER_KEY, { orderId: result.orderId, checkoutUrl: result.checkoutUrl, createdAt: Date.now() });
        showAlert('Redirection vers la page de paiement sécurisée…', 'success');
        setTimeout(() => { window.location.href = result.checkoutUrl; }, 600);
    } catch (err) {
        showAlert(errorMessage(err), 'error');
        setLoading(btn, false);
    }
});

// -------------------------------------------------------------
//  Retour de SasPay : confirmation du paiement
// -------------------------------------------------------------
const paymentModal = $('payment-modal');
const paymentBody = $('payment-modal-body');
const POLL_INTERVAL = 4000;
const POLL_MAX = 45; // ≈ 3 minutes
let pollTimer = null;

function renderPayment(state, data = {}) {
    const whatsapp = 'https://wa.me/243896639509?text=' + encodeURIComponent('Bonjour, j\'ai besoin d\'aide pour mon paiement RE-BOOST' + (data.orderId ? ` (commande ${data.orderId})` : ''));
    const views = {
        checking: `
            <div class="pay-spinner"></div>
            <h2>Confirmation du paiement…</h2>
            <p>Nous vérifions votre paiement auprès de SasPay. Cela prend généralement quelques secondes.</p>
            <p class="pay-hint">Si une demande s'affiche sur votre téléphone, validez-la avec votre code Mobile Money.</p>`,
        paid: `
            <div class="pay-icon ok"><i class="fas fa-check"></i></div>
            <h2>Paiement confirmé !</h2>
            <p>Votre accès est actif : <strong>${escapeHtml(data.planName || 'Formation RE-BOOST')}</strong>.</p>
            <div class="pay-key">
                <div><small>Votre clé de licence</small><code id="pay-key-value">${escapeHtml(data.licenseKey || '')}</code></div>
                <button type="button" class="btn btn-secondary btn-small" id="pay-copy"><i class="fas fa-copy"></i></button>
            </div>
            <p class="pay-hint">Conservez cette clé : elle vous permet de retrouver votre accès sur un autre appareil.</p>
            <div class="pay-actions">
                <button type="button" class="btn btn-success btn-block" id="pay-go">${data.linked ? 'Accéder à mon tableau de bord' : 'Activer ma licence'} <i class="fas fa-arrow-right"></i></button>
            </div>`,
        waiting: `
            <div class="pay-icon warn"><i class="fas fa-hourglass-half"></i></div>
            <h2>Paiement en attente</h2>
            <p>Nous n'avons pas encore reçu la confirmation. Si vous avez validé le paiement, elle peut prendre quelques minutes.</p>
            <div class="pay-actions">
                <button type="button" class="btn btn-primary btn-block" id="pay-retry"><i class="fas fa-rotate"></i> Vérifier à nouveau</button>
                ${data.checkoutUrl ? `<a class="btn btn-ghost btn-block" href="${escapeHtml(data.checkoutUrl)}"><i class="fas fa-credit-card"></i> Reprendre le paiement</a>` : ''}
                <button type="button" class="btn btn-secondary btn-block" id="pay-close">Fermer</button>
            </div>`,
        review: `
            <div class="pay-icon warn"><i class="fas fa-user-shield"></i></div>
            <h2>Paiement en vérification</h2>
            <p>Votre paiement nécessite une vérification par notre équipe. Contactez-nous pour l'accélérer.</p>
            <div class="pay-actions">
                <a class="btn btn-success btn-block" href="${whatsapp}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Contacter le support</a>
                <button type="button" class="btn btn-secondary btn-block" id="pay-close">Fermer</button>
            </div>`,
        failed: `
            <div class="pay-icon ko"><i class="fas fa-xmark"></i></div>
            <h2>Paiement non abouti</h2>
            <p>${data.status === 'expired' ? 'La session de paiement a expiré.' : 'Le paiement a été annulé ou n\'a pas pu être effectué.'} Aucun montant n'a été validé pour cette commande.</p>
            <div class="pay-actions">
                <button type="button" class="btn btn-success btn-block" id="pay-again"><i class="fas fa-rotate-right"></i> Réessayer</button>
                <a class="btn btn-ghost btn-block" href="${whatsapp}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Besoin d'aide ?</a>
            </div>`
    };

    paymentBody.innerHTML = views[state];
    paymentModal.classList.add('open');

    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('pay-close', () => paymentModal.classList.remove('open'));
    on('pay-retry', () => startPolling(data.orderId, data.checkoutUrl));
    on('pay-again', () => {
        paymentModal.classList.remove('open');
        openAuthTab('buy');
        document.getElementById('tarifs').scrollIntoView({ behavior: 'smooth' });
    });
    on('pay-copy', () => {
        navigator.clipboard.writeText(data.licenseKey || '')
            .then(() => showAlert('Clé copiée !', 'success'))
            .catch(() => showAlert('Copie impossible : notez la clé manuellement.', 'error'));
    });
    on('pay-go', () => {
        paymentModal.classList.remove('open');
        if (data.linked) {
            showDashboard();
        } else {
            // Paiement fait depuis un autre navigateur : activation avec la clé
            $('license-key').value = data.licenseKey || '';
            $('user-email').value = data.email || '';
            $('user-name').value = data.name || '';
            openAuthTab('license');
            document.getElementById('activation').scrollIntoView({ behavior: 'smooth' });
        }
    });
}

async function onOrderPaid(orderId, status) {
    removeKey(PENDING_ORDER_KEY);
    let linked = false;
    try {
        const user = await firstAuthState;
        if (user) {
            const found = await findLicenseForUser(user);
            if (found && found.key === status.licenseKey) {
                const session = sessionFromLicense(found.key, found.data);
                writeJson(SESSION_KEY, session);
                populateDashboard(session);
                linked = true;
            }
        }
    } catch (err) {
        console.error(err);
    }
    renderPayment('paid', { ...status, orderId, linked });
}

function startPolling(orderId, checkoutUrl) {
    clearTimeout(pollTimer);
    let attempts = 0;
    renderPayment('checking', { orderId });

    const tick = async () => {
        attempts++;
        try {
            const status = await apiFetch(`order-status.php?order=${encodeURIComponent(orderId)}`);
            if (status.status === 'paid') return onOrderPaid(orderId, status);
            if (status.status === 'review') { removeKey(PENDING_ORDER_KEY); return renderPayment('review', { orderId }); }
            if (['expired', 'cancelled', 'failed'].includes(status.status)) {
                removeKey(PENDING_ORDER_KEY);
                return renderPayment('failed', { orderId, status: status.status });
            }
        } catch (err) {
            if (err.status === 404 || err.status === 400) {
                removeKey(PENDING_ORDER_KEY);
                paymentModal.classList.remove('open');
                return showAlert('Commande introuvable.', 'error');
            }
            // Erreur temporaire (réseau, 503) : on continue d'essayer
        }
        if (attempts >= POLL_MAX) return renderPayment('waiting', { orderId, checkoutUrl });
        pollTimer = setTimeout(tick, POLL_INTERVAL);
    };
    tick();
}

function resumePendingPayment() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('commande');
    const pending = readJson(PENDING_ORDER_KEY);

    if (fromUrl) {
        // Nettoyer l'adresse (évite de relancer la vérification au rechargement)
        params.delete('commande');
        const clean = location.pathname + (params.toString() ? `?${params}` : '') + location.hash;
        history.replaceState(null, '', clean);
    }

    const validId = id => typeof id === 'string' && /^[A-Za-z0-9]{20}$/.test(id);

    // Retour direct depuis SasPay : on affiche la confirmation
    if (validId(fromUrl)) {
        const checkoutUrl = pending && pending.orderId === fromUrl ? pending.checkoutUrl : null;
        return startPolling(fromUrl, checkoutUrl);
    }

    // Commande commencée lors d'une visite précédente : vérification discrète
    if (!pending) return;
    if (!validId(pending.orderId) || Date.now() - pending.createdAt > 24 * 3600 * 1000) {
        return removeKey(PENDING_ORDER_KEY);
    }
    apiFetch(`order-status.php?order=${encodeURIComponent(pending.orderId)}`)
        .then(status => {
            if (status.status === 'paid') return onOrderPaid(pending.orderId, status);
            if (status.status !== 'pending') removeKey(PENDING_ORDER_KEY);
        })
        .catch(err => { if (err.status === 404 || err.status === 400) removeKey(PENDING_ORDER_KEY); });
}

// -------------------------------------------------------------
//  Démarrage
// -------------------------------------------------------------
loadPlans();
restoreSession();
resumePendingPayment();
