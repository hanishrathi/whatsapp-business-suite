/* Extracted from profile.html so the Content-Security-Policy can forbid
   inline scripts. Behaviour is unchanged. */
if (!requireAuth()) throw '';

// Load profile data
async function loadProfile() {
  const result = await API.getProfile();
  if (!result.success) return;

  const u = result.user;
  document.getElementById('profileName').textContent = u.name;
  document.getElementById('profileEmail').textContent = u.email;
  document.getElementById('avatarInitials').textContent = u.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  document.getElementById('badgePlan').textContent = (u.plan || 'free').charAt(0).toUpperCase() + (u.plan || 'free').slice(1);
  document.getElementById('badgeAccounts').textContent = `${result.accountCount} / ${result.maxAccounts} accounts`;

  // Form fields
  document.getElementById('profName').value = u.name;
  document.getElementById('profCompany').value = u.company || '';
  document.getElementById('profEmail').value = u.email;
  document.getElementById('profPhone').value = u.phone;
  document.getElementById('profTimezone').value = u.timezone || 'Asia/Kolkata';

  if (u.isEmailVerified) document.getElementById('emailBadge').style.display = 'inline';
  if (u.isPhoneVerified) document.getElementById('phoneBadge').style.display = 'inline';

  // Avatar
  if (u.avatar) {
    document.getElementById('avatarImg').src = u.avatar;
    document.getElementById('avatarImg').style.display = 'block';
    document.getElementById('avatarInitials').style.display = 'none';
    document.getElementById('removeAvatarBtn').style.display = 'inline-flex';
  }
}

loadProfile();

/* ---------------- Two-Factor Authentication (2FA) ---------------- */
const mfaStatus = document.getElementById('mfaStatus');
const mfaSetup = document.getElementById('mfaSetup');
const mfaBackup = document.getElementById('mfaBackup');
const mfaEnableBtn = document.getElementById('mfaEnableBtn');
const mfaDisableBtn = document.getElementById('mfaDisableBtn');
const mfaConfirmBtn = document.getElementById('mfaConfirmBtn');
const mfaAlert = document.getElementById('mfaAlert');

function showMfaAlert(msg, type) {
  mfaAlert.textContent = msg;
  mfaAlert.className = 'profile-alert ' + type;
  mfaAlert.style.display = 'block';
  setTimeout(() => { mfaAlert.style.display = 'none'; }, 6000);
}

function renderMfaState(enabled) {
  if (enabled) {
    mfaStatus.innerHTML = '<span style="color:#25803b;font-weight:600;">● 2FA is ON</span> — your account is protected with an authenticator app.';
    mfaEnableBtn.style.display = 'none';
    mfaDisableBtn.style.display = 'inline-flex';
    mfaSetup.style.display = 'none';
  } else {
    mfaStatus.innerHTML = '<span style="color:#86868b;font-weight:600;">○ 2FA is OFF</span> — turn it on for stronger account security.';
    mfaEnableBtn.style.display = 'inline-flex';
    mfaDisableBtn.style.display = 'none';
  }
}

async function refreshMfa() {
  const me = await API.getMe();
  if (me.success) renderMfaState(me.user.mfaEnabled);
}
refreshMfa();

mfaEnableBtn.addEventListener('click', async () => {
  const result = await API.setupMfa();
  if (!result.success) return showMfaAlert(result.message || 'Could not start 2FA setup.', 'error');
  document.getElementById('mfaQr').src = result.qr;
  document.getElementById('mfaSecret').textContent = result.secret;
  mfaSetup.style.display = 'block';
  mfaEnableBtn.style.display = 'none';
});

mfaConfirmBtn.addEventListener('click', async () => {
  const code = document.getElementById('mfaCode').value.trim();
  if (!code) return showMfaAlert('Enter the 6-digit code from your app.', 'error');
  const result = await API.enableMfa(code);
  if (!result.success) return showMfaAlert(result.message || 'Incorrect code.', 'error');
  mfaBackup.style.display = 'block';
  document.getElementById('mfaBackupCodes').textContent = result.backupCodes.join('\n');
  showMfaAlert('Two-factor authentication is now ON. Save your backup codes!', 'success');
  renderMfaState(true);
});

mfaDisableBtn.addEventListener('click', async () => {
  const pw = window.prompt('Enter your password to turn OFF two-factor authentication:');
  if (!pw) return;
  const result = await API.disableMfa(pw);
  if (!result.success) return showMfaAlert(result.message || 'Could not disable 2FA.', 'error');
  mfaBackup.style.display = 'none';
  showMfaAlert('Two-factor authentication disabled.', 'success');
  renderMfaState(false);
});

// Upload avatar
document.getElementById('avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return alert('File too large. Maximum 5MB.');

  const result = await API.uploadAvatar(file);
  if (result.success) {
    document.getElementById('avatarImg').src = result.avatar + '?t=' + Date.now();
    document.getElementById('avatarImg').style.display = 'block';
    document.getElementById('avatarInitials').style.display = 'none';
    document.getElementById('removeAvatarBtn').style.display = 'inline-flex';
  }
});

// Remove avatar
document.getElementById('removeAvatarBtn').addEventListener('click', async () => {
  const result = await API.removeAvatar();
  if (result.success) {
    document.getElementById('avatarImg').style.display = 'none';
    document.getElementById('avatarInitials').style.display = 'flex';
    document.getElementById('removeAvatarBtn').style.display = 'none';
  }
});

// Save profile
document.getElementById('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = await API.updateProfile({
    name: document.getElementById('profName').value.trim(),
    company: document.getElementById('profCompany').value.trim(),
    timezone: document.getElementById('profTimezone').value,
  });
  showAlert('profileAlert', result.message, result.success ? 'success' : 'error');
  if (result.success) {
    document.getElementById('profileName').textContent = result.user.name;
    document.getElementById('avatarInitials').textContent = result.user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }
});

// Change password
document.getElementById('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPw = document.getElementById('newPw').value;
  const confirmPw = document.getElementById('confirmPw').value;
  if (newPw !== confirmPw) return showAlert('pwAlert', 'Passwords do not match.', 'error');

  const result = await API.changePassword(
    document.getElementById('currentPw').value,
    newPw
  );
  showAlert('pwAlert', result.message, result.success ? 'success' : 'error');
  if (result.success) {
    document.getElementById('currentPw').value = '';
    document.getElementById('newPw').value = '';
    document.getElementById('confirmPw').value = '';
  }
});

// Delete account
document.getElementById('deleteAccountBtn').addEventListener('click', () => {
  document.getElementById('deleteModal').classList.add('open');
});

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  const pw = document.getElementById('deletePassword').value;
  if (!pw) return showAlert('deleteAlert', 'Password required.', 'error');

  const result = await API.deleteUserAccount(pw);
  if (result.success) {
    window.location.href = '/login';
  } else {
    showAlert('deleteAlert', result.message, 'error');
  }
});

function showAlert(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'profile-alert ' + type;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}
  


/* Inline onclick handlers were removed so the CSP can forbid them. */
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-action="close-delete-modal"]');
  if (el) {
    e.preventDefault();
    const m = document.getElementById('deleteModal');
    if (m) m.classList.remove('open');
  }
});
