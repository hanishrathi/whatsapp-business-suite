/* Wire previously-dead buttons (quick actions, top-bar, "New Template")
   to real destinations so nothing is a no-op. */
(function () {
  function go(page, then) {
    if (typeof window.navigateToPage === 'function') window.navigateToPage(page);
    if (then) setTimeout(then, 120);
  }
  function clickById(id) { const el = document.getElementById(id); if (el) el.click(); }

  document.addEventListener('DOMContentLoaded', () => {
    // Dashboard "Quick Actions" — map by their visible label.
    const routes = {
      'New Conversation': () => go('conversations'),
      'Send Broadcast':   () => go('broadcasts', () => clickById('newBroadcastBtn')),
      'Create Template':  () => go('templates', () => clickById('newTemplateBtn')),
      'Import Contacts':  () => go('contacts', () => clickById('importContactsBtn')),
      'API Documentation':() => go('api'),
      'Export Reports':   () => go('reports'),
    };
    document.querySelectorAll('.quick-action').forEach(btn => {
      const label = (btn.querySelector('span')?.textContent || '').trim();
      if (routes[label]) btn.addEventListener('click', routes[label]);
    });

    // Dashboard overview "+ New Template" chip button.
    document.querySelectorAll('.btn.btn-sm').forEach(b => {
      if (b.textContent.trim() === '+ New Template' && !b.id) {
        b.addEventListener('click', () => go('templates', () => clickById('newTemplateBtn')));
      }
    });

    // Top-bar buttons by title.
    document.querySelectorAll('.topbar-btn[title]').forEach(b => {
      const t = b.getAttribute('title');
      if (t === 'Quick compose') b.addEventListener('click', () => go('conversations'));
      if (t === 'Notifications') b.addEventListener('click', () => alert('You have no new notifications.'));
    });

    // Conversation header + input buttons (no backend messaging yet) — give gentle feedback.
    document.querySelectorAll('.chat-input-btn[title], .chat-header .topbar-btn[title]').forEach(b => {
      b.addEventListener('click', () => {
        const t = b.getAttribute('title') || 'This';
        // Only inform for the not-yet-implemented ones; Send has its own handler.
        if (t !== 'Send') console.log(`${t}: live messaging requires connecting a WhatsApp number via Meta.`);
      });
    });
  });
})();
