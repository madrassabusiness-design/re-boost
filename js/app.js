// =============================================================
//  RE-BOOST — site public : comptes, achat SasPay, tableau de bord
// -------------------------------------------------------------
//  Parcours : page de connexion → (pas encore client) page d'offre
//                               → (client) tableau de bord
//  Comptes  : Firebase Authentication — email + mot de passe, ou Google.
//             L'accès suit le compte : il marche sur tous les appareils.
//  Données  : Firestore — licenses/{CLÉ} (activatedUid = UID du compte)
//  Paiement : serveur PHP du dossier api/ (SasPay)
//    api/plans.php            prix de l'offre
//    api/create-checkout.php  crée la commande et la session de paiement
//    api/order-status.php     vérifie le paiement et crée la licence
//
//  Les fonctions d'interface (showAlert, showAuthPage, showHomePage,
//  showDashboard, populateDashboard, openAuthTab…) sont dans index.html.
// =============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    updateProfile, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup,
    signInWithRedirect, getRedirectResult, signOut
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
    auth.languageCode = 'fr'; // emails (mot de passe oublié) et fenêtre Google en français
    db = getFirestore(app);
} else {
    console.warn('[RE-BOOST] Firebase n\'est pas configuré : remplissez js/firebase-config.js');
}

window.reboostAppReady = true;

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
        'auth/invalid-credential': 'Email ou mot de passe incorrect.',
        'auth/wrong-password': 'Email ou mot de passe incorrect.',
        'auth/user-not-found': 'Aucun compte avec cet email. Créez votre compte.',
        'auth/invalid-email': 'Adresse email invalide.',
        'auth/email-already-in-use': 'Un compte existe déjà avec cet email. Connectez-vous.',
        'auth/weak-password': 'Mot de passe trop faible (8 caractères minimum).',
        'auth/user-disabled': 'Ce compte a été désactivé. Contactez le support.',
        'auth/account-exists-with-different-credential': 'Un compte existe déjà avec cet email : connectez-vous avec votre email et votre mot de passe.',
        'auth/popup-blocked': 'La fenêtre Google a été bloquée par le navigateur.',
        'auth/network-request-failed': 'Connexion internet indisponible.',
        'auth/too-many-requests': 'Trop de tentatives. Réessayez dans quelques minutes.',
        'auth/operation-not-allowed': "Cette méthode de connexion n'est pas activée dans Firebase.",
        'auth/unauthorized-domain': "Ce site n'est pas encore autorisé dans Firebase (Authentication > Domaines autorisés).",
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
//  Utilisateur connecté
// -------------------------------------------------------------
let currentUser = null;

function displayName(user) {
    return (user.displayName || '').trim() || (user.email || 'Utilisateur').split('@')[0];
}

function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || 'U';
}

// Affiche le nom du compte dans l'en-tête
function fillUserUi(user) {
    const name = displayName(user);
    $('offer-user-name').textContent = name;
    $('offer-avatar').textContent = initials(name);
}

function sessionFromLicense(key, license, user) {
    return {
        uid: user.uid,
        userName: (user.displayName || '').trim() || license.userName || displayName(user),
        userEmail: user.email,
        licenseKey: key,
        licenseType: license.type,
        licenseExpiry: formatDate(license.expiresAt)
    };
}

async function findLicenseForUser(user) {
    const snap = await getDocs(query(collection(db, 'licenses'), where('activatedUid', '==', user.uid), limit(1)));
    const found = snap.docs[0];
    return found ? { key: found.id, data: found.data() } : null;
}

function openDashboardWith(key, license, user) {
    const session = sessionFromLicense(key, license, user);
    writeJson(SESSION_KEY, session);
    populateDashboard(session);
    showDashboard();
}

// -------------------------------------------------------------
//  Aiguillage : connexion → offre ou tableau de bord
// -------------------------------------------------------------
let firstRouteDone = false;
let pendingResumed = false;

async function route(user) {
    currentUser = user && !user.isAnonymous ? user : null;

    if (!currentUser) {
        // Ancienne session anonyme (avant les comptes) : on la ferme
        if (user && user.isAnonymous) { try { await signOut(auth); } catch (e) { /* ignoré */ } }
        removeKey(SESSION_KEY);
        showAuthPage();
    } else {
        fillUserUi(currentUser);
        const cached = readJson(SESSION_KEY);
        if (cached && cached.uid === currentUser.uid) { populateDashboard(cached); showDashboard(); }

        try {
            const found = await findLicenseForUser(currentUser);
            if (found && found.data.status === 'active' && !isExpired(found.data)) {
                openDashboardWith(found.key, found.data, currentUser);
            } else {
                removeKey(SESSION_KEY);
                showHomePage();
                if (found && isExpired(found.data)) showAlert('Votre accès a expiré. Vous pouvez le renouveler ci-dessous.', 'error');
                if (found && found.data.status === 'revoked') showAlert('Votre accès a été suspendu. Contactez le support.', 'error');
            }
        } catch (err) {
            console.error(err);
            if (!(cached && cached.uid === currentUser.uid)) showHomePage(); // hors ligne : on garde le cache
        }

        if (!pendingResumed) { pendingResumed = true; resumePendingPayment(); }
    }

    if (!firstRouteDone) {
        firstRouteDone = true;
        document.dispatchEvent(new Event('reboost:auth-ready'));
    }
}

if (auth) {
    onAuthStateChanged(auth, route);
    // Retour d'une connexion Google par redirection (si la fenêtre avait été bloquée)
    getRedirectResult(auth).catch(err => showAlert(errorMessage(err), 'error'));
} else {
    showAuthPage();
    document.dispatchEvent(new Event('reboost:auth-ready'));
}

// -------------------------------------------------------------
//  Connexion, inscription, Google, mot de passe oublié
// -------------------------------------------------------------
$('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = $('login-submit');
    const email = $('login-email').value.trim();
    const password = $('login-password').value;

    if (!isValidEmail(email)) return showAlert('Saisissez une adresse email valide.', 'error');
    if (!password) return showAlert('Saisissez votre mot de passe.', 'error');
    if (!requireFirebase()) return;

    setLoading(btn, true);
    try {
        await signInWithEmailAndPassword(auth, email, password);
        $('login-password').value = '';
        // La suite (offre ou tableau de bord) est gérée par route()
    } catch (err) {
        showAlert(errorMessage(err), 'error');
    } finally {
        setLoading(btn, false);
    }
});

$('register-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = $('register-submit');
    const name = $('register-name').value.trim();
    const email = $('register-email').value.trim();
    const password = $('register-password').value;
    const confirmation = $('register-password2').value;

    if (name.length < 2) return showAlert('Indiquez votre nom complet.', 'error');
    if (!isValidEmail(email)) return showAlert('Saisissez une adresse email valide.', 'error');
    if (password.length < 8) return showAlert('Le mot de passe doit contenir au moins 8 caractères.', 'error');
    if (password !== confirmation) return showAlert('Les deux mots de passe ne sont pas identiques.', 'error');
    if (!requireFirebase()) return;

    setLoading(btn, true);
    try {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName: name });
        fillUserUi(cred.user);
        this.reset();
        showAlert(`Bienvenue ${name.split(' ')[0]} ! Votre compte est créé.`, 'success');
    } catch (err) {
        showAlert(errorMessage(err), 'error');
    } finally {
        setLoading(btn, false);
    }
});

document.querySelectorAll('.google-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!requireFirebase()) return;
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    setLoading(btn, true);
    try {
        await signInWithPopup(auth, provider);
    } catch (err) {
        if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
            // l'utilisateur a fermé la fenêtre : rien à signaler
        } else if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
            await signInWithRedirect(auth, provider); // repli : pleine page
        } else {
            showAlert(errorMessage(err), 'error');
        }
    } finally {
        setLoading(btn, false);
    }
}));

$('forgot-btn').addEventListener('click', async () => {
    const email = $('login-email').value.trim();
    if (!isValidEmail(email)) {
        $('login-email').focus();
        return showAlert('Saisissez d\'abord votre email dans le champ ci-dessus.', 'error');
    }
    if (!requireFirebase()) return;
    try {
        await sendPasswordResetEmail(auth, email);
    } catch (err) {
        if (err.code !== 'auth/user-not-found') return showAlert(errorMessage(err), 'error');
    }
    // Message identique que le compte existe ou non (ne révèle pas les comptes existants)
    showAlert('Si un compte existe pour cet email, un lien de réinitialisation vient d\'être envoyé.', 'success');
});

// Déconnexion (tableau de bord et page d'offre)
document.querySelectorAll('.logout-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Êtes-vous sûr de vouloir vous déconnecter ?')) return;
    removeKey(SESSION_KEY);
    try { if (auth) await signOut(auth); } catch (err) { console.error(err); }
    // route() affiche la page de connexion
}));

// -------------------------------------------------------------
//  Activation avec une clé (fenêtre « J'ai déjà une clé »)
// -------------------------------------------------------------
const licenseModal = $('license-modal');

function openLicenseModal(key = '') {
    $('license-key').value = key;
    licenseModal.classList.add('open');
    setTimeout(() => $('license-key').focus(), 300);
}
$('open-license').addEventListener('click', () => openLicenseModal());

$('license-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = this.querySelector('button[type="submit"]');
    const user = currentUser;
    if (!user) return showAuthPage();

    const licenseKey = $('license-key').value.trim().toUpperCase();
    const userName = displayName(user).slice(0, 100);

    if (!licenseKey) return showAlert('Saisissez votre clé de licence.', 'error');
    if (licenseKey.includes('/')) return showAlert('Clé de licence invalide.', 'error');
    if (!user.email) return showAlert('Votre compte n\'a pas d\'adresse email.', 'error');

    setLoading(btn, true);
    try {
        const ref = doc(db, 'licenses', licenseKey);
        const snap = await getDoc(ref);
        const license = snap.exists() ? snap.data() : null;

        if (!license || license.status !== 'active') throw userError('Clé de licence invalide ou inactive. Contactez l\'administrateur.');
        if (isExpired(license)) throw userError('Cette licence a expiré.');
        if (license.clientEmail && license.clientEmail !== user.email.toLowerCase()) throw userError('Cette clé est réservée à une autre adresse email.');
        if (license.activated && license.activatedUid !== user.uid) throw userError('Cette clé est déjà utilisée par un autre compte.');

        await updateDoc(ref, {
            activated: true,
            activatedAt: serverTimestamp(),
            activatedBy: user.email,
            activatedUid: user.uid,
            userName: userName
        });

        $('license-key').value = '';
        licenseModal.classList.remove('open');
        showAlert('Licence activée ! Bienvenue dans votre espace.', 'success');
        openDashboardWith(licenseKey, { ...license, userName }, user);
    } catch (err) {
        showAlert(errorMessage(err), 'error');
    } finally {
        setLoading(btn, false);
    }
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
    } catch (err) {
        console.warn('[RE-BOOST] Prix indisponibles :', err.message);
    }
}

// « Acheter la formation » : redirection directe vers la page de paiement SasPay
// (nom et email repris du compte connecté)
document.querySelectorAll('.choose-plan').forEach(btn => btn.addEventListener('click', async () => {
    const user = currentUser;
    if (!user) return showAuthPage();

    const email = (user.email || '').toLowerCase();
    if (!isValidEmail(email)) return showAlert('Votre compte n\'a pas d\'adresse email valide.', 'error');

    setLoading(btn, true);
    try {
        const result = await apiFetch('create-checkout.php', {
            method: 'POST',
            body: JSON.stringify({ plan: btn.dataset.plan, name: displayName(user).slice(0, 100), email, uid: user.uid })
        });
        writeJson(PENDING_ORDER_KEY, { orderId: result.orderId, checkoutUrl: result.checkoutUrl, uid: user.uid, createdAt: Date.now() });
        window.location.href = result.checkoutUrl;
    } catch (err) {
        showAlert(errorMessage(err), 'error');
        setLoading(btn, false);
    }
}));

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
            <p class="pay-hint">Votre accès est lié à votre compte : connectez-vous sur n'importe quel appareil pour le retrouver.</p>
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
        showHomePage();
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
            // Paiement fait avec un autre compte : activation avec la clé
            showHomePage();
            openLicenseModal(data.licenseKey || '');
        }
    });
}

// Paiement confirmé : accès direct au tableau de bord
async function onOrderPaid(orderId, status) {
    removeKey(PENDING_ORDER_KEY);
    try {
        if (currentUser) {
            const found = await findLicenseForUser(currentUser);
            if (found && found.key === status.licenseKey) {
                paymentModal.classList.remove('open');
                openDashboardWith(found.key, found.data, currentUser);
                showAlert('Paiement confirmé ! Bienvenue dans votre espace.', 'success');
                return;
            }
        }
    } catch (err) {
        console.error(err);
    }
    // Cas rare : licence créée pour un autre compte → on affiche la clé à activer
    renderPayment('paid', { ...status, orderId, linked: false });
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

// Numéro de commande au retour de SasPay (?commande=…), lu dès le chargement
const validOrderId = id => typeof id === 'string' && /^[A-Za-z0-9]{20}$/.test(id);
const returnedOrderId = (() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('commande');
    if (id !== null) {
        // Nettoyer l'adresse (évite de relancer la vérification au rechargement)
        params.delete('commande');
        history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
    }
    return validOrderId(id) ? id : null;
})();

// Appelée une fois l'utilisateur connecté
function resumePendingPayment() {
    const pending = readJson(PENDING_ORDER_KEY);

    // Retour direct depuis SasPay : on affiche la confirmation
    if (returnedOrderId) {
        const checkoutUrl = pending && pending.orderId === returnedOrderId ? pending.checkoutUrl : null;
        return startPolling(returnedOrderId, checkoutUrl);
    }

    // Commande commencée lors d'une visite précédente : vérification discrète
    if (!pending) return;
    if (!validOrderId(pending.orderId) || Date.now() - pending.createdAt > 24 * 3600 * 1000
        || (pending.uid && currentUser && pending.uid !== currentUser.uid)) {
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
