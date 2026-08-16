/* =====================================================================
   admin-transactions.js — dedicated admin page for completed transactions.
   Lists every payment with an uploaded receipt, lets the admin mark each
   one as "completed" once verified, and persists across refreshes by
   reading straight from Supabase (no local-only state).
   Same auth gate as admin.html (single shared password, sessionStorage).
   ===================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const authScreen = $('#auth-screen');
  const dashboard = $('#dashboard');
  const authArea = $('#auth-area');

  let sb;
  const state = { payments: [], links: {}, filter: 'submitted' };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fatal(msg) {
    if (authScreen) {
      authScreen.innerHTML = `<div class="pay-card" style="max-width:560px;margin:1rem auto;">
        <h2 class="pay-step-title" style="color:var(--secondary);">Admin can't start</h2>
        <p class="text-muted">${esc(msg)}</p>
        <p class="small text-muted mt-2">Open the browser console (F12 → Console) for details.</p>
      </div>`;
    }
    console.error('[admin-transactions]', msg);
  }

  function renderSetupNeeded() {
    authScreen.classList.remove('hidden');
    dashboard.classList.add('hidden');
    authScreen.innerHTML = `
      <div class="pay-card" style="max-width:560px;margin:1rem auto;">
        <h2 class="pay-step-title" style="color:var(--secondary);">Setup needed</h2>
        <p class="pay-step-sub">admin-transactions.html can't connect to a database yet. Finish the setup steps in <code>js/config.js</code> (the same ones listed on admin.html).</p>
      </div>`;
  }

  /* ---------- auth ---------- */

  function renderLogin() {
    dashboard.classList.add('hidden');
    authScreen.classList.remove('hidden');
    authArea.innerHTML = '';
    authScreen.innerHTML = `
      <div class="pay-card" style="max-width:420px;margin:1rem auto;">
        <h2 class="pay-step-title">Admin sign in</h2>
        <p class="pay-step-sub">Enter the admin password to view transactions.</p>
        <form id="login-form">
          <div class="form-group"><label>Password</label><input name="password" type="password" required placeholder="••••••••"></div>
          <p id="login-err" class="text-secondary small hidden"></p>
          <button class="btn-primary w-full" type="submit" style="margin-top:1rem;">Sign in</button>
        </form>
      </div>`;
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const pwd = new FormData(e.target).get('password').toString();
      if (pwd === PAYLINK_CONFIG.ADMIN_PASSWORD) {
        sessionStorage.setItem('paylink_admin', '1');
        loadAll();
      } else {
        const err = $('#login-err');
        err.textContent = 'Incorrect password.';
        err.classList.remove('hidden');
      }
    });
  }

  function signOut() {
    sessionStorage.removeItem('paylink_admin');
    renderLogin();
  }

  /* ---------- data ---------- */

  async function loadAll() {
    try {
      const { data: payments, error } = await sb
        .from('payments')
        .select('*')
        .not('receipt_url', 'is', null)
        .order('created_at', { ascending: false });
      if (error) { fatal('Could not load payments: ' + error.message); return; }
      state.payments = payments || [];

      // Pull the link titles/slugs in one round trip so the cards show context.
      const linkIds = [...new Set(state.payments.map((p) => p.link_id).filter(Boolean))];
      state.links = {};
      if (linkIds.length) {
        const { data: links } = await sb
          .from('payment_links')
          .select('id, title, slug, source_currency')
          .in('id', linkIds);
        (links || []).forEach((l) => (state.links[l.id] = l));
      }
      renderDashboard();
    } catch (e) {
      fatal('Could not load transactions: ' + (e && e.message ? e.message : e));
    }
  }

  /* ---------- dashboard ---------- */

  function statusBadge(status) {
    if (status === 'completed') return `<span class="badge completed">Completed</span>`;
    return `<span class="badge awaiting">Awaiting verification</span>`;
  }

  function fmtMoney(n, c) {
    return (window.formatMoney ? window.formatMoney(n, c) : Number(n).toFixed(2)) + ' ' + c;
  }

  function renderDashboard() {
    authScreen.classList.add('hidden');
    dashboard.classList.remove('hidden');
    authArea.innerHTML = `<button class="btn-primary" id="signout" style="padding:.5rem 1rem;">Sign out</button>`;
    $('#signout').addEventListener('click', signOut);

    const awaiting = state.payments.filter((p) => p.status !== 'completed');
    const completed = state.payments.filter((p) => p.status === 'completed');
    const total = state.payments.length;

    dashboard.innerHTML = `
      <div class="admin-toolbar">
        <div>
          <h1 style="color:var(--primary);font-size:1.8rem;margin:0;">Completed transactions</h1>
          <p class="text-muted small">${total} payment${total === 1 ? '' : 's'} with a receipt uploaded. Refresh the page anytime — it reloads from the database.</p>
        </div>
        <a class="btn-hero-outline" href="admin.html" style="color:var(--primary);border:1px solid var(--primary);text-decoration:none;display:inline-flex;align-items:center;">← Back to links</a>
      </div>

      <div class="txn-tabs" id="tabs">
        <button class="txn-tab ${state.filter === 'submitted' ? 'active' : ''}" data-f="submitted">
          Awaiting verification <span class="count">${awaiting.length}</span>
        </button>
        <button class="txn-tab ${state.filter === 'completed' ? 'active' : ''}" data-f="completed">
          Completed <span class="count">${completed.length}</span>
        </button>
        <button class="txn-tab ${state.filter === 'all' ? 'active' : ''}" data-f="all">
          All <span class="count">${total}</span>
        </button>
      </div>

      <div id="txn-list"></div>`;

    dashboard.querySelectorAll('.txn-tab').forEach((b) =>
      b.addEventListener('click', () => {
        state.filter = b.dataset.f;
        renderDashboard();
      })
    );

    const list = dashboard.querySelector('#txn-list');
    const visible = state.payments.filter((p) => {
      if (state.filter === 'all') return true;
      if (state.filter === 'completed') return p.status === 'completed';
      return p.status !== 'completed';
    });

    if (!visible.length) {
      list.innerHTML = `<div class="pay-card text-muted" style="text-align:center;">No transactions in this view yet.</div>`;
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'txn-list';
    visible.forEach((p) => wrap.appendChild(txnCard(p)));
    list.appendChild(wrap);
  }

  function txnCard(p) {
    const el = document.createElement('div');
    el.className = 'txn-card';
    const link = p.link_id ? state.links[p.link_id] : null;
    const submitted = new Date(p.created_at);
    const submittedStr = submitted.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const receiptLink = p.receipt_url
      ? `<a href="${esc(p.receipt_url)}" target="_blank" rel="noopener">View receipt ↗</a>`
      : '<span class="text-secondary">No receipt</span>';
    const payLink = link
      ? `<a href="pay.html?slug=${esc(link.slug)}" target="_blank" rel="noopener">${esc(link.title)}</a>`
      : '<span class="text-muted">(link deleted)</span>';

    el.innerHTML = `
      <div>
        <div class="txn-head">
          <span class="txn-name">${esc(p.customer_name)}</span>
          ${statusBadge(p.status)}
          <span class="txn-meta" style="margin:0;">${esc(submittedStr)}</span>
        </div>
        <div class="txn-meta">
          ${esc(p.customer_email)} · ${esc(p.customer_phone)}<br>
          ${esc(p.customer_address)}
        </div>
        <div class="txn-amount">
          <span>Sent:</span><strong>${esc(fmtMoney(p.amount_source, p.source_currency))}</strong>
          <span style="color:var(--text-light);">→</span>
          <span>You receive:</span><strong>${esc(fmtMoney(p.amount_target, p.target_currency))}</strong>
        </div>
        <div class="txn-meta txn-link">
          Via ${payLink} · ${receiptLink}
        </div>
      </div>
      <div class="txn-actions">
        ${p.status === 'completed'
          ? `<span class="small">Verified</span>
             <button class="btn-hero-outline" data-act="reopen" style="color:var(--secondary);border:1px solid var(--secondary);">Reopen</button>`
          : `<button class="btn-primary" data-act="complete">Mark complete</button>`}
      </div>`;

    const completeBtn = el.querySelector('[data-act="complete"]');
    if (completeBtn) {
      completeBtn.addEventListener('click', async () => {
        completeBtn.disabled = true;
        completeBtn.textContent = 'Saving…';
        const { error } = await sb.from('payments').update({ status: 'completed' }).eq('id', p.id);
        if (error) {
          alert('Could not update: ' + error.message);
          completeBtn.disabled = false;
          completeBtn.textContent = 'Mark complete';
          return;
        }
        loadAll();
      });
    }
    const reopenBtn = el.querySelector('[data-act="reopen"]');
    if (reopenBtn) {
      reopenBtn.addEventListener('click', async () => {
        reopenBtn.disabled = true;
        const { error } = await sb.from('payments').update({ status: 'submitted' }).eq('id', p.id);
        if (error) { alert('Could not update: ' + error.message); reopenBtn.disabled = false; return; }
        loadAll();
      });
    }
    return el;
  }

  /* ---------- bootstrap ---------- */

  function start() {
    const { createClient } = window.supabase;
    try {
      sb = createClient(PAYLINK_CONFIG.SUPABASE_URL, PAYLINK_CONFIG.SUPABASE_SERVICE_ROLE_KEY);
    } catch (e) {
      fatal('Could not create Supabase client: ' + (e.message || e));
      return;
    }
    if (!window.isPaylinkConfigured()) { renderSetupNeeded(); return; }
    if (sessionStorage.getItem('paylink_admin') === '1') loadAll();
    else renderLogin();
  }

  if (!window.__supabaseReady) {
    fatal('Supabase loader did not initialise. Check the loader <script> in the <head> of admin-transactions.html.');
    return;
  }
  window.__supabaseReady
    .then(function () {
      if (!window.supabase) { fatal('Supabase failed to initialise.'); return; }
      start();
    })
    .catch(function () {
      fatal('The Supabase library could not be loaded from any CDN (jsdelivr or unpkg). This is usually an ad-blocker, a corporate firewall, or a temporary CDN outage. Try disabling browser extensions, switching networks, or using a different CDN.');
    });
})();