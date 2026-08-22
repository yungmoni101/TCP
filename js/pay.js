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
    crypto: null,
    cryptoIsDefault: false,
    method: null, // 'bank' | 'crypto' — which step-4 flow the customer chose
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
        method: state.method,
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

      // Crypto (Binance): per-link override, else the global default.
      const { data: crypto } = await sb
        .from('crypto_details')
        .select('*')
        .eq('link_id', link.id)
        .maybeSingle();
      if (crypto) {
        state.crypto = crypto;
        state.cryptoIsDefault = false;
      } else {
        const { data: cDef } = await sb
          .from('default_crypto_details')
          .select('*')
          .eq('id', 'default')
          .maybeSingle();
        state.crypto = cDef || null;
        state.cryptoIsDefault = Boolean(cDef);
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
        // Resume the previously chosen method, but only if this link still
        // offers it; otherwise fall back to the first enabled method.
        const avail = (state.link.methods && state.link.methods.length) ? state.link.methods : ['crypto', 'bank'];
        state.method = (bankPersist.method && avail.includes(bankPersist.method)) ? bankPersist.method : (avail[0] || 'bank');
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
    if (state.step === 4) return state.method === 'crypto' ? renderCrypto() : renderBank();
    if (state.step === 5) return renderDone();
  }

  function renderForm() {
    appEl.innerHTML = `
      ${stepsIndicator()}
      <h2 class="pay-step-title">Your details</h2>
      <p class="pay-step-sub">Enter your full name as shown on your passport or official documents.</p>
      <form id="f-form">
        <div class="form-group"><label>Full name</label><input name="name" required value="${esc(state.customer.name)}" placeholder="Ada Lovelace"></div>
        <button type="submit" class="btn-primary w-full" style="margin-top:1rem;">Continue</button>
      </form>
      <button class="pay-cancel" id="cancel-flow" type="button">Cancel payment</button>`;
    $('#f-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      // Only the full name is collected from the client. Email, phone and
      // address are intentionally left empty so the existing DB insert and
      // notification code paths keep working without any schema change.
      state.customer = {
        name: fd.get('name').toString().trim(),
        email: '', phone: '', address: '',
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
    // Only show the methods this link actually offers. Falls back to bank if
    // (somehow) nothing is enabled, so the customer is never stuck with no option.
    let methods = (state.link.methods && state.link.methods.length) ? state.link.methods : ['crypto', 'bank'];
    if (!methods.includes('crypto') && !methods.includes('card') && !methods.includes('bank')) methods = ['bank'];
    const show = (m) => methods.includes(m);
    appEl.innerHTML = `
      ${stepsIndicator()}
      <h2 class="pay-step-title">How would you like to pay?</h2>
      <p class="pay-step-sub">Choose your preferred payment method.</p>
      ${show('crypto') ? `<button class="method" id="crypto">
        <span><span class="m-title">Pay with Crypto</span><br><span class="m-sub">Binance · TRC20 / BEP20</span></span>
        <span style="color:var(--primary);font-size:1.4rem;">›</span>
      </button>` : ''}
      ${show('card') ? `<button class="method disabled" id="card" disabled>
        <span><span class="m-title">Pay with card</span><br><span class="m-sub">Visa, Mastercard, Amex</span></span>
        <span class="m-tag">Currently not available</span>
      </button>` : ''}
      ${show('bank') ? `<button class="method" id="bank">
        <span><span class="m-title">Bank Transfer</span><br><span class="m-sub">Use your banking app or in-branch</span></span>
        <span style="color:var(--primary);font-size:1.4rem;">›</span>
      </button>` : ''}
      <button class="pay-cancel" id="cancel-flow" type="button">Cancel payment</button>`;
    const cryptoBtn = $('#crypto');
    if (cryptoBtn) {
      cryptoBtn.addEventListener('click', () => {
        // Reaching the crypto step: drop the 10-min form persistence and start a
        // fresh 60-minute timer (persisted so a reload mid-step resumes it).
        clearFormPersist();
        state.method = 'crypto';
        state.timerEndsAt = Date.now() + 60 * 60 * 1000;
        saveBankPersist();
        state.step = 4; render();
      });
    }
    const bankBtn = $('#bank');
    if (bankBtn) {
      bankBtn.addEventListener('click', () => {
        // Reaching the bank step: drop the 10-min form persistence and start a
        // fresh 60-minute timer (persisted so a reload mid-bank-step resumes it).
        clearFormPersist();
        state.method = 'bank';
        state.timerEndsAt = Date.now() + 60 * 60 * 1000;
        saveBankPersist();
        state.step = 4; render();
      });
    }
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
      ['We receive', `${window.formatMoney(state.cad, TARGET)} ${TARGET}`],
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

  function renderCrypto() {
    const c = state.crypto;
    // Missing if there's no row at all, or the row has no usable destination
    // (neither a Binance ID nor any wallet address configured).
    if (!c || (!c.binance_id && !c.trc20_address && !c.bep20_address)) {
      appEl.innerHTML = `<div class="pay-card"><h2 class="pay-step-title">Crypto details missing</h2>
        <p class="text-muted">The merchant hasn't set up crypto payment yet. Please choose another method.</p>
        <button class="btn-primary w-full" id="back-method" style="margin-top:1rem;">Choose another method</button></div>`;
      $('#back-method').addEventListener('click', () => { state.step = 3; render(); });
      return;
    }
    const remaining = Math.max(0, state.timerEndsAt - Date.now());
    let secs = Math.floor(remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    const expired = remaining <= 0;
    const from = state.link.source_currency;

    let network = c.trc20_address ? 'trc20' : 'bep20';
    const addrFor = (n) => (n === 'trc20' ? (c.trc20_address || '') : (c.bep20_address || ''));
    const hasBinance = Boolean(c.binance_id);
    const hasWallet = Boolean(c.trc20_address || c.bep20_address);
    // Default to Binance ID when it's set; the wallet address is the fallback.
    let payMode = hasBinance ? 'binance' : 'wallet';
    const subText = (mode) => mode === 'binance'
      ? `Send the exact amount below to Binance ID ${esc(c.binance_id)}, then upload your receipt.`
      : `Send the exact amount below to the ${esc(network.toUpperCase())} wallet, then upload your receipt.`;

    appEl.innerHTML = `
      ${stepsIndicator()}
      <h2 class="pay-step-title">Complete your crypto payment</h2>
      <p class="pay-step-sub" id="crypto-sub">${subText(payMode)}</p>
      <div class="bank-timer ${expired ? 'expired' : ''}" id="timer">
        <div class="t-label">Time left to pay</div>
        <div class="t-time">${mm}:${ss}</div>
      </div>
      <div class="bank-details">
        <div class="row"><span class="k">You send</span><span class="v">${esc(window.formatMoney(state.amount, from))} ${esc(from)}</span></div>
        <div class="row"><span class="k">We receive</span><span class="v">${esc((state.cad ?? 0).toFixed(2))} ${esc(TARGET)}</span></div>
      </div>
      ${hasBinance && hasWallet ? `<div class="net-toggle" id="pay-mode">
        <button type="button" data-mode="binance" class="net-btn ${payMode === 'binance' ? 'active' : ''}">Pay to Binance ID</button>
        <button type="button" data-mode="wallet" class="net-btn ${payMode === 'wallet' ? 'active' : ''}">Pay to wallet address</button>
      </div>` : ''}
      <div class="bank-details" id="binance-box" ${payMode === 'binance' ? '' : 'style="display:none;"'}>
        <div class="row"><span class="k">Binance ID</span><span class="v">${esc(c.binance_id)} <button class="copy-btn" data-copy="${esc(c.binance_id)}">Copy</button></span></div>
        <div class="row"><span class="k">How to pay</span><span class="v">Send via Binance to the ID above.</span></div>
      </div>
      <div id="wallet-box" ${payMode === 'wallet' ? '' : 'style="display:none;"'}>
        <div class="net-toggle" id="net-toggle">
          <button type="button" data-net="trc20" class="net-btn ${network === 'trc20' ? 'active' : ''}">TRC20</button>
          <button type="button" data-net="bep20" class="net-btn ${network === 'bep20' ? 'active' : ''}">BEP20</button>
        </div>
        <div class="bank-details">
          <div class="row"><span class="k">Network</span><span class="v" id="wallet-net">${esc(network.toUpperCase())}</span></div>
          <div class="row"><span class="k">Wallet address</span><span class="v"><span id="wallet-addr">${esc(addrFor(network))}</span> <button class="copy-btn" id="copy-wallet" data-copy="${esc(addrFor(network))}">Copy</button></span></div>
        </div>
      </div>
      ${c.instructions && String(c.instructions).trim() ? `<div class="bank-note">${esc(c.instructions)}</div>` : ''}
      <input type="file" id="receipt" accept="image/*,application/pdf" class="hidden">
      <div class="dropzone" id="dropzone">📄 Click to upload your payment receipt<br><small class="text-muted">JPG, PNG or PDF</small></div>
      <div id="upload-status" class="small text-muted mt-1"></div>
      <button class="pay-cancel" id="cancel-payment" type="button">Cancel payment</button>`;

    // pay-mode sub-toggle: Binance ID vs wallet address
    const binanceBox = appEl.querySelector('#binance-box');
    const walletBox = appEl.querySelector('#wallet-box');
    const modeButtons = appEl.querySelectorAll('#pay-mode .net-btn');
    modeButtons.forEach((btn) =>
      btn.addEventListener('click', () => {
        payMode = btn.dataset.mode;
        modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === payMode));
        binanceBox.style.display = payMode === 'binance' ? '' : 'none';
        walletBox.style.display = payMode === 'wallet' ? '' : 'none';
        appEl.querySelector('#crypto-sub').textContent = subText(payMode);
      })
    );

    // network toggle (only relevant in wallet mode)
    const netButtons = appEl.querySelectorAll('#net-toggle .net-btn');
    const walletAddr = appEl.querySelector('#wallet-addr');
    const copyWallet = appEl.querySelector('#copy-wallet');
    const netNameSpan = walletBox.querySelector('#wallet-net');
    netButtons.forEach((btn) =>
      btn.addEventListener('click', () => {
        network = btn.dataset.net;
        netButtons.forEach((b) => b.classList.toggle('active', b.dataset.net === network));
        const addr = addrFor(network);
        walletAddr.textContent = addr;
        copyWallet.dataset.copy = addr;
        netNameSpan.textContent = network.toUpperCase();
        appEl.querySelector('#crypto-sub').textContent = subText('wallet');
      })
    );

    // copy buttons (Binance ID + wallet)
    appEl.querySelectorAll('.copy-btn').forEach((btn) =>
      btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(btn.dataset.copy); } catch (e) { /* clipboard blocked — still flash feedback */ }
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1000);
      })
    );

    // timer countdown (identical to the bank step)
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
          clearAllPersist();
          setTimeout(() => { location.href = 'index.html'; }, 1800);
        }
      }, 1000);
    }

    // upload handling (identical to the bank step)
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
          <div class="row"><span class="k">We receive</span><span class="v">${esc(state.cad.toFixed(2))} ${esc(TARGET)}</span></div>
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
      fd.append('Payment method', state.method === 'crypto' ? 'Crypto (Binance)' : 'Bank transfer');
      fd.append('Customer name', state.customer.name);
      fd.append('Customer email', state.customer.email);
      fd.append('Customer phone', state.customer.phone);
      fd.append('Customer address', state.customer.address);
      fd.append('You send', state.amount + ' ' + fromCurrency);
      fd.append('We receive', state.cad.toFixed(2) + ' ' + TARGET);
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
