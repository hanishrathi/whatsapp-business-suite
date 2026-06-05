/* =========================================================
   WhatsApp Business Suite Dashboard — JS
   ========================================================= */

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initCounters();
  initCharts();
  initMobileMenu();
  initAccountSystem();
  initModal();
});

/* ========== ACCOUNT DATA STORE ========== */
const MAX_WHATSAPP_ACCOUNTS = 25;

const accountStore = {
  accounts: [
    {
      id: 'acc_1',
      name: 'AcquiHire Sales',
      phone: '+91 98765 00001',
      country: '+91',
      category: 'Sales & Marketing',
      color: '#25D366',
      colorClass: 'green',
      status: 'online',
      quality: 'high',
      qualityLabel: 'High',
      messages: 8420,
      contacts: 12540,
      delivery: '96.2%',
      waba_id: 'WABA_102938475610293',
      created: 'Jan 12, 2026',
    },
    {
      id: 'acc_2',
      name: 'AcquiHire Support',
      phone: '+91 98765 00002',
      country: '+91',
      category: 'Customer Support',
      color: '#34B7F1',
      colorClass: 'blue',
      status: 'online',
      quality: 'high',
      qualityLabel: 'High',
      messages: 11240,
      contacts: 15380,
      delivery: '98.1%',
      waba_id: 'WABA_293847561029384',
      created: 'Feb 3, 2026',
    },
    {
      id: 'acc_3',
      name: 'AcquiHire Alerts',
      phone: '+1 555 123 4567',
      country: '+1',
      category: 'Notifications & Alerts',
      color: '#9B59B6',
      colorClass: 'purple',
      status: 'online',
      quality: 'medium',
      qualityLabel: 'Medium',
      messages: 5020,
      contacts: 6280,
      delivery: '94.7%',
      waba_id: 'WABA_384756102938475',
      created: 'Mar 18, 2026',
    }
  ],
  activeId: 'acc_1',

  getActive() {
    return this.accounts.find(a => a.id === this.activeId);
  },

  setActive(id) {
    this.activeId = id;
  },

  add(account) {
    if (this.accounts.length >= MAX_WHATSAPP_ACCOUNTS) {
      alert(`Maximum of ${MAX_WHATSAPP_ACCOUNTS} WhatsApp accounts allowed. Please remove an existing account first.`);
      return false;
    }
    account.id = 'acc_' + (this.accounts.length + 1) + '_' + Date.now();
    account.status = 'connecting';
    account.quality = 'high';
    account.qualityLabel = 'High';
    account.messages = 0;
    account.contacts = 0;
    account.delivery = '—';
    account.waba_id = 'WABA_' + Math.random().toString().slice(2, 17);
    account.created = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    this.accounts.push(account);
    setTimeout(() => {
      account.status = 'online';
      renderAccountSwitcher();
      renderAccountsPage();
    }, 3000);
    return true;
  },

  remove(id) {
    if (this.accounts.length <= 1) return;
    this.accounts = this.accounts.filter(a => a.id !== id);
    if (this.activeId === id) {
      this.activeId = this.accounts[0].id;
    }
  },

  // Try loading from API (falls back to demo data above)
  async loadFromAPI() {
    if (typeof API !== 'undefined' && API.isLoggedIn()) {
      try {
        const result = await API.getAccounts();
        if (result.success && result.accounts.length > 0) {
          this.accounts = result.accounts.map(a => ({
            id: a._id,
            name: a.name,
            phone: a.phone,
            country: a.countryCode,
            category: a.categoryLabel || a.category,
            color: a.color,
            colorClass: a.colorClass,
            status: a.status,
            quality: a.quality,
            qualityLabel: a.qualityLabel,
            messages: a.totalMessages || a.messagesThisMonth || 0,
            contacts: a.totalContacts || 0,
            delivery: a.deliveryRate || '0%',
            waba_id: a.wabaId || '',
            created: new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          }));
          this.activeId = this.accounts[0].id;
        }
      } catch (e) {
        console.log('Using demo account data');
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

function renderAccountSwitcher() {
  const active = accountStore.getActive();
  const nameEl = document.getElementById('activeAccountName');
  const numberEl = document.getElementById('activeAccountNumber');
  const countEl = document.getElementById('accountCount');
  const badgeEl = document.getElementById('navAccountBadge');
  const listEl = document.getElementById('accountList');

  if (nameEl) nameEl.textContent = active.name;
  if (numberEl) numberEl.textContent = active.phone;
  if (countEl) countEl.textContent = accountStore.accounts.length + ' account' + (accountStore.accounts.length !== 1 ? 's' : '');
  if (badgeEl) badgeEl.textContent = accountStore.accounts.length;

  const avatarEl = document.querySelector('.account-current .account-avatar');
  if (avatarEl) {
    avatarEl.className = 'account-avatar ' + active.colorClass;
  }

  if (!listEl) return;
  listEl.innerHTML = accountStore.accounts.map(acc => `
    <button class="account-option ${acc.id === accountStore.activeId ? 'active' : ''}" data-account-id="${acc.id}">
      <div class="account-avatar ${acc.colorClass}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="currentColor"/>
          <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z" fill="currentColor"/>
        </svg>
      </div>
      <div class="account-option-info">
        <span class="account-option-name">${escapeHtml(acc.name)}</span>
        <span class="account-option-number">${acc.phone}</span>
      </div>
      <span class="account-option-status ${acc.status}"></span>
    </button>
  `).join('');

  listEl.querySelectorAll('.account-option').forEach(opt => {
    opt.addEventListener('click', () => {
      accountStore.setActive(opt.dataset.accountId);
      renderAccountSwitcher();
      renderAccountsPage();
      updateDashboardForAccount();
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

function updateDashboardForAccount() {
  const acc = accountStore.getActive();
  const planUsage = document.querySelector('.plan-usage');
  const planFill = document.querySelector('.plan-bar-fill');
  if (planUsage) {
    planUsage.textContent = acc.messages.toLocaleString() + ' / 10,000 msgs';
  }
  if (planFill) {
    planFill.style.width = Math.min((acc.messages / 10000) * 100, 100) + '%';
  }
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

  grid.innerHTML = accountStore.accounts.map(acc => `
    <div class="account-card ${acc.id === accountStore.activeId ? 'active-account' : ''}" data-account-id="${acc.id}">
      <div class="account-card-header">
        <div class="account-card-avatar" style="background:${acc.color}">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="currentColor"/>
            <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z" fill="currentColor"/>
          </svg>
        </div>
        <div class="account-card-title">
          <span class="account-card-name">${escapeHtml(acc.name)}</span>
          <span class="account-card-number">${acc.phone}</span>
          <span class="account-card-category">${acc.category}</span>
        </div>
      </div>
      <div class="account-card-stats">
        <div class="account-card-stat">
          <span class="account-card-stat-val">${acc.messages.toLocaleString()}</span>
          <span class="account-card-stat-lbl">Messages</span>
        </div>
        <div class="account-card-stat">
          <span class="account-card-stat-val">${acc.contacts.toLocaleString()}</span>
          <span class="account-card-stat-lbl">Contacts</span>
        </div>
        <div class="account-card-stat">
          <span class="account-card-stat-val">${acc.delivery}</span>
          <span class="account-card-stat-lbl">Delivery</span>
        </div>
      </div>
      <div class="account-card-meta">
        <div class="account-card-status">
          <span class="status-dot ${acc.status === 'online' ? 'green' : acc.status === 'connecting' ? 'yellow' : 'red'}"></span>
          ${acc.status === 'online' ? 'Connected' : acc.status === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </div>
        <span class="account-card-quality quality-${acc.quality}">${acc.qualityLabel} Quality</span>
      </div>
      <div class="account-card-actions">
        <button class="btn btn-sm switch-account-btn" data-account-id="${acc.id}"
          ${acc.id === accountStore.activeId ? 'disabled style="opacity:0.5;cursor:default"' : ''}>
          ${acc.id === accountStore.activeId ? 'Current' : 'Switch To'}
        </button>
        <button class="btn btn-sm btn-outline edit-account-btn" data-account-id="${acc.id}">Edit</button>
        <button class="btn btn-sm btn-danger-outline remove-account-btn" data-account-id="${acc.id}"
          ${accountStore.accounts.length <= 1 ? 'disabled style="opacity:0.3;cursor:default"' : ''}>
          Remove
        </button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.switch-account-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      accountStore.setActive(btn.dataset.accountId);
      renderAccountSwitcher();
      renderAccountsPage();
      updateDashboardForAccount();
    });
  });

  grid.querySelectorAll('.remove-account-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (accountStore.accounts.length <= 1) return;
      const acc = accountStore.accounts.find(a => a.id === btn.dataset.accountId);
      if (acc && confirm(`Remove "${acc.name}" (${acc.phone})? This will disconnect the WhatsApp Business API for this number.`)) {
        accountStore.remove(btn.dataset.accountId);
        renderAccountSwitcher();
        renderAccountsPage();
        updateDashboardForAccount();
      }
    });
  });
}

/* ========== ADD ACCOUNT MODAL ========== */
let modalCurrentStep = 1;

function openModal() {
  const modal = document.getElementById('addAccountModal');
  modalCurrentStep = 1;
  setModalStep(1);
  modal.classList.add('open');
  document.getElementById('newAccountName').value = '';
  document.getElementById('newAccountPhone').value = '';
  document.querySelectorAll('.otp-input').forEach(i => i.value = '');
}

function closeModal() {
  document.getElementById('addAccountModal').classList.remove('open');
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
  nextBtn.textContent = step === 3 ? 'Connect Account' : 'Continue';
}

async function finishAddAccount() {
  const name = document.getElementById('newAccountName').value.trim() || 'New Account';
  const country = document.getElementById('newAccountCountry').value;
  const phone = document.getElementById('newAccountPhone').value.trim() || '000 000 0000';
  const category = document.getElementById('newAccountCategory');
  const categoryVal = category.value || 'general';
  const categoryText = category.options[category.selectedIndex]?.text || 'General';
  const activeSwatch = document.querySelector('.color-swatch.active');
  const color = activeSwatch ? activeSwatch.dataset.color : '#25D366';

  const colorMap = {
    '#25D366': 'green',
    '#34B7F1': 'blue',
    '#9B59B6': 'purple',
    '#FF9500': 'orange',
    '#FF6B6B': 'red',
    '#1ABC9C': 'teal'
  };

  const accountData = {
    name,
    phone: country + phone.replace(/\s/g, ''),
    countryCode: country,
    category: categoryVal,
    categoryLabel: categoryText,
    color,
    colorClass: colorMap[color] || 'green',
  };

  // Try API first
  if (typeof API !== 'undefined' && API.isLoggedIn()) {
    const result = await API.createWAAccount(accountData);
    if (result.success) {
      await accountStore.loadFromAPI();
      renderAccountSwitcher();
      renderAccountsPage();
      closeModal();
      return;
    } else {
      alert(result.message || 'Failed to add account.');
      return;
    }
  }

  // Fallback: local store
  const added = accountStore.add({
    ...accountData,
    phone: country + ' ' + phone,
    category: categoryText,
  });

  if (added) {
    renderAccountSwitcher();
    renderAccountsPage();
    closeModal();
  }
}

function initModal() {
  const modal = document.getElementById('addAccountModal');
  const closeBtn = document.getElementById('modalClose');
  const nextBtn = document.getElementById('modalNext');
  const backBtn = document.getElementById('modalBack');
  const addBtn = document.getElementById('addNewAccountBtn');

  if (addBtn) addBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);

  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  nextBtn.addEventListener('click', () => {
    if (modalCurrentStep < 3) {
      setModalStep(modalCurrentStep + 1);
    } else {
      finishAddAccount();
    }
  });

  backBtn.addEventListener('click', () => {
    if (modalCurrentStep > 1) setModalStep(modalCurrentStep - 1);
  });

  // OTP auto-advance
  document.querySelectorAll('.otp-input').forEach((input, i, all) => {
    input.addEventListener('input', () => {
      if (input.value.length === 1 && i < all.length - 1) {
        all[i + 1].focus();
      }
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        all[i - 1].focus();
      }
    });
  });

  // Color swatch selection
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
  });
}

/* ========== ANIMATED COUNTERS ========== */
function initCounters() {
  const counters = document.querySelectorAll('.stat-value[data-count]');

  counters.forEach(counter => {
    const target = parseInt(counter.dataset.count, 10);
    const suffix = counter.dataset.suffix || '';
    const duration = 1200;
    const start = performance.now();

    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(target * eased);

      counter.textContent = current.toLocaleString() + (suffix ? suffix : '');

      if (progress < 1) {
        requestAnimationFrame(update);
      }
    }

    requestAnimationFrame(update);
  });
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

/* ========== CHARTS ========== */
function initCharts() {
  Chart.defaults.font.family = '"DM Sans", -apple-system, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#86868b';

  initMessageChart();
  initBreakdownChart();
  initEngagementChart();
}

function initMessageChart() {
  const ctx = document.getElementById('messageChart');
  if (!ctx) return;

  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const sent = [1240, 1580, 1420, 1890, 2100, 980, 1847];
  const received = [890, 1120, 1050, 1340, 1520, 680, 1260];

  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Sent',
          data: sent,
          borderColor: '#25D366',
          backgroundColor: 'rgba(37, 211, 102, 0.08)',
          fill: true,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#25D366',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
        },
        {
          label: 'Received',
          data: received,
          borderColor: '#34B7F1',
          backgroundColor: 'rgba(52, 183, 241, 0.05)',
          fill: true,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#34B7F1',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 16,
            font: { size: 12, weight: 500 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          titleFont: { weight: 600 },
          bodyFont: { size: 12 },
          padding: 12,
          cornerRadius: 10,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
        }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { padding: 8 }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
          border: { display: false },
          ticks: { padding: 12 },
          beginAtZero: true,
        }
      }
    }
  });
}

function initBreakdownChart() {
  const ctx = document.getElementById('breakdownChart');
  if (!ctx) return;

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Delivered', 'Read', 'Failed', 'Pending'],
      datasets: [{
        data: [5420, 2340, 180, 480],
        backgroundColor: ['#25D366', '#34B7F1', '#FF6B6B', '#FFC107'],
        borderWidth: 0,
        spacing: 3,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          padding: 12,
          cornerRadius: 10,
          bodyFont: { size: 12 },
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function initEngagementChart() {
  const ctx = document.getElementById('engagementChart');
  if (!ctx) return;

  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Delivered',
          data: [1240, 1580, 1420, 1890, 2100, 980, 1847],
          backgroundColor: '#25D366',
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.6,
          categoryPercentage: 0.7,
        },
        {
          label: 'Read',
          data: [890, 1120, 1050, 1340, 1520, 680, 1260],
          backgroundColor: '#34B7F1',
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.6,
          categoryPercentage: 0.7,
        },
        {
          label: 'Replied',
          data: [320, 410, 380, 490, 560, 240, 450],
          backgroundColor: '#9B59B6',
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.6,
          categoryPercentage: 0.7,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 16,
            font: { size: 12, weight: 500 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          padding: 12,
          cornerRadius: 10,
          bodyFont: { size: 12 },
        }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { padding: 8 }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
          border: { display: false },
          ticks: { padding: 12 },
          beginAtZero: true,
        }
      }
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

/* ========== CONVERSATION CLICK ========== */
document.querySelectorAll('.convo-item-full').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.convo-item-full').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
  });
});

/* ========== CHAT SEND ========== */
const chatInput = document.querySelector('.chat-text-input');
const sendBtn = document.querySelector('.send-btn');

if (chatInput && sendBtn) {
  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    const messages = document.querySelector('.chat-messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message outgoing';

    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgDiv.innerHTML = `
      <div class="message-bubble">
        <p>${escapeHtml(text)}</p>
        <span class="message-time">${time} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34B7F1" stroke-width="2"><polyline points="1 12 5 16 12 6"/><polyline points="7 12 11 16 20 6"/></svg></span>
      </div>
    `;

    messages.appendChild(msgDiv);
    chatInput.value = '';
    messages.scrollTop = messages.scrollHeight;
  }

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
