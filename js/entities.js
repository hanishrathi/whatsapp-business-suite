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
  let broadcastPollTimer = null;

  async function loadBroadcasts() {
    const tbody = document.getElementById('broadcastsTableBody');
    if (!tbody) return;
    if (!loggedIn()) { tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">Log in to manage broadcasts.</td></tr>`; return; }
    const res = await API.getBroadcasts();
    if (!res.success || !res.broadcasts.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">No broadcasts yet. Click “+ New Broadcast” to create one.</td></tr>`;
      stopBroadcastPolling();
      return;
    }
    tbody.innerHTML = res.broadcasts.map(b => {
      const sendable = ['draft', 'scheduled', 'failed'].includes(b.status);
      const progress = b.status === 'sending'
        ? `${b.sentCount || 0}/${b.audienceCount || '?'}…`
        : `${b.sentCount || 0}${b.failedCount ? ` <span style="color:#FF6B6B">(${b.failedCount} failed)</span>` : ''}`;
      return `
      <tr>
        <td><strong>${esc(b.name)}</strong>${b.scheduledAt && b.status === 'scheduled' ? `<br><small style="color:#86868b">⏱ ${new Date(b.scheduledAt).toLocaleString()}</small>` : ''}</td>
        <td>${b.audienceCount} contacts</td>
        <td>${pill(b.status)}</td>
        <td>${progress}</td>
        <td>${new Date(b.createdAt).toLocaleDateString()}</td>
        <td style="text-align:right;white-space:nowrap;">
          ${sendable ? `<button class="row-action-btn" data-send-broadcast="${b._id}" data-broadcast-name="${esc(b.name)}" data-audience="${b.audienceCount}">Send now</button>` : ''}
          ${b.status === 'sending' ? `<button class="row-action-btn" disabled style="opacity:.5">Sending…</button>` : ''}
          <button class="row-action-btn danger" data-del-broadcast="${b._id}">Delete</button>
        </td>
      </tr>`;
    }).join('');

    // While anything is sending, refresh every 2.5s so the customer sees progress.
    if (res.broadcasts.some(b => b.status === 'sending')) startBroadcastPolling();
    else stopBroadcastPolling();
  }

  function startBroadcastPolling() {
    if (broadcastPollTimer) return;
    broadcastPollTimer = setInterval(() => {
      const page = document.getElementById('page-broadcasts');
      if (page && page.classList.contains('active')) loadBroadcasts();
      else stopBroadcastPolling();
    }, 2500);
  }
  function stopBroadcastPolling() {
    if (broadcastPollTimer) { clearInterval(broadcastPollTimer); broadcastPollTimer = null; }
  }

  function broadcastModal() {
    openEntityModal('New Broadcast',
      field('Name', 'ebName', { placeholder: 'Diwali Sale Blast' }) +
      field('Message — use {{name}} to personalize', 'ebMsg', { textarea: true, placeholder: 'Hi {{name}}, our Diwali sale is live! 🎉' }) +
      field('Audience tag', 'ebTag', { value: 'all', placeholder: 'all, or a tag like "vip"' }) +
      field('Schedule (optional — leave empty to send manually)', 'ebWhen', { type: 'datetime-local' }),
      async () => {
        const data = { name: val('ebName'), message: val('ebMsg'), audienceTag: val('ebTag') || 'all' };
        if (!data.name || !data.message) return alert('Name and message are required.');
        const when = val('ebWhen');
        if (when) {
          const ts = new Date(when);
          if (isNaN(ts) || ts.getTime() < Date.now()) return alert('The scheduled time must be in the future.');
          data.scheduledAt = ts.toISOString();
        }
        const res = await API.createBroadcast(data);
        if (!res.success) return alert(res.message || 'Failed to create broadcast.');
        closeEntityModal(); loadBroadcasts();
        if (data.scheduledAt) alert('Broadcast scheduled. It will send automatically at the chosen time.');
      });
  }

  /* ---------- CSV import / export ---------- */
  function parseCsv(text) {
    // Minimal CSV parser (handles quoted cells with commas).
    const rows = [];
    let row = [], cell = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cell += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
  }

  async function importCsvFile(file) {
    const text = await file.text();
    const rows = parseCsv(text);
    if (!rows.length) return alert('That file looks empty.');

    // Find the columns: use a header row if there is one, else assume name,phone.
    const header = rows[0].map(h => h.trim().toLowerCase());
    const hasHeader = header.includes('name') || header.includes('phone');
    const idx = {
      name: hasHeader ? header.indexOf('name') : 0,
      phone: hasHeader ? header.indexOf('phone') : 1,
      email: hasHeader ? header.indexOf('email') : -1,
      tags: hasHeader ? header.indexOf('tags') : -1,
      notes: hasHeader ? header.indexOf('notes') : -1,
    };
    if (idx.name < 0 || idx.phone < 0) return alert('The CSV needs "name" and "phone" columns.');

    const dataRows = (hasHeader ? rows.slice(1) : rows).map(r => ({
      name: (r[idx.name] || '').trim(),
      phone: (r[idx.phone] || '').trim(),
      email: idx.email >= 0 ? (r[idx.email] || '').trim() : '',
      tags: idx.tags >= 0 ? (r[idx.tags] || '').replace(/\|/g, ',') : '',
      notes: idx.notes >= 0 ? (r[idx.notes] || '').trim() : '',
    })).filter(r => r.name && r.phone);

    if (!dataRows.length) return alert('No rows with both a name and a phone found.');
    if (!confirm(`Import ${dataRows.length} contact${dataRows.length === 1 ? '' : 's'} from "${file.name}"?`)) return;

    let added = 0, skipped = 0;
    for (let i = 0; i < dataRows.length; i += 400) {
      const res = await API.importContacts(dataRows.slice(i, i + 400));
      if (!res.success) return alert(res.message || 'Import failed part-way. Some contacts may have been added.');
      added += res.added; skipped += res.skipped;
    }
    alert(`Done! Imported ${added} contact${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} (duplicates or bad rows)` : ''}.`);
    loadContacts();
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

    // CSV import / export
    const importBtn = document.getElementById('importContactsBtn');
    const csvInput = document.getElementById('csvFileInput');
    if (importBtn && csvInput) {
      importBtn.addEventListener('click', () => csvInput.click());
      csvInput.addEventListener('change', () => {
        if (csvInput.files && csvInput.files[0]) importCsvFile(csvInput.files[0]);
        csvInput.value = '';
      });
    }
    const exportBtn = document.getElementById('exportContactsBtn');
    if (exportBtn) exportBtn.addEventListener('click', async () => {
      const res = await API.exportContactsCsv();
      if (!res.success) alert(res.message || 'Export failed.');
    });

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
      if (t.dataset.sendBroadcast) {
        const name = t.dataset.broadcastName || 'this broadcast';
        const audience = t.dataset.audience || '?';
        if (!confirm(`Send "${name}" on WhatsApp to ${audience} contact${audience === '1' ? '' : 's'} now?\n\nThis sends real messages and cannot be undone.`)) return;
        t.disabled = true; t.textContent = 'Starting…';
        const res = await API.sendBroadcast(t.dataset.sendBroadcast);
        if (!res.success) {
          alert(res.message || 'Could not start sending.');
          t.disabled = false; t.textContent = 'Send now';
        }
        loadBroadcasts();
      }
    });
  });
})();
