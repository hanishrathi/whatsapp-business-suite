/* =========================================================
   Conversations — real message threads from the Cloud API.

   The 24-hour customer service window is what makes a free-form reply legal.
   The server enforces it on every send; this UI mirrors that state so the
   operator can see when the window closes and what they can do after it.
   ========================================================= */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function loggedIn() {
    return typeof API !== 'undefined' && API.isLoggedIn();
  }
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  }
  function relTime(d) {
    if (!d) return '';
    const ms = Date.now() - new Date(d).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }

  let conversations = [];
  let activeContactId = null;
  let filter = 'all';
  let pollTimer = null;

  /* ---------- list ---------- */

  async function loadConversations() {
    const el = document.getElementById('convoList');
    if (!el) return;
    if (!loggedIn()) {
      el.innerHTML = `<div style="padding:24px 16px;text-align:center;color:#86868b;font-size:13px;">Log in to see conversations.</div>`;
      return;
    }
    const res = await API.getConversations();
    conversations = (res.success && res.conversations) || [];
    renderList();
    // Keep the open thread fresh while the page is visible.
    if (activeContactId) loadThread(activeContactId, { quiet: true });
  }

  function renderList() {
    const el = document.getElementById('convoList');
    if (!el) return;

    const q = (document.getElementById('convoSearch') || {}).value || '';
    let rows = conversations;
    if (filter === 'open') rows = rows.filter(c => c.serviceWindowOpen);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(c => (c.name || '').toLowerCase().includes(needle) || (c.phone || '').includes(needle));
    }

    if (!rows.length) {
      el.innerHTML = `<div style="padding:32px 16px;text-align:center;color:#86868b;font-size:13px;line-height:1.7;">
        ${conversations.length
          ? 'No conversations match that filter.'
          : 'No conversations yet.<br>A thread appears here when a customer messages one of your Cloud API numbers.'}
      </div>`;
      return;
    }

    el.innerHTML = rows.map(c => `
      <div class="convo-item-full ${c.contactId === activeContactId ? 'active' : ''}" data-open-convo="${esc(c.contactId)}">
        <div class="convo-avatar" style="background:${c.serviceWindowOpen ? '#25D366' : '#86868b'}">${esc(initials(c.name))}</div>
        <div class="convo-body">
          <div class="convo-top">
            <span class="convo-name">${esc(c.name)}</span>
            <span class="convo-time">${esc(relTime(c.lastAt))}</span>
          </div>
          <p class="convo-msg">${c.lastDirection === 'out' ? '<span style="color:#86868b">You: </span>' : ''}${esc(c.lastMessage)}</p>
          <div class="convo-tags">
            ${c.serviceWindowOpen
              ? '<span class="mini-tag" style="background:#E8F8EE;color:#1a7f43;">window open</span>'
              : '<span class="mini-tag">template only</span>'}
            ${c.hasOptIn ? '' : '<span class="mini-tag" style="background:#FFF4E5;color:#8a5a00;">no consent</span>'}
          </div>
        </div>
      </div>`).join('');
  }

  /* ---------- thread ---------- */

  async function loadThread(contactId, opts = {}) {
    const res = await API.getConversation(contactId);
    if (!res.success) return;
    activeContactId = contactId;
    // On phones the list and the thread share one pane; this swaps to the thread.
    const layout = document.querySelector('.conversations-layout');
    if (layout) layout.classList.add('thread-open');

    const convo = conversations.find(c => c.contactId === contactId) || {};
    const nameEl = document.getElementById('chatUserName');
    const statusEl = document.getElementById('chatUserStatus');
    const avatarEl = document.getElementById('chatAvatar');
    if (nameEl) nameEl.textContent = convo.name || 'Conversation';
    if (avatarEl) avatarEl.textContent = initials(convo.name);
    if (statusEl) statusEl.textContent = convo.phone || '';

    renderMessages(res.messages || []);
    renderWindowState(res.window || {});
    if (!opts.quiet) renderList();
  }

  function renderMessages(list) {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = `<div style="padding:40px 16px;text-align:center;color:#86868b;font-size:13px;">No messages in this conversation yet.</div>`;
      return;
    }
    const tick = m => {
      if (m.direction !== 'out') return '';
      if (m.status === 'failed') return ' <span style="color:#FF6B6B" title="Failed">!</span>';
      if (m.status === 'read') return ' <span style="color:#34B7F1" title="Read">✓✓</span>';
      if (m.status === 'delivered') return ' <span title="Delivered">✓✓</span>';
      return ' <span title="Sent">✓</span>';
    };
    el.innerHTML = list.map(m => `
      <div class="chat-bubble ${m.direction === 'out' ? 'sent' : 'received'}">
        <p>${esc(m.body)}</p>
        <span class="chat-time">${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${tick(m)}</span>
        ${m.status === 'failed' && m.error ? `<span class="chat-time" style="color:#FF6B6B">${esc(m.error)}</span>` : ''}
      </div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  /*
   * The whole point of tracking the window: show whether a free-form reply is
   * allowed right now, and say what to do instead when it is not.
   */
  function renderWindowState(w) {
    const notice = document.getElementById('chatWindowNotice');
    const input = document.getElementById('chatText');
    const send = document.getElementById('chatSendBtn');
    if (!notice || !input || !send) return;

    notice.style.display = '';
    if (w.open) {
      const mins = Math.max(0, Math.round((new Date(w.expiresAt).getTime() - Date.now()) / 60000));
      const hrs = Math.floor(mins / 60);
      notice.style.background = '#E8F8EE';
      notice.style.color = '#1a7f43';
      notice.innerHTML = `💬 Service window open — free-form replies allowed for another ${hrs ? hrs + 'h ' : ''}${mins % 60}m.`;
      input.disabled = false;
      send.disabled = false;
      input.placeholder = 'Type a reply…';
    } else {
      notice.style.background = '#FFF4E5';
      notice.style.color = '#8a5a00';
      notice.innerHTML = w.lastInboundAt
        ? `⏳ The 24-hour service window closed. Free-form replies are no longer allowed — send an approved template from <strong>Broadcasts</strong> instead.`
        : `This contact has never messaged you. Business-initiated messages must use an approved template.`;
      input.disabled = true;
      send.disabled = true;
      input.placeholder = 'Window closed — use an approved template';
    }
  }

  async function sendReply() {
    const input = document.getElementById('chatText');
    const send = document.getElementById('chatSendBtn');
    if (!input || !activeContactId) return;
    const body = input.value.trim();
    if (!body) return;

    input.disabled = true; send.disabled = true;
    const res = await API.replyToConversation(activeContactId, body);
    input.disabled = false; send.disabled = false;

    if (!res.success) {
      alert(res.message || 'Could not send the reply.');
      // A closed window is the common case — refresh so the UI reflects it.
      if (res.code === 'WINDOW_CLOSED' || res.code === 'OPTED_OUT') loadThread(activeContactId);
      return;
    }
    input.value = '';
    await loadThread(activeContactId);
    loadConversations();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      const page = document.getElementById('page-conversations');
      if (page && page.classList.contains('active')) loadConversations();
      else stopPolling();
    }, 15000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------- wiring ---------- */

  document.addEventListener('DOMContentLoaded', () => {
    const origNav = window.navigateToPage;
    window.navigateToPage = function (page) {
      if (typeof origNav === 'function') origNav(page);
      if (page === 'conversations') { loadConversations(); startPolling(); }
      else stopPolling();
    };

    const search = document.getElementById('convoSearch');
    if (search) {
      let t;
      search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderList, 200); });
    }

    document.querySelectorAll('[data-convo-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-convo-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filter = btn.dataset.convoFilter;
        renderList();
      });
    });

    const backBtn = document.getElementById('chatBackBtn');
    if (backBtn) backBtn.addEventListener('click', () => {
      const layout = document.querySelector('.conversations-layout');
      if (layout) layout.classList.remove('thread-open');
      activeContactId = null;
      renderList();
    });

    const sendBtn = document.getElementById('chatSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', sendReply);
    const text = document.getElementById('chatText');
    if (text) text.addEventListener('keydown', e => { if (e.key === 'Enter') sendReply(); });

    document.addEventListener('click', e => {
      const item = e.target.closest && e.target.closest('[data-open-convo]');
      if (item) loadThread(item.dataset.openConvo);
    });
  });
})();
