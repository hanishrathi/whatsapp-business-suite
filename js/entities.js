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
    tbody.innerHTML = res.contacts.map(c => {
      // Consent is the thing that decides whether this contact can be messaged,
      // so it gets its own column rather than hiding inside the status pill.
      const consent = c.optOutAt
        ? `<span class="status-pill unsubscribed" title="${esc(c.optOutReason || '')}">opted out</span>`
        : c.optInAt
          ? `<span class="status-pill active" title="${esc(c.optInSource || '')}">opted in</span>`
          : `<span class="status-pill inactive" title="Excluded from broadcasts">no consent</span>`;
      const consentAction = c.optOutAt || !c.optInAt
        ? `<button class="row-action-btn" data-optin-contact="${c._id}">Record opt-in</button>`
        : `<button class="row-action-btn" data-optout-contact="${c._id}">Opt out</button>`;
      return `
      <tr>
        <td><strong>${esc(c.name)}</strong>${c.serviceWindowOpen ? ' <span title="Replied in the last 24h — you can send free-form messages">💬</span>' : ''}</td>
        <td>${esc(c.phone)}</td>
        <td>${esc(c.email || '—')}</td>
        <td>${(c.tags || []).map(t => `<span class="tag tag-blue">${esc(t)}</span>`).join(' ') || '—'}</td>
        <td>${consent}</td>
        <td style="text-align:right;white-space:nowrap;">
          ${consentAction}
          <button class="row-action-btn" data-edit-contact='${esc(JSON.stringify(c))}'>Edit</button>
          <button class="row-action-btn danger" data-del-contact="${c._id}">Delete</button>
        </td>
      </tr>`;
    }).join('');

    updateConsentBanner(res.contacts);
  }

  /*
   * Contacts created before consent tracking have no opt-in record and are
   * excluded from every audience. Surface that rather than letting someone
   * wonder why their broadcast reaches nobody.
   */
  function updateConsentBanner(list) {
    const banner = document.getElementById('consentBackfillBanner');
    if (!banner) return;
    const missing = (list || []).filter(c => !c.optInAt && !c.optOutAt).length;
    banner.style.display = missing ? '' : 'none';
    const count = document.getElementById('consentBackfillCount');
    if (count) count.textContent = `${missing} contact${missing === 1 ? '' : 's'}`;
  }

  function contactModal(existing) {
    const c = existing || {};
    // Consent is captured at creation. For an existing contact it is shown as
    // read-only state and changed through the explicit opt-in/opt-out actions,
    // so it always carries a real timestamp and source.
    const consentBlock = existing
      ? `<div class="form-group">
           <label class="form-label">Consent</label>
           <div style="font-size:13px;color:#6e6e73;line-height:1.6;">
             ${c.optOutAt
               ? `🚫 Opted out ${new Date(c.optOutAt).toLocaleDateString()}${c.optOutReason ? ` — ${esc(c.optOutReason)}` : ''}`
               : c.optInAt
                 ? `✅ Opted in ${new Date(c.optInAt).toLocaleDateString()}${c.optInSource ? ` — ${esc(c.optInSource)}` : ''}`
                 : '⚠️ No opt-in recorded. This contact is excluded from broadcasts.'}
           </div>
         </div>`
      : field('How did they opt in? (required to message them)', 'ecOptIn', {
          placeholder: 'e.g. checkout form, signed order, replied to enquiry',
        }) +
        `<div class="form-group" style="margin-top:-8px;">
           <small style="color:#86868b;font-size:12px;line-height:1.5;display:block;">
             WhatsApp requires recorded consent before a business messages someone.
             Leave blank to save the contact without consent — they will be excluded from broadcasts.
           </small>
         </div>`;

    openEntityModal(existing ? 'Edit Contact' : 'New Contact',
      field('Name', 'ecName', { value: c.name, placeholder: 'Jane Doe' }) +
      field('Phone (with country code)', 'ecPhone', { value: c.phone, placeholder: '+91 98765 43210' }) +
      field('Email', 'ecEmail', { value: c.email, placeholder: 'jane@example.com' }) +
      field('Tags (comma separated)', 'ecTags', { value: (c.tags || []).join(', '), placeholder: 'vip, lead' }) +
      field('Notes', 'ecNotes', { value: c.notes, textarea: true, placeholder: 'Optional notes…' }) +
      consentBlock,
      async () => {
        const data = { name: val('ecName'), phone: val('ecPhone'), email: val('ecEmail'), tags: val('ecTags'), notes: val('ecNotes') };
        if (!data.name || !data.phone) return alert('Name and phone are required.');
        if (!existing) data.optInSource = val('ecOptIn');
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
    tbody.innerHTML = res.templates.map(t => {
      // Only Meta can approve a template, and only an approved one can be sent.
      const status = t.isSendable
        ? `<span class="status-pill active">approved</span>`
        : t.metaStatus
          ? `<span class="status-pill inactive" title="${esc(t.rejectedReason || '')}">${esc(t.metaStatus.toLowerCase())}</span>`
          : `<span class="status-pill inactive" title="Not submitted to Meta yet">local draft</span>`;
      return `
      <tr>
        <td><strong>${esc(t.name)}</strong></td>
        <td>${esc(t.category)}</td>
        <td>${esc(t.language)}</td>
        <td>${t.variableCount}</td>
        <td>${status}</td>
        <td style="text-align:right;white-space:nowrap;">
          ${t.metaId ? '' : `<button class="row-action-btn" data-edit-template='${esc(JSON.stringify(t))}'>Edit</button>`}
          <button class="row-action-btn danger" data-del-template="${t._id}">Delete</button>
        </td>
      </tr>`;
    }).join('');
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
    const [res, accRes] = await Promise.all([API.getBroadcasts(), API.getAccounts()]);
    if (!res.success || !res.broadcasts.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="entity-empty">No broadcasts yet. Click “+ New Broadcast” to create one.</td></tr>`;
      stopBroadcastPolling();
      return;
    }
    // Manual channels can't be sent automatically — they get a handoff button.
    const manualIds = new Set(((accRes && accRes.accounts) || []).filter(a => !a.canAutoSend).map(a => a._id));

    tbody.innerHTML = res.broadcasts.map(b => {
      const isManual = b.accountId && manualIds.has(b.accountId);
      const sendable = !isManual && ['draft', 'scheduled', 'failed'].includes(b.status);
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
          ${isManual ? `<button class="row-action-btn" data-handoff-broadcast="${b._id}" data-broadcast-name="${esc(b.name)}">Open in WhatsApp</button>` : ''}
          ${!isManual && b.failedCount ? `<button class="row-action-btn" data-retry-broadcast="${b._id}" data-failed="${b.failedCount}">Retry ${b.failedCount} failed</button>` : ''}
          ${b.status === 'sending' ? `<button class="row-action-btn" disabled style="opacity:.5">Sending…</button>` : ''}
          <button class="row-action-btn danger" data-del-broadcast="${b._id}">Delete</button>
        </td>
      </tr>`;
    }).join('');

    // While anything is sending, refresh every 2.5s so the customer sees progress.
    if (res.broadcasts.some(b => b.status === 'sending')) startBroadcastPolling();
    else stopBroadcastPolling();
  }

  /*
   * Manual channels have no API, so the operator sends each message from their
   * own WhatsApp app. This lists the ready-made click-to-chat links; opening
   * one launches WhatsApp (Business or regular, whichever is installed) with
   * the text pre-filled.
   */
  function showHandoffLinks(name, links) {
    openEntityModal(`Send "${name}" yourself`,
      `<p style="font-size:13px;color:#6e6e73;line-height:1.6;margin:0 0 16px;">
         ${links.length} opted-in contact${links.length === 1 ? '' : 's'}. Open each chat and press send in WhatsApp.
         Meta publishes no API for the WhatsApp Business app or regular WhatsApp, so this is the compliant way to use this number.
       </p>
       <div style="max-height:320px;overflow:auto;border:1px solid #e8e8ed;border-radius:12px;">
         ${links.map((l, i) => `
           <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;${i ? 'border-top:1px solid #f0f0f4;' : ''}">
             <div style="min-width:0;">
               <div style="font-weight:600;font-size:13px;">${esc(l.name)}</div>
               <div style="font-size:12px;color:#86868b;">${esc(l.phone)}</div>
             </div>
             <a class="row-action-btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Open chat</a>
           </div>`).join('')}
       </div>`,
      null);
    // Nothing to save — turn the footer's Save into a plain close.
    const save = document.getElementById('entityModalSave');
    if (save) { save.textContent = 'Done'; save.onclick = () => { save.textContent = 'Save'; save.onclick = null; closeEntityModal(); }; }
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

  /*
   * A broadcast is business-initiated, so WhatsApp requires an approved
   * template. The only exception is a manual channel, where the operator types
   * the message into their own WhatsApp app — there the app supplies text and
   * a click-to-chat link, and free-form wording is fine.
   */
  async function broadcastModal() {
    const [accRes, tplRes] = await Promise.all([API.getAccounts(), API.getTemplates()]);
    const accounts = (accRes && accRes.accounts) || [];
    const approved = ((tplRes && tplRes.templates) || []).filter(t => t.isSendable);

    const cloudAccounts = accounts.filter(a => a.canAutoSend);
    const manualAccounts = accounts.filter(a => !a.canAutoSend);

    if (!accounts.length) {
      return alert('Add a WhatsApp account first, on the Accounts page.');
    }

    const accountOptions = [
      ...cloudAccounts.map(a => ({ value: a._id, label: `${a.name} (${a.phone}) — Cloud API` })),
      ...manualAccounts.map(a => ({ value: a._id, label: `${a.name} (${a.phone}) — manual, you send` })),
    ];
    const firstAccount = accountOptions[0] ? accountOptions[0].value : '';

    const templateOptions = approved.length
      ? approved.map(t => ({ value: t._id, label: `${t.name} (${t.language}) — ${t.category}` }))
      : [{ value: '', label: 'No approved templates — sync on the Templates page' }];

    openEntityModal('New Broadcast',
      field('Name', 'ebName', { placeholder: 'Diwali Sale Blast' }) +
      field('Send from', 'ebAccount', { value: firstAccount, select: accountOptions }) +
      `<div id="ebTemplateWrap">` +
        field('Approved template', 'ebTemplate', { select: templateOptions }) +
      `</div>` +
      `<div id="ebMessageWrap" style="display:none;">` +
        field('Message — use {{name}} to personalize', 'ebMsg', {
          textarea: true, placeholder: 'Hi {{name}}, we are open until 9pm today!',
        }) +
      `</div>` +
      `<div class="form-group" id="ebChannelNote" style="margin-top:-8px;"></div>` +
      field('Audience tag', 'ebTag', { value: 'all', placeholder: 'all, or a tag like "vip"' }) +
      field('Schedule (optional — leave empty to send manually)', 'ebWhen', { type: 'datetime-local' }),
      async () => {
        const accountId = val('ebAccount');
        const isManual = manualAccounts.some(a => a._id === accountId);
        const data = { name: val('ebName'), audienceTag: val('ebTag') || 'all', accountId };
        if (!data.name) return alert('Give the broadcast a name.');

        if (isManual) {
          data.message = val('ebMsg');
          if (!data.message) return alert('Enter the message text to hand off to your WhatsApp app.');
        } else {
          data.templateId = val('ebTemplate');
          if (!data.templateId) {
            return alert('Pick an approved template. Business-initiated messages must use one — sync your templates from Meta on the Templates page.');
          }
        }

        const when = val('ebWhen');
        if (when) {
          const ts = new Date(when);
          if (isNaN(ts) || ts.getTime() < Date.now()) return alert('The scheduled time must be in the future.');
          data.scheduledAt = ts.toISOString();
        }
        const res = await API.createBroadcast(data);
        if (!res.success) return alert(res.message || 'Failed to create broadcast.');
        closeEntityModal(); loadBroadcasts();
        if (res.excluded) {
          alert(`${res.message}\n\nOnly contacts with recorded opt-in receive broadcasts.`);
        } else if (data.scheduledAt) {
          alert('Broadcast scheduled. It will send automatically at the chosen time.');
        }
      });

    // Swap template picker / free-form box depending on the channel.
    const syncChannelFields = () => {
      const accountId = val('ebAccount');
      const isManual = manualAccounts.some(a => a._id === accountId);
      document.getElementById('ebTemplateWrap').style.display = isManual ? 'none' : '';
      document.getElementById('ebMessageWrap').style.display = isManual ? '' : 'none';
      document.getElementById('ebChannelNote').innerHTML = isManual
        ? `<small style="color:#86868b;font-size:12px;line-height:1.5;display:block;">
             This number is used through your own WhatsApp app. Sending produces one
             click-to-chat link per opted-in contact, which you open and send yourself.
           </small>`
        : `<small style="color:#86868b;font-size:12px;line-height:1.5;display:block;">
             Only Meta-approved templates can be sent to contacts who have not messaged
             you in the last 24 hours. ${approved.length ? '' : 'You have none yet — sync them on the Templates page.'}
           </small>`;
    };
    const accSelect = document.getElementById('ebAccount');
    if (accSelect) accSelect.addEventListener('change', syncChannelFields);
    syncChannelFields();
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

    // WhatsApp requires demonstrable opt-in before messaging. Ask where this
    // list's consent came from rather than importing a blastable list silently.
    const optInSource = prompt(
      `Importing ${dataRows.length} contact${dataRows.length === 1 ? '' : 's'} from "${file.name}".\n\n` +
      'How did these people consent to hear from you on WhatsApp?\n' +
      '(e.g. "checkout opt-in checkbox", "trade show sign-up sheet Mar 2026")\n\n' +
      'Leave blank to import without consent — they will be excluded from broadcasts until you record it.',
      ''
    );
    // prompt() returns null when cancelled; '' means "import without consent".
    if (optInSource === null) return;

    let added = 0, skipped = 0, invalidPhone = 0;
    for (let i = 0; i < dataRows.length; i += 400) {
      const res = await API.importContacts(dataRows.slice(i, i + 400), optInSource);
      if (!res.success) return alert(res.message || 'Import failed part-way. Some contacts may have been added.');
      added += res.added; skipped += res.skipped; invalidPhone += (res.invalidPhone || 0);
    }
    const notes = [];
    if (skipped) notes.push(`skipped ${skipped} (duplicates or bad rows${invalidPhone ? `, ${invalidPhone} with no country code` : ''})`);
    if (!optInSource.trim() && added) notes.push('none are marked as opted in, so broadcasts will not reach them');
    alert(`Done! Imported ${added} contact${added === 1 ? '' : 's'}${notes.length ? `; ${notes.join('; ')}` : ''}.`);
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
    on('consentBackfillBtn', async () => {
      const source = prompt(
        'Where did consent for your existing contacts come from?\n' +
        '(e.g. "opt-in checkbox on our signup form since 2024", "signed service agreements")\n\n' +
        'Only record this if it is true — Meta can ask you to demonstrate it, and messaging without consent gets numbers banned.',
        ''
      );
      if (source === null) return;
      if (!source.trim()) return alert('A consent source is required.');
      const res = await API.optInExistingContacts(source.trim());
      alert(res.success ? res.message : (res.message || 'Could not record consent.'));
      if (res.success) loadContacts();
    });

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
      if (t.dataset.optinContact) {
        const source = prompt('How did this person consent to hear from you on WhatsApp?\n(e.g. "checkout form", "signed order", "replied to enquiry")', '');
        if (source === null) return;
        const res = await API.optInContact(t.dataset.optinContact, source.trim());
        if (!res.success) return alert(res.message || 'Could not record opt-in.');
        loadContacts();
      }
      if (t.dataset.optoutContact) {
        if (!confirm('Record an opt-out? This contact will be excluded from every broadcast.')) return;
        const res = await API.optOutContact(t.dataset.optoutContact, 'Recorded in dashboard');
        if (!res.success) return alert(res.message || 'Could not record opt-out.');
        loadContacts();
      }
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
      if (t.dataset.retryBroadcast) {
        if (!confirm(`Retry the ${t.dataset.failed} failed recipient(s)?\n\nOnly transient failures (rate limits, network errors) are retried — numbers that are not on WhatsApp are skipped.`)) return;
        t.disabled = true; t.textContent = 'Retrying…';
        const res = await API.retryBroadcast(t.dataset.retryBroadcast);
        if (!res.success) { alert(res.message || 'Could not retry.'); t.disabled = false; }
        loadBroadcasts();
      }
      if (t.dataset.handoffBroadcast) {
        const res = await API.getBroadcastHandoff(t.dataset.handoffBroadcast);
        if (!res.success) return alert(res.message || 'Could not build chat links.');
        showHandoffLinks(t.dataset.broadcastName || 'Broadcast', res.links);
      }
      if (t.dataset.syncTemplates) {
        t.disabled = true; t.textContent = 'Syncing…';
        const res = await API.syncTemplates();
        t.disabled = false; t.textContent = 'Sync from Meta';
        alert(res.success ? res.message : (res.message || 'Template sync failed.'));
        if (res.success) loadTemplates();
      }
    });
  });
})();
