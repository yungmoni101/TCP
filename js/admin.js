/* =====================================================================
   admin.js — admin dashboard for /admin.html
   Single shared password (from config.js) -> list/create/delete links ->
   edit bank details -> view payments + receipts.

   IMPORTANT: this script waits for the Supabase CDN library to finish
   loading before it runs (window.__supabaseReady, a Promise set by the
   loader <script> in <head>). That removes the race condition where the
   async CDN <script> had not finished by the time admin.js executed
   synchronously, which previously made us wrongly report a CDN failure.
   ===================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const authScreen = $('#auth-screen');
  const dashboard = $('#dashboard');
  const authArea = $('#auth-area');

  // Supabase client + shared state (initialised inside start()).
  let sb;
  let TARGET;
  const state = { links: [], bankByLink: {}, paymentsByLink: {}, defaultBank: null, editing: null, openLink: null, mode: 'signin' };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slugify = (s) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

  function fatal(msg) {
    if (authScreen) {
      authScreen.innerHTML = `<div class="pay-card" style="max-width:560px;margin:1rem auto;">
        <h2 class="pay-step-title" style="color:var(--secondary);">Admin can't start</h2>
        <p class="text-muted">${msg}</p>
        <p class="small text-muted mt-2">Open the browser console (F12 → Console) for details.</p>
      </div>`;
    }
    console.error('[admin]', msg);
  }

  function renderSetupNeeded() {
    authScreen.classList.remove('hidden');
    dashboard.classList.add('hidden');
    authScreen.innerHTML = `
      <div class="pay-card" style="max-width:560px;margin:1rem auto;">
        <h2 class="pay-step-title" style="color:var(--secondary);">Setup needed</h2>
        <p class="pay-step-sub">admin.html can't connect to a database yet. Finish these steps in <code>js/config.js</code>:</p>
        <ol class="small" style="line-height:1.9;color:var(--text-light);padding-left:1.2rem;">
          <li>Project URL + <strong>anon</strong> key (already filled from earlier).</li>
          <li>Set a strong <code>ADMIN_PASSWORD</code> (the only thing the admin login asks for).</li>
          <li>Paste the <strong>service_role</strong> key (Project Settings → API → "service_role" under Legacy keys) into <code>SUPABASE_SERVICE_ROLE_KEY</code>.</li>
          <li>Run <code>supabase/schema.sql</code> in the SQL editor if you haven't.</li>
          <li>Serve over <strong>http://</strong> (e.g. <code>python -m http.server 8000</code>) — <code>file://</code> won't work.</li>
        </ol>
        <p class="small text-muted">Then refresh this page. Full steps are in README.md.</p>
      </div>`;
  }

  /* ---------- auth (single shared password from config) ---------- */

  function renderLogin() {
    dashboard.classList.add('hidden');
    authScreen.classList.remove('hidden');
    authArea.innerHTML = '';
    authScreen.innerHTML = `
      <div class="pay-card" style="max-width:420px;margin:1rem auto;">
        <h2 class="pay-step-title">Admin sign in</h2>
        <p class="pay-step-sub">Enter the admin password to manage payment links.</p>
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

  /* ---------- dashboard ---------- */

  async function loadAll() {
    const { data: links } = await sb.from('payment_links').select('*').order('created_at', { ascending: false });
    state.links = links || [];
    if (!state.links.length) { renderDashboard(); return; }
    const ids = state.links.map((l) => l.id);
    const [bRes, pRes, dRes] = await Promise.all([
      sb.from('bank_details').select('*').in('link_id', ids),
      sb.from('payments').select('*').in('link_id', ids).order('created_at', { ascending: false }),
      sb.from('default_bank_details').select('*').eq('id', 'default').maybeSingle(),
    ]);
    const bMap = {}; (bRes.data || []).forEach((b) => (bMap[b.link_id] = b));
    const pMap = {}; (pRes.data || []).forEach((p) => { if (p.link_id) (pMap[p.link_id] ||= []).push(p); });
    state.links.forEach((l) => { bMap[l.id] = bMap[l.id] || null; });
    state.bankByLink = bMap; state.paymentsByLink = pMap; state.defaultBank = dRes.data || null;
    renderDashboard();
  }

  function renderDashboard() {
    authScreen.classList.add('hidden');
    dashboard.classList.remove('hidden');
    authArea.innerHTML = `<button class="btn-primary" id="signout" style="padding:.5rem 1rem;">Sign out</button>`;
    $('#signout').addEventListener('click', signOut);
    const totalPayments = Object.values(state.paymentsByLink).reduce((n, a) => n + a.length, 0);

    dashboard.innerHTML = `
      <div class="admin-toolbar">
        <div><h1 style="color:var(--primary);font-size:1.8rem;margin:0;">Payment links</h1>
        <p class="text-muted small">${state.links.length} links · ${totalPayments} payments received</p></div>
        <div class="flex gap-2">
          <a class="btn-hero-outline" href="admin-transactions.html" style="color:var(--primary);border:1px solid var(--primary);text-decoration:none;display:inline-flex;align-items:center;">↗ Completed transactions</a>
          <button class="btn-primary" id="new-link">+ New payment link</button>
          <button class="btn-hero-outline" id="default-bank" style="color:var(--primary);border:1px solid var(--primary);">⚙ Default bank details</button>
        </div>
      </div>
      <div class="link-grid" id="grid"></div>`;
    $('#new-link').addEventListener('click', openCreateModal);
    $('#default-bank').addEventListener('click', openDefaultBankModal);
    const grid = $('#grid');
    if (!state.links.length) {
      grid.innerHTML = `<div class="pay-card text-muted">No links yet. Click <strong>New payment link</strong> to create your first one.</div>`;
    } else {
      state.links.forEach((l) => grid.appendChild(linkCard(l)));
    }
  }

  function linkCard(l) {
    const el = document.createElement('div');
    el.className = 'link-card';
    const fromMeta = window.CURRENCIES[l.source_currency] || { symbol: '', name: l.source_currency };
    const payCount = (state.paymentsByLink[l.id] || []).length;
    const hasCustom = Boolean(state.bankByLink[l.id]);
    const hasBank = hasCustom || Boolean(state.defaultBank);
    const url = `${location.origin}/pay.html?slug=${l.slug}`;
    const bankTag = hasBank
      ? (hasCustom ? '' : ' · <span class="text-secondary">default account</span>')
      : ' · <span class="text-secondary">no bank details</span>';
    el.innerHTML = `
      <h3>${esc(l.title)}</h3>
      <div class="meta">/${l.slug} · ${fromMeta.symbol} ${l.source_currency} → ${TARGET} · ${payCount} payment(s)${bankTag}</div>
      <div class="link-url" id="url-${l.id}">${url}</div>
      <div class="actions">
        <button class="btn-hero-outline link-act" data-act="copy" style="color:var(--primary);border:1px solid var(--primary);">Copy link</button>
        <button class="btn-primary link-act" data-act="open">Manage</button>
        <button class="btn-hero-outline link-act" data-act="delete" style="color:var(--secondary);border:1px solid var(--secondary);">Delete</button>
      </div>`;
    el.querySelector('[data-act="copy"]').addEventListener('click', () => {
      navigator.clipboard.writeText(url); const b = el.querySelector('[data-act="copy"]'); b.textContent = 'Copied!'; setTimeout(() => (b.textContent = 'Copy link'), 1500);
    });
    el.querySelector('[data-act="open"]').addEventListener('click', () => openManageModal(l));
    el.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${l.title}"? Customers using it will no longer be able to pay.`)) return;
      await sb.from('payment_links').delete().eq('id', l.id);
      loadAll();
    });
    return el;
  }

  /* ---------- create modal ---------- */

  function openCreateModal() {
    const m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = `
      <div class="modal">
        <h2>New payment link</h2>
        <p class="sub">Set the currency your customer pays in. They'll see the CAD equivalent at checkout.</p>
        <form id="create-form">
          <div class="form-group"><label>Title *</label><input name="title" required placeholder="Consultation fee — John Doe"></div>
          <div class="form-group"><label>Link slug (optional)</label><input name="slug" placeholder="e.g. test  →  pay.html?slug=test">
            <p class="small text-muted">Used in the payment URL. Leave blank to auto-generate. Letters, numbers and dashes only.</p></div>
          <div class="form-group" style="position:relative;"><label>Customer pays in</label>
            <input type="text" id="cur-search" placeholder="Search currency or country (e.g. Nigeria, Naira, NGN)" autocomplete="off">
            <input type="hidden" name="source_currency" id="cur-value">
            <div class="cur-list hidden" id="cur-list"></div>
            <p id="cur-selected" class="small text-muted"></p>
          </div>
          <div class="form-group" id="rate-group">
            <label>Exchange rate (1 CAD = ?)</label>
            <p class="small text-muted" id="rate-live"></p>
            <div class="flex gap-2" style="align-items:center;">
              <span>1 CAD =</span>
              <input type="number" name="rate_override" id="rate-override" step="any" inputmode="decimal" placeholder="live" style="max-width:170px;">
              <span id="rate-code" class="text-muted"></span>
            </div>
            <p class="small text-secondary" id="rate-markup"></p>
          </div>
          <p id="create-err" class="text-secondary small hidden"></p>
          <div class="flex gap-2 mt-2" style="justify-content:flex-end;">
            <button type="button" class="btn-hero-outline" id="cancel" style="color:var(--primary);border:1px solid var(--primary);">Cancel</button>
            <button type="submit" class="btn-primary">Create link</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(m);

    // ---- searchable currency picker ----
    const curSearch = m.querySelector('#cur-search');
    const curList = m.querySelector('#cur-list');
    const curValue = m.querySelector('#cur-value');
    const curSelected = m.querySelector('#cur-selected');

    function renderCurList(q) {
      q = (q || '').trim().toLowerCase();
      const opts = Object.keys(window.CURRENCIES)
        .filter((c) => c !== TARGET)
        .filter((c) => {
          if (!q) return true;
          const m0 = window.CURRENCIES[c];
          return c.toLowerCase().includes(q) ||
            (m0.name || '').toLowerCase().includes(q) ||
            (m0.country || '').toLowerCase().includes(q);
        })
        .slice(0, 60);
      if (!opts.length) {
        curList.innerHTML = '<div class="cur-empty">No currency found</div>';
      } else {
        curList.innerHTML = opts.map((c) => {
          const m0 = window.CURRENCIES[c];
          return `<div class="cur-opt" data-code="${c}"><span class="cur-sym">${m0.symbol}</span><span class="cur-code">${c}</span><span class="cur-name">${esc(m0.name)}</span></div>`;
        }).join('');
        curList.querySelectorAll('.cur-opt').forEach((el) =>
          el.addEventListener('click', () => {
            const code = el.dataset.code;
            curValue.value = code;
            const m0 = window.CURRENCIES[code];
            curSearch.value = `${m0.symbol} ${code} — ${m0.name}`;
            curSelected.textContent = `Selected: ${code} (${m0.name})`;
            curList.classList.add('hidden');
            updateRateUI(code);
          })
        );
      }
      curList.classList.remove('hidden');
    }

    // ---- rate editor (live rate + admin override + markup) ----
    const rateLive = m.querySelector('#rate-live');
    const rateOverride = m.querySelector('#rate-override');
    const rateCode = m.querySelector('#rate-code');
    const rateMarkup = m.querySelector('#rate-markup');
    let livePerCad = null;
    const round4 = (n) => Math.round(n * 1e4) / 1e4;

    function recalcMarkup() {
      const v = parseFloat(rateOverride.value);
      if (!v || !livePerCad) { rateMarkup.textContent = ''; return; }
      const pct = (v - livePerCad) / livePerCad * 100;
      if (Math.abs(pct) < 0.005) rateMarkup.textContent = 'Same as live market rate';
      else rateMarkup.textContent = `Markup vs live: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }

    async function updateRateUI(code) {
      rateCode.textContent = code;
      try {
        const live = await window.getFxRate(code, TARGET); // CAD per 1 source
        livePerCad = 1 / live; // source per 1 CAD
        rateLive.textContent = `Live market rate: 1 CAD ≈ ${livePerCad.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${code}`;
      } catch {
        livePerCad = null;
        rateLive.textContent = 'Could not fetch the live rate — enter your rate manually.';
      }
      // Always reset the editable field to the new live rate when the
      // currency changes — the old value was for a different currency.
      // Leaving it untouched = "use live" (the submit handler treats a
      // value matching live as no override).
      rateOverride.value = livePerCad != null ? round4(livePerCad) : '';
      recalcMarkup();
    }

    function selectDefaultCur() {
      const first = Object.keys(window.CURRENCIES).filter((c) => c !== TARGET)[0];
      if (first) {
        curValue.value = first;
        const m0 = window.CURRENCIES[first];
        curSearch.value = `${m0.symbol} ${first} — ${m0.name}`;
        curSelected.textContent = `Selected: ${first} (${m0.name})`;
        updateRateUI(first);
      }
    }

    curSearch.addEventListener('focus', () => renderCurList(curSearch.value));
    curSearch.addEventListener('input', () => renderCurList(curSearch.value));
    curSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = curList.querySelector('.cur-opt');
        if (first) first.click();
      }
    });
    // hide on blur (small delay so a click on an option still registers)
    curSearch.addEventListener('blur', () => setTimeout(() => curList.classList.add('hidden'), 150));
    rateOverride.addEventListener('input', recalcMarkup);
    selectDefaultCur();
    m.querySelector('#cancel').addEventListener('click', () => m.remove());
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    m.querySelector('#create-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const title = fd.get('title').toString().trim();
      const overrideRaw = (fd.get('rate_override') || '').toString().trim();
      let override = overrideRaw ? parseFloat(overrideRaw) : null;
      let markup = null;
      // A value equal to the live rate is treated as "use live" (no fixed lock).
      if (override != null && livePerCad && Math.abs(override - livePerCad) / livePerCad < 1e-4) override = null;
      if (override != null && livePerCad) markup = (override - livePerCad) / livePerCad * 100;
      // Slug: use the admin's manual value if supplied, otherwise auto-generate.
      const genSlug = () => Math.random().toString(36).slice(2, 10).toLowerCase();
      const slugRaw = fd.get('slug').toString().trim();
      let slug;
      if (slugRaw) {
        slug = slugify(slugRaw);
        if (!slug) {
          m.querySelector('#create-err').textContent = 'Slug must contain at least one letter or number.';
          m.querySelector('#create-err').classList.remove('hidden');
          return;
        }
      } else {
        slug = genSlug();
      }

      const insertPayload = () => ({
        slug, title,
        source_currency: fd.get('source_currency').toString(),
        target_currency: TARGET,
        rate_override: override,
        rate_markup_pct: markup,
      });

      let res = await sb.from('payment_links').insert(insertPayload());

      // A manual slug that collides must NOT be silently overwritten — tell the
      // admin so they can pick a different one.
      if (res.error && /duplicate|23505/i.test(res.error.message || '') && slugRaw) {
        m.querySelector('#create-err').textContent = `The slug "${slug}" is already in use. Please choose a different one.`;
        m.querySelector('#create-err').classList.remove('hidden');
        return;
      }

      // Auto-generated slugs just retry on the rare collision.
      let attempts = 0;
      while (res.error && /duplicate|23505/i.test(res.error.message || '') && attempts < 4) {
        slug = genSlug();
        res = await sb.from('payment_links').insert(insertPayload());
        attempts++;
      }

      const error = res.error;
      if (error) { m.querySelector('#create-err').textContent = error.message; m.querySelector('#create-err').classList.remove('hidden'); return; }
      m.remove(); loadAll();
    });
  }

  /* ---------- manage modal (bank details + payments) ---------- */

  function openManageModal(link) {
    const m = document.createElement('div');
    m.className = 'modal-backdrop';
    const bank = state.bankByLink[link.id] || null;
    const payments = state.paymentsByLink[link.id] || [];
    m.innerHTML = `
      <div class="modal">
        <div class="flex justify-between items-center">
          <h2>${esc(link.title)}</h2>
          <button id="close" class="btn-hero-outline" style="color:var(--primary);border:1px solid var(--primary);">Close</button>
        </div>
        <p class="sub">/pay.html?slug=${esc(link.slug)}</p>
        <h3 style="color:var(--primary);margin:1rem 0 .5rem;">Exchange rate</h3>
        <p class="text-muted small">Fixed rate for this link. Leave blank to use the live market rate. The customer pays using this rate.</p>
        <div class="rate-box">
          <div class="flex gap-2" style="align-items:center;">
            <span style="font-weight:600;">1 ${TARGET} =</span>
            <input type="number" name="rate_override" id="m-rate" step="any" value="${link.rate_override != null ? link.rate_override : ''}" placeholder="live" style="max-width:170px;">
            <span class="text-muted">${esc(link.source_currency)}</span>
          </div>
          <p class="small text-muted" id="m-live" style="margin:.6rem 0 0;"></p>
          <p class="small" id="m-markup" style="margin:.3rem 0 0;"></p>
        </div>
        <h3 style="color:var(--primary);margin:1.5rem 0 .5rem;">Bank transfer details</h3>
        <p class="text-muted small">Customers see these when they pick "pay with bank transfer".</p>
        <form id="bank-form" class="mt-2">
          <div class="flex gap-2"><div class="form-group" style="flex:1"><label>Bank name *</label><input name="bank_name" value="${esc(bank?.bank_name)}" required></div>
          <div class="form-group" style="flex:1"><label>Account name *</label><input name="account_name" value="${esc(bank?.account_name)}" required></div></div>
          <div class="form-group"><label>Account number *</label><input name="account_number" value="${esc(bank?.account_number)}" required></div>
          <div class="flex gap-2"><div class="form-group" style="flex:1"><label>Routing number</label><input name="routing_number" value="${esc(bank?.routing_number)}"></div>
          <div class="form-group" style="flex:1"><label>Sort code</label><input name="sort_code" value="${esc(bank?.sort_code)}"></div>
          <div class="form-group" style="flex:1"><label>SWIFT / BIC</label><input name="swift_code" value="${esc(bank?.swift_code)}"></div></div>
          <div class="form-group"><label>Bank address</label><input name="bank_address" value="${esc(bank?.bank_address)}"></div>
          <div class="form-group"><label>Instructions for the customer</label><textarea name="instructions" placeholder="Use the reference number from your order as the memo.">${esc(bank?.instructions)}</textarea></div>
          <p id="bank-err" class="text-secondary small hidden"></p>
          <p id="bank-ok" class="small hidden" style="color:#2e7d32;font-weight:600;margin:.4rem 0 0;">✓ Saved</p>
          <div class="flex gap-2 mt-2" style="align-items:center;">
            <button type="submit" class="btn-primary">Save bank details</button>
            ${bank ? '<button type="button" class="btn-hero-outline" id="use-default" style="color:var(--secondary);border:1px solid var(--secondary);">Use default instead</button>' : ''}
          </div>
        </form>
        <h3 style="color:var(--primary);margin:1.5rem 0 .5rem;">Payments received (${payments.length})</h3>
        <div id="pay-list">${payments.length ? payments.map(payRow).join('') : '<p class="text-muted small">No payments yet.</p>'}</div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('#close').addEventListener('click', () => m.remove());
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });

    // live markup readout for the rate field
    const mRate = m.querySelector('#m-rate');
    const mMarkup = m.querySelector('#m-markup');
    const mLiveEl = m.querySelector('#m-live');
    let mLive = null;
    (async () => {
      try {
        const live = await window.getFxRate(link.source_currency, TARGET); // CAD per 1 source
        mLive = 1 / live; // source per 1 CAD
        mLiveEl.textContent = `Live market rate: 1 ${TARGET} ≈ ${mLive.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${link.source_currency}`;
      } catch {
        mLive = null;
        mLiveEl.textContent = 'Live market rate unavailable — enter your rate manually.';
      }
      recalcM();
    })();
    function recalcM() {
      const v = parseFloat(mRate.value);
      if (!v) { mMarkup.textContent = ''; mMarkup.className = 'small'; return; }
      if (!mLive) { mMarkup.textContent = 'Enter a fixed rate above to lock it in.'; mMarkup.className = 'small text-muted'; return; }
      const pct = (v - mLive) / mLive * 100;
      if (Math.abs(pct) < 0.005) {
        mMarkup.textContent = 'Same as live market rate — no markup.';
        mMarkup.className = 'small text-muted';
      } else {
        mMarkup.textContent = `Markup vs live: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        mMarkup.className = `small ${pct >= 0 ? 'rate-up' : 'rate-down'}`;
      }
    }
    mRate.addEventListener('input', recalcM);

    // hidden status lines for the bank form
    const bankErr = m.querySelector('#bank-err');
    const bankOk = m.querySelector('#bank-ok');
    bankErr.classList.add('hidden');
    bankOk.classList.add('hidden');

    m.querySelector('#bank-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        link_id: link.id,
        bank_name: fd.get('bank_name').toString().trim(),
        account_name: fd.get('account_name').toString().trim(),
        account_number: fd.get('account_number').toString().trim(),
        routing_number: fd.get('routing_number').toString().trim() || null,
        sort_code: fd.get('sort_code').toString().trim() || null,
        swift_code: fd.get('swift_code').toString().trim() || null,
        bank_address: fd.get('bank_address').toString().trim() || null,
        instructions: fd.get('instructions').toString().trim() || null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from('bank_details').upsert(payload, { onConflict: 'link_id' });
      if (error) { bankErr.textContent = error.message; bankErr.classList.remove('hidden'); return; }
      // The rate input sits OUTSIDE the bank-form, so read it from the DOM
      // directly. Reading it from FormData would return null and crash.
      const rRaw = (mRate.value || '').toString().trim();
      let rOverride = rRaw ? parseFloat(rRaw) : null;
      if (rOverride != null && mLive && Math.abs(rOverride - mLive) / mLive < 1e-4) rOverride = null;
      const rMarkup = (rOverride != null && mLive) ? (rOverride - mLive) / mLive * 100 : null;
      const { error: rerr } = await sb.from('payment_links').update({ rate_override: rOverride, rate_markup_pct: rMarkup }).eq('id', link.id);
      if (rerr) { bankErr.textContent = rerr.message; bankErr.classList.remove('hidden'); return; }
      bankOk.classList.remove('hidden');
      setTimeout(() => bankOk.classList.add('hidden'), 2500);
      loadAll();
    });
    const useDefaultBtn = m.querySelector('#use-default');
    if (useDefaultBtn) {
      useDefaultBtn.addEventListener('click', async () => {
        if (!confirm('Stop using a custom account for this link and fall back to the default bank details?')) return;
        await sb.from('bank_details').delete().eq('link_id', link.id);
        loadAll();
        m.remove();
      });
    }
  }

  /* ---------- default bank details (global) ---------- */

  function openDefaultBankModal() {
    const m = document.createElement('div');
    m.className = 'modal-backdrop';
    const bank = state.defaultBank || null;
    m.innerHTML = `
      <div class="modal">
        <div class="flex justify-between items-center">
          <h2>Default bank details</h2>
          <button id="close" class="btn-hero-outline" style="color:var(--primary);border:1px solid var(--primary);">Close</button>
        </div>
        <p class="sub">These details are shown on every payment link that has no custom bank account set in "Manage".</p>
        <form id="default-bank-form" class="mt-2">
          <div class="flex gap-2"><div class="form-group" style="flex:1"><label>Bank name *</label><input name="bank_name" value="${esc(bank?.bank_name)}" required></div>
          <div class="form-group" style="flex:1"><label>Account name *</label><input name="account_name" value="${esc(bank?.account_name)}" required></div></div>
          <div class="form-group"><label>Account number *</label><input name="account_number" value="${esc(bank?.account_number)}" required></div>
          <div class="flex gap-2"><div class="form-group" style="flex:1"><label>Routing number</label><input name="routing_number" value="${esc(bank?.routing_number)}"></div>
          <div class="form-group" style="flex:1"><label>Sort code</label><input name="sort_code" value="${esc(bank?.sort_code)}"></div>
          <div class="form-group" style="flex:1"><label>SWIFT / BIC</label><input name="swift_code" value="${esc(bank?.swift_code)}"></div></div>
          <div class="form-group"><label>Bank address</label><input name="bank_address" value="${esc(bank?.bank_address)}"></div>
          <div class="form-group"><label>Instructions for the customer</label><textarea name="instructions" placeholder="Use the reference number from your order as the memo.">${esc(bank?.instructions)}</textarea></div>
          <p id="default-err" class="text-secondary small hidden"></p>
          <button type="submit" class="btn-primary" style="margin-top:.5rem;">Save default bank details</button>
        </form>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('#close').addEventListener('click', () => m.remove());
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    m.querySelector('#default-bank-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        id: 'default',
        bank_name: fd.get('bank_name').toString().trim(),
        account_name: fd.get('account_name').toString().trim(),
        account_number: fd.get('account_number').toString().trim(),
        routing_number: fd.get('routing_number').toString().trim() || null,
        sort_code: fd.get('sort_code').toString().trim() || null,
        swift_code: fd.get('swift_code').toString().trim() || null,
        bank_address: fd.get('bank_address').toString().trim() || null,
        instructions: fd.get('instructions').toString().trim() || null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from('default_bank_details').upsert(payload, { onConflict: 'id' });
      if (error) { m.querySelector('#default-err').textContent = error.message; m.querySelector('#default-err').classList.remove('hidden'); return; }
      loadAll();
      m.remove();
    });
  }

  function payRow(p) {
    const badge = `<span class="badge ${p.status}">${p.status}</span>`;
    const receipt = p.receipt_url ? `<a href="${esc(p.receipt_url)}" target="_blank" class="text-secondary small">View receipt</a>` : '';
    return `<div class="pay-row">
      <div><strong>${esc(p.customer_name)}</strong><div class="text-muted small">${esc(p.customer_email)} · ${esc(p.customer_phone)}</div>
      <div class="small">${window.formatMoney(p.amount_source, p.source_currency)} ${p.source_currency} → ${window.formatMoney(p.amount_target, p.target_currency)} ${p.target_currency}</div></div>
      <div style="text-align:right;">${badge}<div>${receipt}</div></div>
    </div>`;
  }

  /* ---------- bootstrap ---------- */

  function start() {
    const { createClient } = window.supabase;
    TARGET = window.TARGET_CURRENCY;
    try {
      // Admin uses the service-role key so it can create/edit/delete rows (RLS
      // blocks the anon key from admin ops). Gated by ADMIN_PASSWORD in the UI.
      sb = createClient(PAYLINK_CONFIG.SUPABASE_URL, PAYLINK_CONFIG.SUPABASE_SERVICE_ROLE_KEY);
    } catch (e) {
      fatal('Could not create Supabase client: ' + (e.message || e));
      return;
    }

    if (!window.isPaylinkConfigured()) {
      renderSetupNeeded();
      return;
    }
    if (sessionStorage.getItem('paylink_admin') === '1') {
      loadAll();
    } else {
      renderLogin();
    }
  }

  if (!window.__supabaseReady) {
    fatal('Supabase loader did not initialise. Check the loader <script> in the <head> of admin.html.');
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
