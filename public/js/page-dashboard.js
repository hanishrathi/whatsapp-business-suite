/* Extracted from index.html so the Content-Security-Policy can forbid
   inline scripts. Behaviour is unchanged. */
// Auth guard — redirect to login if not authenticated
if (!API.isLoggedIn()) {
  window.location.href = '/login';
} else {
  // Populate user info in sidebar
  const u = API.getUser();
  if (u) {
    const nameEl = document.querySelector('.user-name');
    const roleEl = document.querySelector('.user-role');
    const avatarEl = document.querySelector('.user-avatar');
    if (nameEl) nameEl.textContent = u.name;
    if (roleEl) roleEl.textContent = u.role === 'admin' ? 'Admin' : 'Member';
    if (avatarEl) avatarEl.textContent = u.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }
}
  


/* Inline onclick handlers were removed so the CSP can forbid them. */
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-action]');
  if (el && el.dataset.action === 'logout') { e.preventDefault(); API.logout(); }
});
