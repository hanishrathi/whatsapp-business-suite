/* =========================================================
   WhatsApp Business Suite Dashboard — JS
   All numbers come from the API. No demo data.
   ========================================================= */

function safeInit(fn) { try { fn(); } catch (e) { console.error('Init error:', e); } }

document.addEventListener('DOMContentLoaded', () => {
  safeInit(initNavigation);
  safeInit(initMobileMenu);
  safeInit(initAccountSystem);
  safeInit(initModal);
  safeInit(loadDashboardStats);
});

/* ========== ACCOUNT DATA STORE (server-backed) ========== */
const MAX_WHATSAPP_ACCOUNTS = 25;

const accountStore = {
  accounts: [],
  activeId: null,

  getActive() {
    return this.accounts.find(a => a.id === this.activeId) || null;
  },

  setActive(id) {
    this.activeId = id;
  },

  async loadFromAPI() {
    if (typeof API === 'undefined' || !API.isLoggedIn()) return;
    const result = await API.getAccounts();
    if (result.success) {
      this.accounts = (result.accounts || []).map(a => ({
        id: a._id,
        name: a.name,
        phone: a.phone,
        country: a.countryCode,
        category: a.category,
        categoryLabel: a.categoryLabel || a.category,
        color: a.color,
        colorClass: a.colorClass,
        status: a.status,
        quality: a.quality,
        qualityLabel: a.qualityLabel,
        messages: a.totalMessages || 0,
        contacts: a.totalContacts || 0,
        wabaId: a.wabaId || '',
        phoneNumberId: a.phoneNumberId || '',
        channelType: a.channelType || 'cloud_api',
        canAutoSend: a.canAutoSend !== false,
        messagingLimit: a.messagingLimit || 0,
        hasToken: !!a.isVerified || a.status === 'connected', // token itself is never sent to the browser
        created: new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      }));
      if (!this.activeId || !this.getActive()) {
        this.activeId = this.accounts.length ? this.accounts[0].id : null;
      }
    }
  }
};

/* ========== NAVIGATION ========== */
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item[data-page]');
  const pages = document.querySelectorAll('.page');
  const pageTitle = document.getElementById('pageTitle');

  const pageTitles = {
    dashboard: 'Dashboard',
    conversations: 'Conversations',
    contacts: 'Contacts',
    broadcasts: 'Broadcasts',
    templates: 'Templates',
    chatbots: 'Chatbots',
    flows: 'Flows',
    insights: 'Insights',
    analytics: 'Analytics',
    reports: 'Reports',
    accounts: 'Accounts',
    api: 'API & Webhooks',
    team: 'Settings'
  };

  navItems.forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      navigateToPage(item.dataset.page);
    });
  });

  window.navigateToPage = function(page) {
    navItems.forEach(n => n.classList.remove('active'));
    const activeNav = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (activeNav) activeNav.classList.add('active');

    pages.forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.add('active');

    pageTitle.textContent = pageTitles[page] || page;
    window.scrollTo(0, 0);

    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
    }
  };
}

/* ========== ACCOUNT SYSTEM ========== */
async function initAccountSystem() {
  await accountStore.loadFromAPI();
  renderAccountSwitcher();
  renderAccountsPage();
  initAccountSwitcherDropdown();
}

const WA_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none">
  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="currentColor"/>
  <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z" fill="currentColor"/>
</svg>`;

function renderAccountSwitcher() {
  const active = accountStore.getActive();
  const nameEl = document.getElementById('activeAccountName');
  const numberEl = document.getElementById('activeAccountNumber');
  const countEl = document.getElementById('accountCount');
  const badgeEl = document.getElementById('navAccountBadge');
  const listEl = document.getElementById('accountList');

  if (nameEl) nameEl.textContent = active ? active.name : 'No account yet';
  if (numberEl) numberEl.textContent = active ? active.phone : 'Add one to get started';
  if (countEl) countEl.textContent = accountStore.accounts.length + ' account' + (accountStore.accounts.length !== 1 ? 's' : '');
  if (badgeEl) badgeEl.textContent = accountStore.accounts.length;

  const avatarEl = document.querySelector('.account-current .account-avatar');
  if (avatarEl) avatarEl.className = 'account-avatar ' + (active ? active.colorClass : 'green');

  if (!listEl) return;
  if (!accountStore.accounts.length) {
    listEl.innerHTML = `<div style="padding:14px 16px;color:#86868b;font-size:13px;">
      No WhatsApp accounts connected yet.<br>Use “Add Account” below to connect your first number.</div>`;
    return;
  }
  listEl.innerHTML = accountStore.accounts.map(acc => `
    <button class="account-option ${acc.id === accountStore.activeId ? 'active' : ''}" data-account-id="${acc.id}">
      <div class="account-avatar ${acc.colorClass}">${WA_ICON_SVG}</div>
      <div class="account-option-info">
        <span class="account-option-name">${escapeHtml(acc.name)}</span>
        <span class="account-option-number">${escapeHtml(acc.phone)}</span>
      </div>
      <span class="account-option-status ${acc.status}"></span>
    </button>
  `).join('');

  listEl.querySelectorAll('.account-option').forEach(opt => {
    opt.addEventListener('click', () => {
      accountStore.setActive(opt.dataset.accountId);
      renderAccountSwitcher();
      renderAccountsPage();
      document.getElementById('accountSwitcher').classList.remove('open');
    });
  });
}

function initAccountSwitcherDropdown() {
  const switcher = document.getElementById('accountSwitcher');
  const currentBtn = document.getElementById('accountCurrentBtn');
  const addBtn = document.getElementById('addAccountBtn');
  const manageBtn = document.getElementById('manageAccountsBtn');

  currentBtn.addEventListener('click', () => {
    switcher.classList.toggle('open');
  });

  document.addEventListener('click', e => {
    if (!switcher.contains(e.target)) {
      switcher.classList.remove('open');
    }
  });

  addBtn.addEventListener('click', () => {
    switcher.classList.remove('open');
    navigateToPage('accounts');
    openModal();
  });

  manageBtn.addEventListener('click', () => {
    switcher.classList.remove('open');
    navigateToPage('accounts');
  });
}

function statusMeta(status) {
  if (status === 'connected') return { dot: 'green', label: 'Connected' };
  if (status === 'connecting') return { dot: 'yellow', label: 'Connecting…' };
  if (status === 'error') return { dot: 'red', label: 'Connection error' };
  // Manual channels are used through the operator's own WhatsApp app, so
  // "offline" would be misleading — there is nothing to connect.
  if (status === 'manual') return { dot: 'blue', label: 'Manual — you send' };
  return { dot: 'red', label: 'Not connected — add API credentials & test' };
}

function renderAccountsPage() {
  const grid = document.getElementById('accountsGrid');
  if (!grid) return;

  const totalStat = document.getElementById('totalAccountsStat');
  const totalMsg = document.getElementById('totalMsgAllAccounts');
  const totalContacts = document.getElementById('totalContactsAll');

  if (totalStat) totalStat.textContent = accountStore.accounts.length + ' / ' + MAX_WHATSAPP_ACCOUNTS;
  if (totalMsg) totalMsg.textContent = accountStore.accounts.reduce((s, a) => s + a.messages, 0).toLocaleString();
  if (totalContacts) totalContacts.textContent = accountStore.accounts.reduce((s, a) => s + a.contacts, 0).toLocaleString();

  if (!accountStore.accounts.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:48px 20px;color:#86868b;">
        <h4 style="margin:0 0 8px;color:#1d1d1f;">Connect your first WhatsApp number</h4>
        <p style="margin:0 0 16px;font-size:14px;">You'll need a <strong>Phone Number ID</strong> and <strong>Access Token</strong> from
        Meta Business Manager (WhatsApp&nbsp;→&nbsp;API Setup). Add them here, test the connection, and you're ready to send.</p>
        <button class="btn" id="emptyAddAccountBtn">+ Add WhatsApp Account</button>
      </div>`;
    const btn = document.getElementById('emptyAddAccountBtn');
    if (btn) btn.addEventListener('click', () => openModal());
    return;
  }

  grid.innerHTML = accountStore.accounts.map(acc => {
    const sm = statusMeta(acc.status);
    return `
    <div class="account-card ${acc.id === accountStore.activeId ? 'active-account' : ''}" data-account-id="${acc.id}">
      <div class="account-card-header">
        <div class="account-card-avatar" style="background:${acc.color}">${WA_ICON_SVG}</div>
        <div class="account-card-title">
          <span class="account-card-name">${escapeHtml(acc.name)}</span>
          <span class="account-card-number">${escapeHtml(acc.phone)}</span>
          <span class="account-card-category">${escapeHtml(acc.categoryLabel)}</span>
        </div>
      </div>
      <div class="account-card-stats">
        <div class="account-card-stat">
          <span class="account-card-stat-val">${acc.messages.toLocaleString()}</span>
          <span class="account-card-stat-lbl">Messages Sent</span>
        </div>
        <div class="account-card-stat">
          <span class="account-card-stat-val">${acc.canAutoSend ? (acc.phoneNumberId ? 'Yes' : 'No') : 'Manual'}</span>
          <span class="account-card-stat-lbl">${acc.canAutoSend ? 'API Credentials' : 'Channel'}</span>
        </div>
        <div class="account-card-stat">
          <span class="account-card-stat-val">${acc.canAutoSend
            ? (acc.messagingLimit ? acc.messagingLimit.toLocaleString() : '—')
            : '—'}</span>
          <span class="account-card-stat-lbl">${acc.canAutoSend ? 'Limit / 24h' : 'Quality'}</span>
        </div>
      </div>
      <div class="account-card-meta">
        <div class="account-card-status">
          <span class="status-dot ${sm.dot}"></span>
          ${sm.label}
        </div>
      </div>
      <div class="account-card-actions">
        ${acc.canAutoSend ? `<button class="btn btn-sm test-account-btn" data-account-id="${acc.id}">Test Connection</button>` : ''}
        <button class="btn btn-sm btn-outline edit-account-btn" data-account-id="${acc.id}">Edit</button>
        <button class="btn btn-sm btn-danger-outline remove-account-btn" data-account-id="${acc.id}">Remove</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.test-account-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Testing…';
      const result = await API.testWAAccount(btn.dataset.accountId);
      btn.disabled = false;
      btn.textContent = original;
      alert(result.message || (result.success ? 'Connected!' : 'Connection failed.'));
      await accountStore.loadFromAPI();
      renderAccountSwitcher();
      renderAccountsPage();
    });
  });

  grid.querySelectorAll('.edit-account-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const acc = accountStore.accounts.find(a => a.id === btn.dataset.accountId);
      if (acc) openModal(acc);
    });
  });

  grid.querySelectorAll('.remove-account-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const acc = accountStore.accounts.find(a => a.id === btn.dataset.accountId);
      if (!acc) return;
      if (!confirm(`Remove "${acc.name}" (${acc.phone})? This disconnects the number from this dashboard.`)) return;
      const result = await API.deleteWAAccount(acc.id);
      if (!result.success) return alert(result.message || 'Failed to remove account.');
      await accountStore.loadFromAPI();
      renderAccountSwitcher();
      renderAccountsPage();
    });
  });
}

/* ========== ADD / EDIT ACCOUNT MODAL ========== */
let modalCurrentStep = 1;
let editingAccountId = null;

function openModal(account) {
  const modal = document.getElementById('addAccountModal');
  editingAccountId = account ? account.id : null;
  modalCurrentStep = 1;
  setModalStep(1);
  modal.classList.add('open');

  document.getElementById('newAccountName').value = account ? account.name : '';
  const phoneInput = document.getElementById('newAccountPhone');
  phoneInput.value = account ? account.phone.replace(account.country || '', '') : '';
  phoneInput.disabled = !!account; // phone can't change after creation
  document.getElementById('newAccountWabaId').value = account ? account.wabaId : '';
  document.getElementById('newAccountPhoneNumberId').value = account ? account.phoneNumberId : '';
  const tokenInput = document.getElementById('newAccountToken');
  tokenInput.value = '';
  tokenInput.placeholder = account && account.phoneNumberId
    ? 'Leave blank to keep the current token'
    : 'Paste your permanent access token…';

  const channelSelect = document.getElementById('newAccountChannelType');
  if (channelSelect) {
    channelSelect.value = (account && account.channelType) || 'cloud_api';
    // The channel decides what kind of number this is, so it is fixed once set.
    channelSelect.disabled = !!account;
    applyChannelType();
  }

  const title = document.querySelector('#addAccountModal .modal-header h3');
  if (title) title.textContent = account ? 'Edit WhatsApp Account' : 'Connect WhatsApp Account';
}

/*
 * A manual channel (WhatsApp Business app / regular WhatsApp) has no API
 * credentials — registering a number with the Cloud API takes it out of those
 * apps. Hide the credential step rather than let someone fill in fields the
 * server will reject.
 */
function applyChannelType() {
  const select = document.getElementById('newAccountChannelType');
  if (!select) return;
  const isManual = select.value === 'manual';
  const step2 = document.getElementById('step2');
  if (step2) {
    step2.dataset.skip = isManual ? '1' : '';
    if (isManual) {
      ['newAccountPhoneNumberId', 'newAccountToken', 'newAccountWabaId'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
    }
  }
  const stepIndicator = document.querySelectorAll('.modal-step')[1];
  if (stepIndicator) stepIndicator.style.opacity = isManual ? '0.4' : '';
}

function closeModal() {
  document.getElementById('addAccountModal').classList.remove('open');
  editingAccountId = null;
}

function setModalStep(step) {
  modalCurrentStep = step;
  const backBtn = document.getElementById('modalBack');
  const nextBtn = document.getElementById('modalNext');

  document.querySelectorAll('.modal-step').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i + 1 < step) s.classList.add('done');
    if (i + 1 === step) s.classList.add('active');
  });
  document.querySelectorAll('.modal-step-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById('step' + step);
  if (target) target.classList.add('active');

  backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';
  nextBtn.textContent = step === 3 ? (editingAccountId ? 'Save Changes' : 'Connect Account') : 'Continue';
}

// Manual channels have no credentials step — skip straight past it.
function nextModalStep(direction) {
  const step2 = document.getElementById('step2');
  const skip2 = step2 && step2.dataset.skip === '1';
  let next = modalCurrentStep + direction;
  if (next === 2 && skip2) next += direction;
  setModalStep(Math.min(3, Math.max(1, next)));
}

async function finishAddAccount() {
  const name = document.getElementById('newAccountName').value.trim();
  const country = document.getElementById('newAccountCountry').value;
  const phone = document.getElementById('newAccountPhone').value.trim();
  const category = document.getElementById('newAccountCategory');
  const categoryVal = category.value || 'general';
  const categoryText = category.options[category.selectedIndex]?.text || 'General';
  const activeSwatch = document.querySelector('.color-swatch.active');
  const color = activeSwatch ? activeSwatch.dataset.color : '#25D366';
  const wabaId = document.getElementById('newAccountWabaId').value.trim();
  const phoneNumberId = document.getElementById('newAccountPhoneNumberId').value.trim();
  const accessToken = document.getElementById('newAccountToken').value.trim();

  if (!name) return alert('Please give this account a name.');
  if (!editingAccountId && !phone) return alert('Please enter the WhatsApp phone number.');
  if (typeof API === 'undefined' || !API.isLoggedIn()) return alert('Please log in first.');

  const colorMap = {
    '#25D366': 'green', '#34B7F1': 'blue', '#9B59B6': 'purple',
    '#FF9500': 'orange', '#FF6B6B': 'red', '#1ABC9C': 'teal'
  };

  const channelSelect = document.getElementById('newAccountChannelType');
  const channelType = channelSelect ? channelSelect.value : 'cloud_api';
  const isManual = channelType === 'manual';

  const payload = {
    name,
    category: categoryVal,
    categoryLabel: categoryText,
    color,
    colorClass: colorMap[color] || 'green',
  };
  // A manual channel must carry no Cloud API credentials — the server rejects
  // the combination, since a Cloud API number leaves the WhatsApp apps.
  if (!isManual) {
    payload.wabaId = wabaId;
    payload.phoneNumberId = phoneNumberId;
    if (accessToken) payload.accessToken = accessToken;
  }

  let result;
  if (editingAccountId) {
    result = await API.updateWAAccount(editingAccountId, payload);
  } else {
    result = await API.createWAAccount({
      ...payload, channelType,
      phone: country + phone.replace(/\s/g, ''), countryCode: country,
    });
  }
  if (!result.success) return alert(result.message || 'Failed to save account.');

  await accountStore.loadFromAPI();
  renderAccountSwitcher();
  renderAccountsPage();
  closeModal();
  if (isManual) {
    if (!editingAccountId) {
      alert('Manual channel saved. Broadcasts to this number produce click-to-chat links you open and send from your own WhatsApp app.');
    }
  } else if (phoneNumberId && accessToken) {
    alert('Account saved. Click "Test Connection" on the account card to verify it with Meta.');
  } else if (!editingAccountId) {
    alert('Account saved. To send real messages, edit it and add your Phone Number ID and Access Token from Meta Business Manager.');
  }
}

function initModal() {
  const modal = document.getElementById('addAccountModal');
  const closeBtn = document.getElementById('modalClose');
  const nextBtn = document.getElementById('modalNext');
  const backBtn = document.getElementById('modalBack');
  const addBtn = document.getElementById('addNewAccountBtn');

  if (addBtn) addBtn.addEventListener('click', () => openModal());
  closeBtn.addEventListener('click', closeModal);

  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  nextBtn.addEventListener('click', () => {
    if (modalCurrentStep < 3) {
      nextModalStep(1);
    } else {
      finishAddAccount();
    }
  });

  backBtn.addEventListener('click', () => {
    if (modalCurrentStep > 1) nextModalStep(-1);
  });

  const channelSelect = document.getElementById('newAccountChannelType');
  if (channelSelect) channelSelect.addEventListener('change', applyChannelType);

  // Color swatch selection
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
  });
}

/* ========== REAL DASHBOARD STATS + CHARTS ========== */
let chartRefs = {};

function animateValue(el, target, suffix) {
  const duration = 900;
  const start = performance.now();
  function update(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased).toLocaleString() + (suffix || '');
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

function setStat(id, value, suffix) {
  const el = document.getElementById(id);
  if (el) animateValue(el, value || 0, suffix);
}

async function loadDashboardStats() {
  if (typeof API === 'undefined' || !API.isLoggedIn()) return;
  const res = await API.getDashboardStats();
  if (!res.success || !res.stats) return;
  const s = res.stats;

  setStat('statMsgsToday', s.messagesToday);
  setStat('statContacts', s.totalContacts);
  setStat('statDelivery', s.deliveryRate, '%');
  setStat('statMonth', s.monthTotal);

  const donutTotal = document.getElementById('donutTotal');
  if (donutTotal) donutTotal.textContent = (s.monthTotal || 0).toLocaleString();
  const allDel = document.getElementById('allDeliveryStat');
  if (allDel) allDel.textContent = s.deliveryRate + '%';

  renderConsentStat(s.consent);
  renderTemplatePerformance(s.templatePerformance);
  renderSpend(s.spend);

  // Sidebar plan meter — real monthly volume (Meta's free tier ≈ 1,000 conversations/month).
  const user = API.getUser();
  const planName = document.getElementById('planName');
  if (planName && user) planName.textContent = (user.plan === 'free' || !user.plan) ? 'Free Plan' : user.plan.charAt(0).toUpperCase() + user.plan.slice(1) + ' Plan';
  const planUsage = document.getElementById('planUsage');
  if (planUsage) planUsage.textContent = (s.monthTotal || 0).toLocaleString() + ' msgs this month';
  const planBar = document.getElementById('planBarFill');
  if (planBar) planBar.style.width = Math.min(((s.monthTotal || 0) / 1000) * 100, 100) + '%';

  renderCharts(s);
  fillDashboardLists();
}

/*
 * Opt-out rate across the contact list. A rising rate is the earliest warning
 * that messaging is unwelcome, which is what damages an account's quality
 * rating with Meta — so it is shown even when it is zero.
 */
function renderConsentStat(consent) {
  const valueEl = document.getElementById('statOptOutRate');
  const noteEl = document.getElementById('statOptOutNote');
  if (!valueEl) return;
  if (!consent || !consent.total) {
    valueEl.textContent = '—';
    if (noteEl) { noteEl.textContent = 'no contacts yet'; noteEl.className = 'stat-change'; }
    return;
  }
  valueEl.textContent = consent.optOutRate + '%';
  if (noteEl) {
    noteEl.textContent = consent.noConsent
      ? `${consent.noConsent} without consent`
      : `${consent.optedIn} opted in`;
    noteEl.className = 'stat-change' + (consent.noConsent ? ' down' : ' up');
  }
}

/*
 * Top templates by read rate over the last 30 days, from real delivery
 * receipts. Shows nothing rather than inventing numbers when there is no data.
 */
function renderTemplatePerformance(rows) {
  const el = document.getElementById('templatePerf');
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = `<div style="padding:24px 8px;text-align:center;color:#86868b;font-size:13px;line-height:1.6;">
      No template sends in the last 30 days yet.<br>Read rates appear here once broadcasts go out.
    </div>`;
    return;
  }
  const colors = ['#25D366', '#34B7F1', '#9B59B6', '#FFC107', '#FF6B6B'];
  el.innerHTML = rows.map((r, i) => `
    <div class="template-perf-item">
      <div class="template-perf-info">
        <span class="template-perf-name">${escapeHtml(r.name)}</span>
        <span class="template-perf-stat">${r.readRate}% read · ${r.delivered.toLocaleString()} delivered</span>
      </div>
      <div class="mini-bar"><div class="mini-bar-fill" style="width:${Math.min(r.readRate, 100)}%;background:${colors[i % colors.length]}"></div></div>
    </div>`).join('');
}

/*
 * Estimated WhatsApp spend this month, by billing category.
 *
 * Service messages (free-form replies inside the 24h window) are free until
 * 1 Oct 2026 and billable after, so the banner counts down to that change —
 * it is the single most expensive surprise on this platform right now.
 */
function renderSpend(spend) {
  const el = document.getElementById('spendPanel');
  if (!el || !spend) return;

  const rows = (spend.lines || []).filter(l => l.count > 0);
  const notice = !spend.serviceBillingActive && spend.daysUntilServiceBilling > 0 && spend.counts.service
    ? `<div style="margin-bottom:12px;padding:10px 12px;background:#FFF4E5;border:1px solid #FFE08A;border-radius:10px;font-size:12px;line-height:1.5;color:#6b5700;">
         <strong>${spend.daysUntilServiceBilling} day${spend.daysUntilServiceBilling === 1 ? '' : 's'}</strong>
         until free-form service replies become billable (1 Oct 2026). You have sent
         <strong>${spend.counts.service.toLocaleString()}</strong> this month — those would be charged
         above the first ${spend.serviceFreeAllowance.toLocaleString()}/number/month.
       </div>` : '';

  if (!rows.length) {
    el.innerHTML = notice + `<div style="padding:16px 4px;color:#86868b;font-size:13px;">No billable messages this month.</div>`;
    return;
  }

  el.innerHTML = notice + `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="text-align:left;color:#86868b;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">
        <th style="padding:6px 0;">Category</th><th style="text-align:right;">Sent</th>
        <th style="text-align:right;">Billable</th><th style="text-align:right;">Est. cost</th>
      </tr></thead>
      <tbody>
        ${rows.map(l => `
          <tr style="border-top:1px solid #f0f0f4;">
            <td style="padding:8px 0;text-transform:capitalize;">${escapeHtml(l.category)}</td>
            <td style="text-align:right;">${l.count.toLocaleString()}</td>
            <td style="text-align:right;color:${l.billableCount ? '#1d1d1f' : '#86868b'}">${l.billableCount.toLocaleString()}</td>
            <td style="text-align:right;">$${l.cost.toFixed(2)}</td>
          </tr>`).join('')}
        <tr style="border-top:2px solid #e8e8ed;font-weight:700;">
          <td style="padding:8px 0;">Total</td><td></td><td></td>
          <td style="text-align:right;">$${(spend.total || 0).toFixed(2)}</td>
        </tr>
      </tbody>
    </table>
    <p style="margin:10px 0 0;font-size:11px;color:#a1a1a6;line-height:1.5;">
      Indicative only — Meta's rates vary by recipient market. Set WA_RATE_* in your environment to match your own pricing.
    </p>`;
}

// Fill the "Campaign Performance" and "Active Templates" dashboard cards with real data.
async function fillDashboardLists() {
  const campaignEl = document.getElementById('dashCampaignList');
  if (campaignEl) {
    const res = await API.getBroadcasts();
    const sentOnes = (res.success ? res.broadcasts : []).filter(b => (b.sentCount || 0) > 0).slice(0, 3);
    if (sentOnes.length) {
      campaignEl.innerHTML = sentOnes.map(b => {
        const pct = (n) => b.sentCount ? Math.round((n / b.sentCount) * 100) : 0;
        const delivered = pct(b.deliveredCount || 0);
        return `
        <div class="campaign-item">
          <div class="campaign-info">
            <span class="campaign-name">${escapeHtml(b.name)}</span>
            <span class="campaign-meta">${new Date(b.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${b.sentCount} sent</span>
          </div>
          <div class="campaign-stats">
            <div class="campaign-stat"><span class="campaign-stat-val">${delivered}%</span><span class="campaign-stat-lbl">Delivered</span></div>
            <div class="campaign-stat"><span class="campaign-stat-val">${pct(b.readCount || 0)}%</span><span class="campaign-stat-lbl">Read</span></div>
            <div class="campaign-stat"><span class="campaign-stat-val">${b.failedCount || 0}</span><span class="campaign-stat-lbl">Failed</span></div>
          </div>
          <div class="campaign-bar"><div class="campaign-bar-fill" style="width:${delivered}%"></div></div>
        </div>`;
      }).join('');
    } else {
      campaignEl.innerHTML = `<div style="padding:28px 16px;text-align:center;color:#86868b;font-size:13px;">
        No broadcasts sent yet. Create one under <strong>Broadcasts</strong> and press <strong>Send now</strong>.</div>`;
    }
  }

  const tplBody = document.getElementById('dashTemplatesBody');
  if (tplBody) {
    const res = await API.getTemplates();
    const tpls = (res.success ? res.templates : []).slice(0, 5);
    if (tpls.length) {
      tplBody.innerHTML = tpls.map(t => `
        <tr>
          <td class="cell-name">${escapeHtml(t.name)}</td>
          <td><span class="tag tag-blue">${escapeHtml(t.category)}</span></td>
          <td><span class="status-dot ${t.status === 'approved' ? 'green' : 'yellow'}"></span>${escapeHtml(t.status)}</td>
          <td>${t.timesUsed || 0}</td>
          <td>${escapeHtml((t.language || 'en').toUpperCase())}</td>
        </tr>`).join('');
    } else {
      tplBody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:#86868b;">
        No templates yet. Create one under <strong>Templates</strong>.</td></tr>`;
    }
  }
}

function renderCharts(s) {
  if (typeof Chart === 'undefined') { console.warn('Chart library not loaded — skipping charts.'); return; }

  Chart.defaults.font.family = '"DM Sans", -apple-system, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#86868b';

  const labels = s.series.map(p => p.day);
  const sent = s.series.map(p => p.sent);
  const delivered = s.series.map(p => p.delivered);

  const lineOpts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 16, font: { size: 12, weight: 500 } } },
      tooltip: { backgroundColor: 'rgba(0,0,0,0.8)', titleFont: { weight: 600 }, bodyFont: { size: 12 }, padding: 12, cornerRadius: 10, displayColors: true, boxWidth: 8, boxHeight: 8, usePointStyle: true },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { padding: 8 } },
      y: { grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false }, border: { display: false }, ticks: { padding: 12, precision: 0 }, beginAtZero: true },
    },
  };

  const lineDataset = (label, data, color, bg) => ({
    label, data, borderColor: color, backgroundColor: bg, fill: true, tension: 0.4,
    borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 6,
    pointHoverBackgroundColor: color, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2,
  });

  const msgCtx = document.getElementById('messageChart');
  if (msgCtx) {
    if (chartRefs.message) chartRefs.message.destroy();
    chartRefs.message = new Chart(msgCtx, {
      type: 'line',
      data: { labels, datasets: [
        lineDataset('Sent', sent, '#25D366', 'rgba(37, 211, 102, 0.08)'),
        lineDataset('Delivered', delivered, '#34B7F1', 'rgba(52, 183, 241, 0.05)'),
      ]},
      options: lineOpts,
    });
  }

  const b = s.breakdown;
  const breakCtx = document.getElementById('breakdownChart');
  if (breakCtx) {
    if (chartRefs.breakdown) chartRefs.breakdown.destroy();
    chartRefs.breakdown = new Chart(breakCtx, {
      type: 'doughnut',
      data: {
        labels: ['Delivered', 'Read', 'Failed', 'Pending'],
        datasets: [{
          data: [b.delivered, b.read, b.failed, b.pending + b.sent],
          backgroundColor: ['#25D366', '#34B7F1', '#FF6B6B', '#FFC107'],
          borderWidth: 0, spacing: 3, borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '72%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)', padding: 12, cornerRadius: 10, bodyFont: { size: 12 },
            callbacks: {
              label: ctx => {
                const total = ctx.dataset.data.reduce((a, x) => a + x, 0) || 1;
                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  const engCtx = document.getElementById('engagementChart');
  if (engCtx) {
    if (chartRefs.engagement) chartRefs.engagement.destroy();
    const bar = (label, data, color) => ({ label, data, backgroundColor: color, borderRadius: 6, borderSkipped: false, barPercentage: 0.6, categoryPercentage: 0.7 });
    chartRefs.engagement = new Chart(engCtx, {
      type: 'bar',
      data: { labels, datasets: [bar('Sent', sent, '#25D366'), bar('Delivered', delivered, '#34B7F1')] },
      options: lineOpts,
    });
  }
}

/* ========== MOBILE MENU ========== */
function initMobileMenu() {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.getElementById('sidebar');

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  document.addEventListener('click', e => {
    if (window.innerWidth <= 768 &&
        !sidebar.contains(e.target) &&
        !toggle.contains(e.target)) {
      sidebar.classList.remove('open');
    }
  });
}

/* ========== CHIP TOGGLES ========== */
document.addEventListener('click', e => {
  if (e.target.classList.contains('chip') && e.target.closest('.card-actions')) {
    const group = e.target.closest('.card-actions');
    group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
  }

  if (e.target.classList.contains('chip') && e.target.closest('.convo-filters')) {
    const group = e.target.closest('.convo-filters');
    group.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
  }
});

/* ========== CONVERSATION CLICK (preview UI) ========== */
document.querySelectorAll('.convo-item-full').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.convo-item-full').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
  });
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
