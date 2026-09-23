/* Extracted from login.html so the Content-Security-Policy can forbid
   inline scripts. Behaviour is unchanged. */
redirectIfLoggedIn();

const form = document.getElementById('loginForm');
const alert = document.getElementById('authAlert');
const btn = document.getElementById('loginBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loader').style.display = 'inline-block';
  btn.disabled = true;

  let result = await API.login(email, password);

  // If 2FA is enabled, ask for the 6-digit authenticator code and retry.
  if (result.mfaRequired) {
    const code = window.prompt('Two-factor authentication is on.\nEnter the 6-digit code from your authenticator app (or a backup code):');
    if (code) {
      result = await API.login(email, password, code.trim());
    }
  }

  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';
  btn.disabled = false;

  if (result.success) {
    if (result.pendingVerification?.email || result.pendingVerification?.phone) {
      window.location.href = '/verify';
    } else {
      window.location.href = '/';
    }
  } else {
    showAlert(result.message || 'Login failed.', 'error');
  }
});

function showAlert(msg, type) {
  alert.textContent = msg;
  alert.className = 'auth-alert ' + type;
  alert.style.display = 'block';
}

// Toggle password visibility
document.querySelectorAll('.toggle-password').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = btn.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});
  
