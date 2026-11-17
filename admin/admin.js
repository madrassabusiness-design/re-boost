// =============================================================
//  RE-BOOST Admin — application de gestion (séparée du site public)
//  Connexion : Firebase Authentication (email + mot de passe)
//  Droits     : document admins/{UID} dans Firestore
//  Données    : licenses/{CLÉ} et orders/{ID} (paiements SasPay), en temps réel
// =============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, orderBy, limit,
    onSnapshot, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// months = 0 : accès à vie (pas de date d'expiration)
const PLANS = {
    lifetime: { name: 'Formation — accès à vie', months: 0 },
    standard: { name: 'Standard', months: 1 },
    premium:  { name: 'Premium',  months: 3 },
    vip:      { name: 'VIP',      months: 12 }
};

const $ = id => document.getElementById(id);
const state = {
    licenses: [],
    orders: [],
    view: 'overview',
    search: '',
    filters: { licenses: 'all', orders: 'all' },
    unsubscribers: [],
    seenOrders: null
};

// -------------------------------------------------------------
//  Outils
// -------------------------------------------------------------
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function toast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fas ${type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i><span></span>`;
    el.querySelector('span').textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4000);
}

function setLoading(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('is-loading', on);
}

function toDate(ts) {
    if (!ts) return null;
    return typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
}

function fmtDate(ts, withTime = false) {
    const d = toDate(ts);
    if (!d) return '—';
    return withTime
        ? d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('fr-FR');
}

function fmtMoney(amount, currency) {
    try {
        const value = Number(amount) || 0;
        const digits = value % 1 ? 2 : 0;
        if ((currency || 'CDF') === 'CDF') {
            return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) + ' FC';
        }
        return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'CDF', currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    } catch (e) {
        return `${amount} ${currency || ''}`;
    }
}

function authError(err) {
    const map = {
        'auth/invalid-credential': 'Email ou mot de passe incorrect.',
        'auth/wrong-password': 'Email ou mot de passe incorrect.',
        'auth/user-not-found': 'Email ou mot de passe incorrect.',
        'auth/invalid-email': 'Adresse email invalide.',
        'auth/too-many-requests': 'Trop de tentatives. Réessayez dans quelques minutes.',
        'auth/network-request-failed': 'Connexion internet indisponible.',
        'auth/operation-not-allowed': "La connexion par email n'est pas activée dans Firebase.",
        'permission-denied': 'Accès refusé par la base de données.'
    };
    if (err && err.userMessage) return err.userMessage;
    console.error(err);
    return map[err && err.code] || 'Une erreur est survenue. Réessayez.';
}

function generateLicenseKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const chars = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
    return `REBOOST-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

function licenseState(l) {
    if (l.status === 'revoked') return 'revoked';
    const exp = toDate(l.expiresAt);
    if (exp && exp.getTime() < Date.now()) return 'expired';
    return l.activated ? 'active' : 'waiting';
}

const LICENSE_PILL = {
    active:  '<span class="pill green">Active</span>',
    waiting: '<span class="pill blue">Non activée</span>',
    expired: '<span class="pill grey">Expirée</span>',
    revoked: '<span class="pill red">Révoquée</span>'
};

const ORDER_PILL = {
    paid:      '<span class="pill green">Payé</span>',
    pending:   '<span class="pill amber">En attente</span>',
    review:    '<span class="pill red">À vérifier</span>',
    failed:    '<span class="pill grey">Échoué</span>',
    expired:   '<span class="pill grey">Expiré</span>',
    cancelled: '<span class="pill grey">Annulé</span>'
};

function matchesSearch(fields) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return fields.some(f => String(f ?? '').toLowerCase().includes(q));
}

function emptyRow(cols, text, icon = 'fa-inbox') {
    return `<tr><td colspan="${cols}"><div class="empty"><i class="fas ${icon}"></i>${text}</div></td></tr>`;
}

// -------------------------------------------------------------
//  Rendu
// -------------------------------------------------------------
function licenseRows(list, compact = false) {
    return list.map(({ id, data: l }) => {
        const st = licenseState(l);
        const client = l.userName || l.clientName || 'Non attribué';
        const email = l.activatedBy || l.clientEmail || '';
        const source = l.source === 'saspay' ? 'SASPAY' : 'MANUELLE';
        if (compact) {
            return `<tr>
                <td class="mono">${escapeHtml(id)}</td>
                <td>${escapeHtml(client)}<small>${escapeHtml(l.typeName || '')}</small></td>
                <td>${LICENSE_PILL[st]}</td>
            </tr>`;
        }
        const toggle = l.status === 'revoked'
            ? `<button class="icon-btn ok" title="Réactiver" data-action="restore" data-key="${escapeHtml(id)}"><i class="fas fa-rotate-left"></i></button>`
            : `<button class="icon-btn danger" title="Révoquer" data-action="revoke" data-key="${escapeHtml(id)}"><i class="fas fa-ban"></i></button>`;
        return `<tr>
            <td class="mono">${escapeHtml(id)}<small class="src">${source}</small></td>
            <td>${escapeHtml(client)}${email ? `<small>${escapeHtml(email)}</small>` : ''}</td>
            <td>${escapeHtml(l.typeName || l.type || '')}</td>
            <td>${LICENSE_PILL[st]}</td>
            <td>${fmtDate(l.createdAt)}</td>
            <td>${l.expiresAt ? fmtDate(l.expiresAt) : 'À vie'}</td>
            <td><div class="actions">
                <button class="icon-btn" title="Copier la clé" data-action="copy" data-key="${escapeHtml(id)}"><i class="fas fa-copy"></i></button>
                ${toggle}
            </div></td>
        </tr>`;
    }).join('');
}

function orderRows(list, compact = false) {
    return list.map(({ id, data: o }) => {
        const pill = ORDER_PILL[o.status] || `<span class="pill grey">${escapeHtml(o.status)}</span>`;
        if (compact) {
            return `<tr data-order="${escapeHtml(id)}">
                <td>${escapeHtml(o.customerName)}<small>${escapeHtml(o.planName || o.plan)}</small></td>
                <td class="num">${fmtMoney(o.amount, o.currency)}</td>
                <td>${pill}</td>
            </tr>`;
        }
        return `<tr data-order="${escapeHtml(id)}">
            <td>${fmtDate(o.createdAt, true)}</td>
            <td>${escapeHtml(o.customerName)}<small>${escapeHtml(o.customerEmail)}${o.customerPhone ? ' · ' + escapeHtml(o.customerPhone) : ''}</small></td>
            <td>${escapeHtml(o.planName || o.plan)}</td>
            <td class="num">${fmtMoney(o.amount, o.currency)}</td>
            <td>${pill}${o.note ? `<small>${escapeHtml(o.note)}</small>` : ''}</td>
            <td class="mono">${o.licenseKey ? escapeHtml(o.licenseKey) : '—'}</td>
            <td><div class="actions">${o.licenseKey ? `<button class="icon-btn" title="Copier la clé" data-action="copy" data-key="${escapeHtml(o.licenseKey)}"><i class="fas fa-copy"></i></button>` : ''}</div></td>
        </tr>`;
    }).join('');
}

function table(head, rows, cols, emptyText) {
    return `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows || emptyRow(cols, emptyText)}</tbody></table>`;
}

function renderStats() {
    const active = state.licenses.filter(l => licenseState(l.data) === 'active').length;
    const paid = state.orders.filter(o => o.data.status === 'paid');
    const pending = state.orders.filter(o => o.data.status === 'pending').length;
    const review = state.orders.filter(o => o.data.status === 'review').length;

    const byCurrency = {};
    paid.forEach(({ data: o }) => { byCurrency[o.currency] = (byCurrency[o.currency] || 0) + (Number(o.amount) || 0); });
    const revenue = Object.entries(byCurrency).map(([cur, sum]) => fmtMoney(sum, cur)).join(' · ') || fmtMoney(0, 'CDF');

    $('st-active').textContent = active;
    $('st-sales').textContent = paid.length;
    $('st-revenue').textContent = revenue;
    $('st-pending').textContent = pending;

    const badge = $('nav-pending');
    badge.hidden = review === 0;
    badge.textContent = review;
    badge.title = `${review} paiement(s) à vérifier`;
}

function render() {
    renderStats();

    if (state.view === 'overview') {
        $('recent-orders').innerHTML = table(['Client', 'Montant', 'Statut'], orderRows(state.orders.slice(0, 6), true), 3, 'Aucun paiement pour le moment.');
        $('recent-licenses').innerHTML = table(['Clé', 'Client', 'Statut'], licenseRows(state.licenses.slice(0, 6), true), 3, 'Aucune licence pour le moment.');
    }

    if (state.view === 'licenses') {
        const f = state.filters.licenses;
        const list = state.licenses.filter(({ id, data: l }) =>
            (f === 'all' || licenseState(l) === f) &&
            matchesSearch([id, l.userName, l.clientName, l.activatedBy, l.clientEmail, l.typeName])
        );
        $('licenses-table').innerHTML = table(['Clé', 'Client', 'Formule', 'Statut', 'Créée le', 'Expire le', ''], licenseRows(list), 7, 'Aucune licence ne correspond.');
    }

    if (state.view === 'orders') {
        const f = state.filters.orders;
        const groups = { failed: ['failed', 'expired', 'cancelled'] };
        const list = state.orders.filter(({ id, data: o }) =>
            (f === 'all' || (groups[f] ? groups[f].includes(o.status) : o.status === f)) &&
            matchesSearch([id, o.customerName, o.customerEmail, o.customerPhone, o.licenseKey, o.planName])
        );
        $('orders-table').innerHTML = table(['Date', 'Client', 'Formule', 'Montant', 'Statut', 'Licence', ''], orderRows(list), 7, 'Aucun paiement ne correspond.');
    }
}

// -------------------------------------------------------------
//  Navigation
// -------------------------------------------------------------
const TITLES = { overview: "Vue d'ensemble", orders: 'Paiements', licenses: 'Licences', new: 'Nouvelle licence' };

function showView(view) {
    state.view = view;
    document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
    $('view-title').textContent = TITLES[view];
    $('search-box').style.visibility = (view === 'licenses' || view === 'orders') ? 'visible' : 'hidden';
    render();
}

document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showView(b.dataset.goto)));

document.querySelectorAll('.chips').forEach(group => {
    group.addEventListener('click', e => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        group.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
        state.filters[group.dataset.filterFor] = chip.dataset.filter;
        render();
    });
});

$('search').addEventListener('input', e => { state.search = e.target.value; render(); });

// Actions dans les tableaux (copier, révoquer, réactiver)
document.querySelector('.content').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const key = btn.dataset.key;

    if (btn.dataset.action === 'copy') {
        navigator.clipboard.writeText(key).then(() => toast('Clé copiée.')).catch(() => toast('Copie impossible.', 'error'));
        return;
    }

    const revoke = btn.dataset.action === 'revoke';
    if (revoke && !confirm(`Révoquer la licence ${key} ?\nLe client perdra immédiatement l'accès.`)) return;
    btn.disabled = true;
    try {
        await updateDoc(doc(db, 'licenses', key), { status: revoke ? 'revoked' : 'active' });
        toast(revoke ? 'Licence révoquée.' : 'Licence réactivée.');
    } catch (err) {
        btn.disabled = false;
        toast(authError(err), 'error');
    }
});

// -------------------------------------------------------------
//  Nouvelle licence (manuelle)
// -------------------------------------------------------------
$('new-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('new-btn');
    const name = $('new-name').value.trim();
    const email = $('new-email').value.trim().toLowerCase();
    const typeKey = $('new-type').value;
    const plan = PLANS[typeKey];

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Email du client invalide.', 'error');

    let expiry = null;
    if (plan.months > 0) {
        expiry = new Date();
        expiry.setMonth(expiry.getMonth() + plan.months);
    }
    const key = generateLicenseKey();

    setLoading(btn, true);
    try {
        await setDoc(doc(db, 'licenses', key), {
            key,
            clientEmail: email || null,
            clientName: name || null,
            type: typeKey,
            typeName: plan.name,
            duration: plan.months,
            expiresAt: expiry ? Timestamp.fromDate(expiry) : null,
            status: 'active',
            activated: false,
            activatedAt: null,
            activatedBy: null,
            activatedUid: null,
            userName: null,
            createdAt: serverTimestamp(),
            createdBy: auth.currentUser.email,
            source: 'admin'
        });

        $('new-result').innerHTML = `
            <div class="result">
                <h3><i class="fas fa-circle-check"></i> Licence générée</h3>
                <div class="key"><code>${escapeHtml(key)}</code>
                    <button class="btn btn-primary btn-sm" data-action="copy" data-key="${escapeHtml(key)}"><i class="fas fa-copy"></i> Copier</button>
                </div>
                <dl>
                    <dt>Formule</dt><dd>${escapeHtml(plan.name)}${plan.months ? ` (${plan.months} mois)` : ''}</dd>
                    <dt>Expire le</dt><dd>${expiry ? expiry.toLocaleDateString('fr-FR') : 'Jamais (à vie)'}</dd>
                    <dt>Client</dt><dd>${escapeHtml(name || '—')}${email ? ' · ' + escapeHtml(email) : ''}</dd>
                </dl>
            </div>`;
        $('new-result').querySelector('[data-action="copy"]').addEventListener('click', ev => {
            ev.stopPropagation();
            navigator.clipboard.writeText(key).then(() => toast('Clé copiée.')).catch(() => toast('Copie impossible.', 'error'));
        });
        $('new-form').reset();
        toast('Licence créée.');
    } catch (err) {
        toast(authError(err), 'error');
    } finally {
        setLoading(btn, false);
    }
});

// -------------------------------------------------------------
//  Données en temps réel
// -------------------------------------------------------------
function setLive(on) {
    const badge = $('live-badge');
    badge.classList.toggle('off', !on);
    badge.textContent = on ? 'Temps réel' : 'Hors ligne';
}

function startListeners() {
    const onError = err => { setLive(false); toast(authError(err), 'error'); };

    state.unsubscribers.push(onSnapshot(
        query(collection(db, 'licenses'), orderBy('createdAt', 'desc'), limit(500)),
        snap => {
            state.licenses = snap.docs.map(d => ({ id: d.id, data: d.data() }));
            setLive(!snap.metadata.fromCache);
            render();
        }, onError));

    state.unsubscribers.push(onSnapshot(
        query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(500)),
        snap => {
            // Notification quand un nouveau paiement est confirmé
            if (state.seenOrders) {
                snap.docChanges().forEach(change => {
                    const o = change.doc.data();
                    if (o.status === 'paid' && state.seenOrders.get(change.doc.id) !== 'paid') {
                        toast(`Nouveau paiement : ${o.customerName} — ${fmtMoney(o.amount, o.currency)}`);
                    }
                });
            }
            state.seenOrders = new Map(snap.docs.map(d => [d.id, d.data().status]));
            state.orders = snap.docs.map(d => ({ id: d.id, data: d.data() }));
            render();
        }, onError));
}

function stopListeners() {
    state.unsubscribers.forEach(unsub => unsub());
    state.unsubscribers = [];
    state.licenses = [];
    state.orders = [];
    state.seenOrders = null;
}

// -------------------------------------------------------------
//  Connexion
// -------------------------------------------------------------
function showScreen(name) {
    $('boot-view').hidden = name !== 'boot';
    $('login-view').hidden = name !== 'login';
    $('app-view').hidden = name !== 'app';
}

function loginError(message) {
    const box = $('login-error');
    box.textContent = message;
    box.classList.toggle('show', Boolean(message));
}

async function isAdmin(user) {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
}

$('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('login-btn');
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    if (!email || !password) return loginError('Saisissez votre email et votre mot de passe.');

    loginError('');
    setLoading(btn, true);
    try {
        await signInWithEmailAndPassword(auth, email, password);
        // La suite est gérée par onAuthStateChanged
    } catch (err) {
        loginError(authError(err));
        setLoading(btn, false);
    }
});

$('logout-btn').addEventListener('click', async () => {
    await signOut(auth);
    toast('Vous êtes déconnecté.');
});

onAuthStateChanged(auth, async user => {
    stopListeners();
    setLoading($('login-btn'), false);

    if (!user || user.isAnonymous) {
        showScreen('login');
        return;
    }

    try {
        if (!(await isAdmin(user))) {
            await signOut(auth);
            loginError("Ce compte n'a pas les droits administrateur.");
            showScreen('login');
            return;
        }
    } catch (err) {
        await signOut(auth);
        loginError(authError(err));
        showScreen('login');
        return;
    }

    $('who-email').textContent = user.email;
    $('login-password').value = '';
    showScreen('app');
    showView('overview');
    startListeners();
});
