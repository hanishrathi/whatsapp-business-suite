/* =========================================================
   Insights — the signals Meta judges the account on, each
   explained in plain language with its business consequence.

   Cards summarise; tapping one opens a window that says what the
   number is, what it does to the business, and what to do next.
   ========================================================= */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function loggedIn() { return typeof API !== 'undefined' && API.isLoggedIn(); }

  let current = null;   // last payload, so the modal can look a signal up

  const STATUS = {
    good:  { label: 'Healthy',      cls: 'good',  dot: '#25D366' },
    watch: { label: 'Keep an eye',  cls: 'watch', dot: '#FF9500' },
    act:   { label: 'Needs action', cls: 'act',   dot: '#FF3B30' },
  };

  async function load() {
    const head = document.getElementById('insightsHead');
    const grid = document.getElementById('insightsGrid');
    if (!head || !grid) return;
    if (!loggedIn()) {
      head.innerHTML = '<div style="padding:20px 0;color:#86868b;font-size:13px;">Log in to see your insights.</div>';
      grid.innerHTML = '';
      return;
    }

    const res = await API.getInsights();
    if (!res.success) {
      head.innerHTML = `<div style="padding:20px 0;color:#FF6B6B;font-size:13px;">${esc(res.message || 'Could not load insights.')}</div>`;
      return;
    }
    current = res.insights;
    renderHead(current);
    renderCards(current);
  }

  function renderHead(i) {
    const head = document.getElementById('insightsHead');
    const st = STATUS[i.overall] || STATUS.good;
    head.innerHTML = `
      <div class="insight-summary ${st.cls}">
        <div class="insight-summary-dot" style="background:${st.dot}"></div>
        <div>
          <h3>${esc(st.label)}</h3>
          <p>${esc(i.headline)}</p>
          <span class="insight-period">Based on the last ${i.periodDays} days of your own sending.</span>
        </div>
      </div>`;
  }

  function renderCards(i) {
    const grid = document.getElementById('insightsGrid');
    if (!i.signals.length) {
      grid.innerHTML = `<div class="card" style="padding:28px;text-align:center;color:#86868b;font-size:13px;line-height:1.7;">
        Nothing to report yet.<br>Insights appear once you have sent messages or received replies.
      </div>`;
      return;
    }
    grid.innerHTML = i.signals.map(s => {
      const st = STATUS[s.status] || STATUS.good;
      return `
      <button class="insight-card ${st.cls}" data-signal="${esc(s.key)}">
        <div class="insight-card-top">
          <span class="insight-card-label">${esc(s.label)}</span>
          <span class="insight-badge ${st.cls}">${esc(st.label)}</span>
        </div>
        <div class="insight-card-value">${esc(s.display)}</div>
        <div class="insight-card-sub">${esc(s.sub || '')}</div>
        <div class="insight-card-more">What this means &rsaquo;</div>
      </button>`;
    }).join('');
  }

  /* ---------- the explain window ---------- */

  function openSignal(key) {
    if (!current) return;
    const s = current.signals.find(x => x.key === key);
    if (!s) return;
    const st = STATUS[s.status] || STATUS.good;

    document.getElementById('insightModalTitle').textContent = s.label;
    document.getElementById('insightModalBody').innerHTML = `
      <div class="insight-detail-value ${st.cls}">
        <strong>${esc(s.display)}</strong>
        <span>${esc(s.sub || '')}</span>
      </div>

      <section class="insight-block">
        <h4>What this is</h4>
        <p>${esc(s.what)}</p>
      </section>

      <section class="insight-block">
        <h4>How it affects your business</h4>
        <p>${esc(s.impact)}</p>
      </section>

      ${s.action ? `
      <section class="insight-block action">
        <h4>What to do</h4>
        <p>${esc(s.action)}</p>
      </section>` : `
      <section class="insight-block ok">
        <h4>What to do</h4>
        <p>Nothing right now — this one is in good shape.</p>
      </section>`}

      ${extraDetail(s)}
    `;
    document.getElementById('insightModal').classList.add('open');
  }

  // Signal-specific extras that are clearer as a table than a sentence.
  function extraDetail(s) {
    if (s.key === 'failures' && s.detail && s.detail.breakdown) {
      return `
        <section class="insight-block">
          <h4>Breakdown by reason</h4>
          ${s.detail.breakdown.map(b => `
            <div class="insight-reason">
              <div class="insight-reason-top">
                <strong>${esc(b.short)}</strong><span>${b.count.toLocaleString()}</span>
              </div>
              <p>${esc(b.meaning)}</p>
              <p class="insight-reason-cost"><em>Cost to you:</em> ${esc(b.cost)}</p>
              <p class="insight-reason-fix"><em>Fix:</em> ${esc(b.fix)}</p>
            </div>`).join('')}
        </section>`;
    }
    if (s.key === 'spend' && s.detail && s.detail.lines) {
      return `
        <section class="insight-block">
          <h4>Where the money goes</h4>
          <table class="insight-table">
            <thead><tr><th>Category</th><th>Sent</th><th>Billable</th><th>Cost</th></tr></thead>
            <tbody>
              ${s.detail.lines.map(l => `
                <tr>
                  <td style="text-transform:capitalize">${esc(l.category)}</td>
                  <td>${l.count.toLocaleString()}</td>
                  <td>${l.billableCount.toLocaleString()}</td>
                  <td>$${l.cost.toFixed(2)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <p class="insight-note">Rates are estimates until you set your own market rates in the environment.</p>
        </section>`;
    }
    if (s.key === 'quality' && s.detail && s.detail.trend) {
      const t = s.detail.trend;
      return `
        <section class="insight-block">
          <h4>Trend</h4>
          <p>${t.points > 1
            ? `Over the readings we have for <strong>${esc(s.detail.accountName)}</strong>, the rating has gone from <strong>${esc(t.from)}</strong> to <strong>${esc(t.to)}</strong>.`
            : 'Not enough history yet — the trend appears once this account has been checked on more than one day.'}</p>
        </section>`;
    }
    return '';
  }

  function closeModal() {
    const m = document.getElementById('insightModal');
    if (m) m.classList.remove('open');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const origNav = window.navigateToPage;
    window.navigateToPage = function (page) {
      if (typeof origNav === 'function') origNav(page);
      if (page === 'insights') load();
    };

    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('insightModalClose', closeModal);
    on('insightModalDone', closeModal);
    const m = document.getElementById('insightModal');
    if (m) m.addEventListener('click', e => { if (e.target === m) closeModal(); });

    document.addEventListener('click', e => {
      const card = e.target.closest && e.target.closest('[data-signal]');
      if (card) openSignal(card.dataset.signal);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  });
})();
