/* Extracted from register.html so the Content-Security-Policy can forbid
   inline scripts. Behaviour is unchanged. */
redirectIfLoggedIn();

const form = document.getElementById('registerForm');
const alert = document.getElementById('authAlert');
const btn = document.getElementById('registerBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const country = document.getElementById('regCountry').value;
  const phone = country + document.getElementById('regPhone').value.trim().replace(/\s/g, '');
  const password = document.getElementById('regPassword').value;
  const company = document.getElementById('regCompany').value.trim();

  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loader').style.display = 'inline-block';
  btn.disabled = true;

  const result = await API.register({ name, email, phone, password, company });

  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';
  btn.disabled = false;

  if (result.success) {
    window.location.href = '/verify';
  } else {
    showAlert(result.message, 'error');
  }
});

function showAlert(msg, type) {
  alert.textContent = msg;
  alert.className = 'auth-alert ' + type;
  alert.style.display = 'block';
}

// Password strength
document.getElementById('regPassword').addEventListener('input', (e) => {
  const pw = e.target.value;
  const el = document.getElementById('pwStrength');
  if (!pw) { el.innerHTML = ''; return; }
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Excellent'];
  const colors = ['', '#FF6B6B', '#FFC107', '#FF9500', '#25D366', '#128C7E'];
  el.innerHTML = `<div class="pw-bar"><div class="pw-bar-fill" style="width:${score*20}%;background:${colors[score]}"></div></div><span style="color:${colors[score]}">${labels[score]}</span>`;
});

document.querySelectorAll('.toggle-password').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = btn.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});
  
