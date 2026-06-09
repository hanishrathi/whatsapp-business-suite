/* =========================================================
   Contacts / Templates / Broadcasts — live, per-user data
   ========================================================= */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function pill(status) {
    return `<span class="status-pill ${esc(status)}">${esc(status)}</span>`;
  }
  function loggedIn() {
    return typeof API !== 'undefined' && API.isLoggedIn();
  }

  /* ---------- generic create/edit modal ---------- */
  const modal = () => document.getElementById('entityModal');
  let saveHandler = null;

  function openEntityModal(title, fieldsHtml, onSave) {
    document.getElementById('entityModalTitle').textContent = title;
    document.getElementById('entityModalBody').innerHTML = fieldsHtml;
    saveHandler = onSave;
    modal().classList.add('open');
  }
  function closeEntityModal() {
    modal().classList.remove('open');
    saveHandler = null;
  }
  function field(label, id, opts = {}) {
    const { type = 'text', placeholder = '', value = '', textarea = false, select = null } = opts;
    let input;
    if (select) {
      input = `<select class="form-input" id="${id}">${select.map(o =>
        `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (textarea) {
      input = `<textarea class="form-input" id="${id}" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
    } else {
      input = `<input type="${type}" class="form-input" id="${id}" placeholder="${esc(placeholder)}" value="${esc(value)}">`;
    }
    return `<div class="form-group"><label class="form-label">${esc(label)}</label>${input}</div>`;
  }
  function val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

  /* ---------- Contacts ---------- */
  async function loadContacts(q) {
    const tbody = document.getElementById('contactsTableBody');
    if (!tbody) return;
    if (!loggedIn()) { tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">Log in to manage contacts.</td></tr>`; return; }
    const res = await API.getContacts(q);
    if (!res.success || !res.contacts.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">No contacts yet. Click “+ New Contact” to add one.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.contacts.map(c => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td>${esc(c.phone)}</td>
        <td>${esc(c.email || '—')}</td>
        <td>${(c.tags || []).map(t => `<span class="tag tag-blue">${esc(t)}</span>`).join(' ') || '—'}</td>
        <td>${pill(c.status)}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="row-action-btn" data-edit-contact='${esc(JSON.stringify(c))}'>Edit</button>
          <button class="row-action-btn danger" data-del-contact="${c._id}">Delete</button>
        </td>
      </tr>`).join('');
  }

  function contactModal(existing) {
    const c = existing || {};
    openEntityModal(existing ? 'Edit Contact' : 'New Contact',
      field('Name', 'ecName', { value: c.name, placeholder: 'Jane Doe' }) +
      field('Phone', 'ecPhone', { value: c.phone, placeholder: '+91 98765 43210' }) +
      field('Email', 'ecEmail', { value: c.email, placeholder: 'jane@example.com' }) +
      field('Tags (comma separated)', 'ecTags', { value: (c.tags || []).join(', '), placeholder: 'vip, lead' }) +
      field('Notes', 'ecNotes', { value: c.notes, textarea: true, placeholder: 'Optional notes…' }),
      async () => {
        const data = { name: val('ecName'), phone: val('ecPhone'), email: val('ecEmail'), tags: val('ecTags'), notes: val('ecNotes') };
        if (!data.name || !data.phone) return alert('Name and phone are required.');
        const res = existing ? await API.updateContact(existing._id, data) : await API.createContact(data);
        if (!res.success) return alert(res.message || 'Failed to save contact.');
        closeEntityModal(); loadContacts();
      });
  }

  /* ---------- Templates ---------- */
  async function loadTemplates() {
    const tbody = document.getElementById('templatesTableBody');
    if (!tbody) return;
    if (!loggedIn()) { tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">Log in to manage templates.</td></tr>`; return; }
    const res = await API.getTemplates();
    if (!res.success || !res.templates.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">No templates yet. Click “+ New Template” to create one.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.templates.map(t => `
      <tr>
        <td><strong>${esc(t.name)}</strong></td>
        <td>${esc(t.category)}</td>
        <td>${esc(t.language)}</td>
        <td>${t.variableCount}</td>
        <td>${pill(t.status)}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="row-action-btn" data-edit-template='${esc(JSON.stringify(t))}'>Edit</button>
          <button class="row-action-btn danger" data-del-template="${t._id}">Delete</button>
        </td>
      </tr>`).join('');
  }

  function templateModal(existing) {
    const t = existing || {};
    openEntityModal(existing ? 'Edit Template' : 'New Template',
      field('Name', 'etName', { value: t.name, placeholder: 'order_confirmation' }) +
      field('Category', 'etCategory', { value: t.category || 'marketing', select: [
        { value: 'marketing', label: 'Marketing' }, { value: 'utility', label: 'Utility' }, { value: 'authentication', label: 'Authentication' }] }) +
      field('Language', 'etLang', { value: t.language || 'en', placeholder: 'en' }) +
      field('Body (use {{1}}, {{2}} for variables)', 'etBody', { value: t.body, textarea: true, placeholder: 'Hi {{1}}, your order {{2}} has shipped!' }),
      async () => {
        const data = { name: val('etName'), category: val('etCategory'), language: val('etLang'), body: val('etBody') };
        if (!data.name || !data.body) return alert('Name and body are required.');
        const res = existing ? await API.updateTemplate(existing._id, data) : await API.createTemplate(data);
        if (!res.success) return alert(res.message || 'Failed to save template.');
        closeEntityModal(); loadTemplates();
      });
  }

  /* ---------- Broadcasts ---------- */
  async function loadBroadcasts() {
    const tbody = document.getElementById('broadcastsTableBody');
    if (!tbody) return;
    if (!loggedIn()) { tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">Log in to manage broadcasts.</td></tr>`; return; }
    const res = await API.getBroadcasts();
    if (!res.success || !res.broadcasts.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">No broadcasts yet. Click “+ New Broadcast” to create one.</td></tr>`;
      return;
    }
    tbody.innerHTML = res.broadcasts.map(b => `
      <tr>
        <td><strong>${esc(b.name)}</strong></td>
        <td>${b.audienceCount} contacts</td>
        <td>${pill(b.status)}</td>
        <td>${b.sentCount || 0}</td>
        <td>${new Date(b.createdAt).toLocaleDateString()}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="row-action-btn danger" data-del-broadcast="${b._id}">Delete</button>
        </td>
      </tr>`).join('');
  }

  function broadcastModal() {
    openEntityModal('New Broadcast',
      field('Name', 'ebName', { placeholder: 'Diwali Sale Blast' }) +
      field('Message', 'ebMsg', { textarea: true, placeholder: 'Your message to send…' }) +
      field('Audience tag', 'ebTag', { value: 'all', placeholder: 'all, or a tag like "vip"' }),
      async () => {
        const data = { name: val('ebName'), message: val('ebMsg'), audienceTag: val('ebTag') || 'all' };
        if (!data.name || !data.message) return alert('Name and message are required.');
        const res = await API.createBroadcast(data);
        if (!res.success) return alert(res.message || 'Failed to create broadcast.');
        closeEntityModal(); loadBroadcasts();
      });
  }

  /* ---------- wire everything on load ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    // Hook navigation so data loads when a page is opened.
    const origNav = window.navigateToPage;
    window.navigateToPage = function (page) {
      if (typeof origNav === 'function') origNav(page);
      if (page === 'contacts') loadContacts();
      else if (page === 'templates') loadTemplates();
      else if (page === 'broadcasts') loadBroadcasts();
    };

    // "+ New" buttons
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('newContactBtn', () => contactModal());
    on('newTemplateBtn', () => templateModal());
    on('newBroadcastBtn', () => broadcastModal());

    // Contact search (debounced)
    const search = document.getElementById('contactSearch');
    if (search) {
      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => loadContacts(search.value.trim()), 300);
      });
    }

    // Modal close/cancel/save
    on('entityModalClose', closeEntityModal);
    on('entityModalCancel', closeEntityModal);
    on('entityModalSave', () => { if (saveHandler) saveHandler(); });
    const m = modal();
    if (m) m.addEventListener('click', e => { if (e.target === m) closeEntityModal(); });

    // Table row actions (event delegation)
    document.addEventListener('click', async (e) => {
      const t = e.target;
      if (t.dataset.editContact) return contactModal(JSON.parse(t.dataset.editContact));
      if (t.dataset.delContact) { if (confirm('Delete this contact?')) { await API.deleteContact(t.dataset.delContact); loadContacts(); } }
      if (t.dataset.editTemplate) return templateModal(JSON.parse(t.dataset.editTemplate));
      if (t.dataset.delTemplate) { if (confirm('Delete this template?')) { await API.deleteTemplate(t.dataset.delTemplate); loadTemplates(); } }
      if (t.dataset.delBroadcast) { if (confirm('Delete this broadcast?')) { await API.deleteBroadcast(t.dataset.delBroadcast); loadBroadcasts(); } }
    });
  });
})();
