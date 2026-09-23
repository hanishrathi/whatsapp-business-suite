/* Extracted from verify.html so the Content-Security-Policy can forbid
   inline scripts. Behaviour is unchanged. */
if (!API.isLoggedIn()) window.location.href = '/login';

const user = API.getUser();
if (user) {
  document.getElementById('userEmail').textContent = user.email || '';
  document.getElementById('userPhone').textContent = user.phone || '';

  // Skip already-verified steps
  if (user.isEmailVerified && user.isPhoneVerified) {
    window.location.href = '/';
  } else if (user.isEmailVerified) {
    showPanel('phone');
  }
}

function showPanel(panel) {
  document.querySelectorAll('.verify-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.verify-step').forEach(s => s.classList.remove('active', 'done'));

  if (panel === 'email') {
    document.getElementById('emailPanel').classList.add('active');
    document.querySelector('[data-step="email"]').classList.add('active');
  } else if (panel === 'phone') {
    document.getElementById('phonePanel').classList.add('active');
    document.querySelector('[data-step="email"]').classList.add('done');
    document.querySelector('[data-step="phone"]').classList.add('active');
  } else if (panel === 'success') {
    document.getElementById('successPanel').classList.add('active');
    document.querySelector('[data-step="email"]').classList.add('done');
    document.querySelector('[data-step="phone"]').classList.add('done');
    document.getElementById('skipLink').style.display = 'none';
  }
}

// OTP auto-advance
document.querySelectorAll('.otp-input').forEach((input, i, all) => {
  const group = input.dataset.otp;
  const siblings = [...all].filter(el => el.dataset.otp === group);
  const idx = siblings.indexOf(input);

  input.addEventListener('input', () => {
    if (input.value.length === 1 && idx < siblings.length - 1) siblings[idx + 1].focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && idx > 0) siblings[idx - 1].focus();
  });
  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text').trim();
    if (/^\d{6}$/.test(text)) {
      siblings.forEach((inp, j) => inp.value = text[j]);
      siblings[5].focus();
      e.preventDefault();
    }
  });
});

function getOtp(group) {
  return [...document.querySelectorAll(`.otp-input[data-otp="${group}"]`)].map(i => i.value).join('');
}

// Verify Email
document.getElementById('verifyEmailBtn').addEventListener('click', async () => {
  const otp = getOtp('email');
  if (otp.length !== 6) return showAlert('emailAlert', 'Please enter the full 6-digit code.', 'error');

  const btn = document.getElementById('verifyEmailBtn');
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loader').style.display = 'inline-block';

  const result = await API.verifyEmail(otp);

  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';

  if (result.success) {
    const u = API.getUser(); u.isEmailVerified = true; API.setUser(u);
    showPanel('phone');
  } else {
    showAlert('emailAlert', result.message, 'error');
  }
});

// Verify Phone
document.getElementById('verifyPhoneBtn').addEventListener('click', async () => {
  const otp = getOtp('phone');
  if (otp.length !== 6) return showAlert('phoneAlert', 'Please enter the full 6-digit code.', 'error');

  const btn = document.getElementById('verifyPhoneBtn');
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loader').style.display = 'inline-block';

  const result = await API.verifyPhone(otp);

  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';

  if (result.success) {
    const u = API.getUser(); u.isPhoneVerified = true; API.setUser(u);
    showPanel('success');
  } else {
    showAlert('phoneAlert', result.message, 'error');
  }
});

// Resend
document.getElementById('resendEmailBtn').addEventListener('click', async () => {
  const r = await API.resendOtp('email');
  showAlert('emailAlert', r.message, r.success ? 'success' : 'error');
});
document.getElementById('resendPhoneBtn').addEventListener('click', async () => {
  const r = await API.resendOtp('phone');
  showAlert('phoneAlert', r.message, r.success ? 'success' : 'error');
});

function showAlert(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'auth-alert ' + type;
  el.style.display = 'block';
}
  


/* Inline onclick handlers were removed so the CSP can forbid them. */
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-action="go-dashboard"]');
  if (el) { e.preventDefault(); window.location.href = '/'; }
});
