/* =====================================================================
   pay.js — client payment flow for /pay.html?slug=XXXX
   Steps: 1) details  2) amount + live FX  3) method  4) bank + timer + receipt
   ===================================================================== */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const loadingEl = $('#pay-loading');
  const errorEl = $('#pay-error');
  const appEl = $('#pay-app');

  // Supabase client is created in start(), AFTER the CDN library has loaded
  // (see window.__supabaseReady at the bottom). This avoids the race where the
  // async CDN <script> hadn't finished when this file executed synchronously.
  let sb;

  const state = {
    step: 1,
    link: null,
    bank: null,
    customer: { name: '', email: '', phone: '', address: '' },
    amount: '300',
    cad: null,
    rate: null,
    timerEndsAt: null,
  };

  const TARGET = window.TARGET_CURRENCY; // CAD

  /* ---------- persistence across reloads ----------
     FORM_KEY  : customer + amount + step while the user is still filling the
                 form (steps 1-3). 10-minute TTL, refreshed on every render so
                 it only expires after 10 min of *inactivity* since the last
                 step change.
     BANK_KEY  : everything needed for the bank step (customer, amount, cad,
                 rate) PLUS the 60-minute deadline. Set the moment the user
                 reaches the bank step and cleared when the timer ends, when
                 the payment is done, or when they hit Cancel. */
  let FORM_KEY = null, BANK_KEY = null;
  const FORM_TTL_MS = 10 * 60 * 1000;

  function setPersistKeys(slug) {
    FORM_KEY = 'paylink:form:' + slug;
    BANK_KEY = 'paylink:bank:' + slug;
  }

  function loadFormPersist() {
    try {
      const raw = localStorage.getItem(FORM_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d.expiresAt || d.expiresAt <= Date.now()) { localStorage.removeItem(FORM_KEY); return null; }
      return d;
    } catch { try { localStorage.removeItem(FORM_KEY); } catch {} return null; }
  }

  function saveFormPersist() {
    if (state.step > 3) return; // only for pre-bank steps
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify({
        step: state.step,
        customer: state.customer,
        amount: state.amount,
        expiresAt: Date.now() + FORM_TTL_MS,
      }));
    } catch {}
  }

  function clearFormPersist() { try { localStorage.removeItem(FORM_KEY); } catch {} }

  function loadBankPersist() {
    try {
      const raw = localStorage.getItem(BANK_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d.timerEndsAt || d.timerEndsAt <= Date.now()) { localStorage.removeItem(BANK_KEY); return null; }
      return d;
    } catch { try { localStorage.removeItem(BANK_KEY); } catch {} return null; }
  }

  function saveBankPersist() {
    try {
      localStorage.setItem(BANK_KEY, JSON.stringify({
        timerEndsAt: state.timerEndsAt,
        customer: state.customer,
        amount: state.amount,
        cad: state.cad,
        rate: state.rate,
      }));
    } catch {}
  }

  function clearBankPersist() { try { localStorage.removeItem(BANK_KEY); } catch {} }
  function clearAllPersist() { clearFormPersist(); clearBankPersist(); }

  // Abandon the whole payment: wipe any saved progress and leave for home.
  // Used by the Cancel button (form steps) and Cancel payment button (bank step).
  function cancelPayment() {
    clearAllPersist();
    location.href = 'index.html';
  }

  function showError(msg) {
    loadingEl.classList.add('hidden');
    appEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    errorEl.innerHTML = `<h2 class="pay-step-title">Payment link unavailable</h2><p class="text-muted">${msg}</p>
      <a href="index.html" class="btn-primary mt-2" style="display:inline-block;">Back to home</a>`;
  }

  async function init() {
    const slug = new URLSearchParams(location.search).get('slug');
    if (!slug) return showError('No payment link specified in the URL.');
    setPersistKeys(slug);

    if (!window.isPaylinkConfigured()) {
      return showError('This payment system is not configured yet. The site administrator needs to connect Supabase (see js/config.js and README.md).');
    }

    try {
      const { data: link, error } = await sb
        .from('payment_links')
        .select('*')
        .eq('slug', slug)
        .eq('active', true)
        .maybeSingle();

      if (error || !link) return showError('This payment link is invalid or has been disabled.');

      state.link = link;
      const { data: bank } = await sb
        .from('bank_details')
        .select('*')
        .eq('link_id', link.id)
        .maybeSingle();
      if (bank) {
        state.bank = bank;
        state.bankIsDefault = false;
      } else {
        // No per-link bank details -> fall back to the global default account.
        const { data: def } = await sb
          .from('default_bank_details')
          .select('*')
          .eq('id', 'default')
          .maybeSingle();
        state.bank = def || null;
        state.bankIsDefault = Boolean(def);
      }

      loadingEl.classList.add('hidden');
      appEl.classList.remove('hidden');

      // ---- restore an in-progress payment from a previous (re)load ----
      const bankPersist = loadBankPersist();
      if (bankPersist) {
        // Mid bank step: resume the 60-minute timer with whatever time was left.
        state.customer = bankPersist.customer || state.customer;
        state.amount = bankPersist.amount != null ? bankPersist.amount : state.amount;
        state.cad = bankPersist.cad != null ? bankPersist.cad : null;
        state.rate = bankPersist.rate != null ? bankPersist.rate : null;
        state.timerEndsAt = bankPersist.timerEndsAt;
        state.step = 4;
        render();
        return;
      }
      const formPersist = loadFormPersist();
      if (formPersist) {
        // Still filling the form: jump back to the exact step with their details.
        state.step = Math.min(Math.max(formPersist.step || 1, 1), 3);
        state.customer = formPersist.customer || state.customer;
        state.amount = formPersist.amount != null ? formPersist.amount : state.amount;
      }
      render();
    } catch (e) {
      showError('Could not reach the payment service. Make sure the site is served over http:// and Supabase is connected. (' + (e && e.message ? e.message : e) + ')');
    }
  }

  /* ---------- rendering ---------- */

  function stepsIndicator() {
    const total = 4, active = Math.min(state.step, total);
    let html = '<div class="pay-steps">';
    for (let i = 1; i <= total; i++) html += `<span class="${i <= active ? 'active' : ''}"></span>`;
    return html + '</div>';
  }

  function render() {
    if (state.step === 1) return renderForm();
    if (state.step === 2) return renderConvert();
    if (state.step === 3) return renderMethod();
    if (state.step === 4) return renderBank();
    if (state.step === 5) return renderDone();
  }

  function renderForm() {
    appEl.innerHTML = `
      ${stepsIndicator()}
      <h2 class="pay-step-title">Your details</h2>
      <p class="pay-step-sub">We'll use these to confirm your payment.</p>
      <form id="f-form">
        <div class="form-group"><label>Full name *</label><input name="name" required value="${esc(state.customer.name)}" placeholder="Ada Lovelace"></div>
        <div class="form-group"><label>Email *</label><input name="email" type="email" required value="${esc(state.customer.email)}" placeholder="ada@example.com"></div>
        <div class="form-group"><label>Phone *</label><input name="phone" required value="${esc(state.customer.phone)}" placeholder="+1 555 1234"></div>
        <div class="form-group"><label>Address *</label><textarea name="address" required placeholder="221B Baker Street, London">${esc(state.customer.address)}</textarea></div>
        <button type="submit" class="btn-primary w-full" style="margin-top:1rem;">Continue</button>
      </form>
      <button class="pay-cancel" id="cancel-flow" type="button">Cancel payment</button>`;
    $('#f-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const email = fd.get('email').toString().trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return alert('Please enter a valid email.');
      state.customer = {
        name: fd.get('name').toString().trim(),
        email, phone: fd.get('phone').toString().trim(),
        address: fd.get('address').toString().trim(),
      };
      state.step = 2; render();
    });
    $('#cancel-flow').addEventListener('click', cancelPayment);
    saveFormPersist();
  }

  function renderConvert() {
    const from = state.link.source_currency;
    const fromMeta = window.CURRENCIES[from];
    // The "Title" the admin sets IS the full heading the customer sees.
    // (Previously we prepended "Send money to " which forced admins to type
    // only a short merchant name. Now they can type the complete headline.)
    appEl.innerHTML = `
      ${stepsIndicator()}
      <h2 class="pay-step-title">${esc(state.link.title) || 'Make a payment'}</h2>
      <p class="pay-step-sub">Enter the amount you'll send. We'll show the CAD equivalent.</p>
      <div class="converter">
        <div class="conv-row">
          <div class="conv-label">You pay</div>
          <div class="conv-line">
            <input id="amount" class="conv-amount" inputmode="decimal" value="${esc(state.amount)}" placeholder="0.00">
            <span class="conv-cur">${fromMeta.symbol} ${from}</span>
          </div>
        </div>
        <div class="conv-row">
          <div class="conv-label">We receive (fixed)</div>
          <div class="conv-line">
            <input id="cad" class="conv-amount" readonly value="${state.cad != null ? state.cad.toFixed(2) : ''}" placeholder="0.00">
            <span class="conv-cur">🇨🇦 ${TARGET}</span>
          </div>
        </div>
      </div>
      <p class="conv-rate" id="rate-line"></p>
      <button id="proceed" class="btn-primary w-full" disabled>Proceed</button>
      <button class="pay-cancel" id="cancel-flow" type="button">Cancel payment</button>`;

    const amt = $('#amount');
    const recalc = async () => {
      state.amount = amt.value; // persist what the customer typed (was stuck at default '300')
      saveFormPersist();
      const num = parseFloat(amt.value);
      if (!num || num <= 0) { state.cad = null; $('#cad').value = ''; $('#proceed').disabled = true; $('#rate-line').textContent = ''; return; }
      let cadPerSource, perCad;
      if (state.link.rate_override) {
        // Admin's fixed rate: how many SOURCE units equal 1 CAD.
        perCad = Number(state.link.rate_override);
        cadPerSource = 1 / perCad;
      } else {
        cadPerSource = await window.getFxRate(from, TARGET); // CAD per 1 source
        perCad = 1 / cadPerSource;
      }
      state.rate = cadPerSource; state.cad = num * cadPerSource;
      $('#cad').value = state.cad.toFixed(2);
      $('#rate-line').textContent = `Rate: 1 CAD = ${perCad.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${from}`;
      $('#proceed').disabled = false;
    };
    amt.addEventListener('input', recalc);
    $('#proceed').addEventListener('click', () => { state.step = 3; render(); });
    $('#cancel-flow').addEventListener('click', cancelPayment);
    recalc();
    saveFormPersist();
  }

  function renderMethod() {
    appEl.innerHTML = `
      ${stepsIndicator()}
      <h2 class="pay-step-title">How would you like to pay?</h2>
      <p class="pay-step-sub">Choose your preferred payment method.</p>
      <button class="method disabled" id="card" disabled>
        <span><span class="m-title">Pay with card</span><br><span class="m-sub">Visa, Mastercard, Amex</span></span>
        <span class="m-tag">Currently not available</span>
      </button>
      <button class="method" id="bank">
        <span><span class="m-title">Pay with bank transfer</span><br><span class="m-sub">Use your banking app or in-branch</span></span>
        <span style="color:var(--primary);font-size:1.4rem;">›</span>
      </button>
      <button class="pay-cancel" id="cancel-flow" type="button">Cancel payment</button>`;
    $('#card').addEventListener('click', () => alert('Card payments are currently not available. Please use bank transfer.'));
    $('#bank').addEventListener('click', () => {
      // Reaching the bank step: drop the 10-min form persistence and start a
      // fresh 60-minute timer (persisted so a reload mid-bank-step resumes it).
      clearFormPersist();
      state.timerEndsAt = Date.now() + 60 * 60 * 1000;
      saveBankPersist();
      state.step = 4; render();
    });
    $('#cancel-flow').addEventListener('click', cancelPayment);
    saveFormPersist();
  }

  function renderBank() {
    const b = state.bank;
    if (!b) {
      appEl.innerHTML = `<div class="pay-card"><h2 class="pay-step-title">Bank details missing</h2>
        <p class="text-muted">The merchant hasn't set up bank transfer details yet. Please contact them.</p></div>`;
      return;
    }
    const remaining = Math.max(0, state.timerEndsAt - Date.now());
    let secs = Math.floor(remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    const expired = remaining <= 0;

    const from = state.link.source_currency;
    const rows = [
      ['You send', `${window.formatMoney(state.amount, from)} (${from})`],
      ['You receive', `${window.formatMoney(state.cad, TARGET)} ${TARGET}`],
      ['Bank', b.bank_name],
      ['Account name', b.account_name],
      ['Account number', b.account_number],
    ];
    if (b.routing_number) rows.push(['Routing number', b.routing_number]);
    if (b.sort_code) rows.push(['Sort code', b.sort_code]);
    if (b.swift_code) rows.push(['SWIFT / BIC', b.swift_code]);
    if (b.bank_address) rows.push(['Bank address', b.bank_address]);

    appEl.innerHTML = `
      ${stepsIndicator()}
      <h2 class="pay-step-title">Complete your bank transfer</h2>
      <p class="pay-step-sub">Send the exact amount below, then upload your receipt.</p>
      <div class="bank-timer ${expired ? 'expired' : ''}" id="timer">
        <div class="t-label">Time left to pay</div>
        <div class="t-time">${mm}:${ss}</div>
      </div>
      <div class="bank-details">
        ${rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${esc(v)} <button class="copy-btn" data-copy="${esc(v)}">Copy</button></span></div>`).join('')}
      </div>
      ${b.instructions && String(b.instructions).trim() ? `<div class="bank-note">${esc(b.instructions)}</div>` : ''}
      <input type="file" id="receipt" accept="image/*,application/pdf" class="hidden">
      <div class="dropzone" id="dropzone">📄 Click to upload your payment receipt<br><small class="text-muted">JPG, PNG or PDF</small></div>
      <div id="upload-status" class="small text-muted mt-1"></div>
      <button class="pay-cancel" id="cancel-payment" type="button">Cancel payment</button>`;

    // copy buttons — flip to "Copied" for 1s so the customer knows it worked
    appEl.querySelectorAll('.copy-btn').forEach((btn) =>
      btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(btn.dataset.copy); } catch (e) { /* clipboard blocked — still flash feedback */ }
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1000);
      })
    );

    // timer countdown
    $('#cancel-payment').addEventListener('click', cancelPayment);
    if (!expired) {
      const timer = setInterval(() => {
        const rem = Math.max(0, state.timerEndsAt - Date.now());
        const s = Math.floor(rem / 1000);
        const tEl = $('#timer');
        tEl.querySelector('.t-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        if (rem <= 0) {
          clearInterval(timer);
          tEl.classList.add('expired');
          tEl.querySelector('.t-label').textContent = 'Expired';
          tEl.querySelector('.t-time').textContent = '00:00';
          // Time's up: wipe saved progress and send them back to the home page.
          clearAllPersist();
          setTimeout(() => { location.href = 'index.html'; }, 1800);
        }
      }, 1000);
    }

    // upload handling
    const fileInput = $('#receipt');
    const drop = $('#dropzone');
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      drop.classList.add('has-file');
      drop.innerHTML = `✅ ${esc(file.name)}`;
      $('#upload-status').textContent = 'Uploading…';
      try {
        const ext = file.name.split('.').pop();
        const path = `${state.link.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: upErr } = await sb.storage.from('receipts').upload(path, file);
        if (upErr) throw upErr;
        const { data } = sb.storage.from('receipts').getPublicUrl(path);
        const { error: insErr } = await sb.from('payments').insert({
          link_id: state.link.id,
          customer_name: state.customer.name,
          customer_email: state.customer.email,
          customer_phone: state.customer.phone,
          customer_address: state.customer.address,
          amount_source: parseFloat(state.amount),
          amount_target: state.cad,
          source_currency: from,
          target_currency: TARGET,
          fx_rate: state.rate,
          status: 'submitted',
          receipt_url: data.publicUrl,
        });
        if (insErr) throw insErr;
        // notify the business (Web3Forms -> info@tcpimmigration.ca)
        notifyBusinessEmail(
          location.origin + '/pay.html?slug=' + state.link.slug,
          data.publicUrl,
          from
        );
        clearAllPersist();
        state.step = 5; render();
      } catch (e) {
        drop.classList.remove('has-file');
        drop.innerHTML = '📄 Click to upload your payment receipt<br><small class="text-muted">JPG, PNG or PDF</small>';
        $('#upload-status').textContent = 'Upload failed: ' + (e.message || e);
      }
    });
  }

  function renderDone() {
    const from = state.link.source_currency;
    const fromMeta = window.CURRENCIES[from] || { symbol: '' };
    const firstName = (state.customer.name || '').split(' ')[0] || 'there';
    appEl.innerHTML = `
      <div class="pay-card pay-done">
        <div class="pay-done-icon" aria-hidden="true">✓</div>
        <h2 class="pay-done-title">Receipt received — thank you, ${esc(firstName)}!</h2>
        <p class="pay-done-sub">We've let our team know about your payment. Here's a quick summary of what you sent:</p>
        <div class="pay-summary">
          <div class="row"><span class="k">You sent</span><span class="v">${esc(fromMeta.symbol)} ${esc(state.amount)} ${esc(from)}</span></div>
          <div class="row"><span class="k">You receive</span><span class="v">${esc(state.cad.toFixed(2))} ${esc(TARGET)}</span></div>
          <div class="row"><span class="k">Payment for</span><span class="v">${esc(state.link.title)}</span></div>
        </div>
        <p class="pay-done-note">We'll verify your bank transfer and confirm by email as soon as possible. If you have any questions, just reply to that email.</p>
        <div class="pay-done-actions">
          <a href="index.html" class="btn-primary">Back to home</a>
        </div>
      </div>`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- business email notification (Web3Forms, same as booking form) ----------
     Fire-and-forget POST to Web3Forms with the same access_key the booking and
     contact forms on tcpimmigration.ca already use, so the receipt upload goes
     to the same inbox (info@tcpimmigration.ca). Failures here never block the
     customer from seeing the thank-you page. */
  function notifyBusinessEmail(paymentUrl, receiptUrl, fromCurrency) {
    try {
      const fd = new FormData();
      fd.append('access_key', '7afb6976-1c6e-4ea2-8bb5-639974156cef');
      fd.append('form_name', 'Payment Receipt Submitted');
      fd.append('subject', 'New payment receipt \u2014 ' + state.customer.name);
      fd.append('Payment link', paymentUrl);
      fd.append('Link title', state.link.title);
      fd.append('Customer name', state.customer.name);
      fd.append('Customer email', state.customer.email);
      fd.append('Customer phone', state.customer.phone);
      fd.append('Customer address', state.customer.address);
      fd.append('You send', state.amount + ' ' + fromCurrency);
      fd.append('You receive', state.cad.toFixed(2) + ' ' + TARGET);
      fd.append('FX rate (CAD per ' + fromCurrency + ')', String(state.rate));
      fd.append('Receipt', receiptUrl);
      fd.append('Submitted at', new Date().toISOString());
      fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        body: fd,
        headers: { 'Accept': 'application/json' },
      }).catch(function () { /* best-effort */ });
    } catch (e) { /* never let the email path break the flow */ }
  }

  /* ---------- bootstrap (waits for the Supabase CDN script) ---------- */

  function start() {
    if (!window.supabase) {
      loadingEl.classList.add('hidden');
      errorEl.classList.remove('hidden');
      errorEl.innerHTML = `<h2 class="pay-step-title">Payment page can't start</h2>
        <p>The Supabase library failed to load from the CDN (jsdelivr / unpkg). This is usually an ad-blocker, a corporate firewall, or a temporary CDN outage. Try disabling extensions or switching networks, then refresh.</p>
        <p class="small text-muted">Open the browser console (F12 → Console) for details.</p>`;
      return;
    }
    try {
      sb = window.supabase.createClient(PAYLINK_CONFIG.SUPABASE_URL, PAYLINK_CONFIG.SUPABASE_ANON_KEY);
    } catch (e) {
      loadingEl.classList.add('hidden');
      errorEl.classList.remove('hidden');
      errorEl.innerHTML = `<h2 class="pay-step-title">Payment page can't start</h2><p>${e.message || e}</p>`;
      return;
    }
    init();
  }

  if (!window.__supabaseReady) {
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    errorEl.innerHTML = `<h2 class="pay-step-title">Payment page can't start</h2><p>The Supabase loader did not initialise. Check the loader <script> in the &lt;head&gt; of pay.html.</p>`;
    return;
  }
  window.__supabaseReady
    .then(function () { start(); })
    .catch(function () {
      loadingEl.classList.add('hidden');
      errorEl.classList.remove('hidden');
      errorEl.innerHTML = `<h2 class="pay-step-title">Payment page can't start</h2>
        <p>The Supabase library could not be loaded from any CDN (jsdelivr or unpkg). This is usually an ad-blocker, a corporate firewall, or a temporary CDN outage. Try disabling extensions, switching networks, or using a different CDN.</p>
        <p class="small text-muted">Open the browser console (F12 → Console) for details.</p>`;
    });
})();
