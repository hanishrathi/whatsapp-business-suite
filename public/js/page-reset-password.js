/* Password reset. One page, two states: ask for an email, or — when the URL
   carries a token from the reset email — choose a new password. */

const params = new URLSearchParams(window.location.search);
const resetToken = params.get('token');

const alertBox = document.getElementById('authAlert');
const requestForm = document.getElementById('requestForm');
const newPasswordForm = document.getElementById('newPasswordForm');
const title = document.getElementById('resetTitle');
const subtitle = document.getElementById('resetSubtitle');

function showAlert(msg, type) {
  alertBox.textContent = msg;
  alertBox.className = 'auth-alert ' + type;
  alertBox.style.display = 'block';
}

function busy(btn, on) {
  btn.querySelector('.btn-text').style.display = on ? 'none' : 'inline';
  btn.querySelector('.btn-loader').style.display = on ? 'inline-block' : 'none';
  btn.disabled = on;
}

if (resetToken) {
  requestForm.style.display = 'none';
  newPasswordForm.style.display = 'block';
  title.textContent = 'Choose a new password';
  subtitle.textContent = 'Pick something you have not used here before. This link works once.';
}

requestForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('requestBtn');
  busy(btn, true);
  const result = await API.forgotPassword(document.getElementById('resetEmail').value.trim());
  busy(btn, false);
  // The server answers identically whether or not the address is registered.
  showAlert(result.message || 'If that email is registered, a reset link is on its way.',
            result.success ? 'success' : 'error');
  if (result.success) requestForm.reset();
});

newPasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('newPassword').value;
  const confirm = document.getElementById('confirmPassword').value;

  if (password !== confirm) return showAlert('Those two passwords do not match.', 'error');
  if (password.length < 8) return showAlert('Password must be at least 8 characters.', 'error');

  const btn = document.getElementById('resetBtn');
  busy(btn, true);
  const result = await API.resetPassword(resetToken, password);
  busy(btn, false);

  if (result.success) {
    showAlert(result.message || 'Password updated. Taking you to your dashboard…', 'success');
    setTimeout(() => { window.location.href = '/'; }, 1200);
  } else {
    showAlert(result.message || 'Could not reset the password.', 'error');
  }
});

document.querySelectorAll('.toggle-password').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});
