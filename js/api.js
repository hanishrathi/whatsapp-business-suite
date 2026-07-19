/* =========================================================
   API Client — WhatsApp Business Suite
   ========================================================= */

const API = {
  baseUrl: window.location.origin + '/api',

  // Token management
  getToken() { return localStorage.getItem('wa_token'); },
  setToken(token) { localStorage.setItem('wa_token', token); },
  clearToken() { localStorage.removeItem('wa_token'); },

  getUser() {
    const u = localStorage.getItem('wa_user');
    return u ? JSON.parse(u) : null;
  },
  setUser(user) { localStorage.setItem('wa_user', JSON.stringify(user)); },
  clearUser() { localStorage.removeItem('wa_user'); },

  isLoggedIn() { return !!this.getToken(); },

  logout() {
    this.clearToken();
    this.clearUser();
    window.location.href = '/login';
  },

  // Fetch wrapper
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };

    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch(url, { ...options, headers });
      const data = await res.json();

      // Only force-logout if we actually sent a token (i.e. a real session
      // expired). A 401 during login/2FA just means bad credentials.
      if (res.status === 401 && token) {
        this.logout();
        return data;
      }

      return data;
    } catch (err) {
      console.error('API error:', err);
      return { success: false, message: 'Network error. Please check your connection.' };
    }
  },

  // Multipart upload (for avatars)
  async upload(endpoint, formData) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {};
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch(url, { method: 'POST', headers, body: formData });
      return await res.json();
    } catch (err) {
      console.error('Upload error:', err);
      return { success: false, message: 'Upload failed.' };
    }
  },

  // ========== AUTH ==========
  async register(data) {
    const result = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (result.success) {
      this.setToken(result.token);
      this.setUser(result.user);
    }
    return result;
  },

  async login(email, password, mfaCode) {
    const result = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, mfaCode }),
    });
    if (result.success) {
      this.setToken(result.token);
      this.setUser(result.user);
    }
    // result.mfaRequired === true means caller must collect a 6-digit code
    // and call login(email, password, code) again.
    return result;
  },

  async verifyEmail(otp) {
    return this.request('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ otp }),
    });
  },

  async verifyPhone(otp) {
    return this.request('/auth/verify-phone', {
      method: 'POST',
      body: JSON.stringify({ otp }),
    });
  },

  async resendOtp(type) {
    return this.request('/auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify({ type }),
    });
  },

  async getMe() {
    const result = await this.request('/auth/me');
    if (result.success) this.setUser(result.user);
    return result;
  },

  // ========== USER PROFILE ==========
  async getProfile() {
    return this.request('/users/profile');
  },

  async updateProfile(data) {
    const result = await this.request('/users/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    if (result.success) this.setUser(result.user);
    return result;
  },

  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('avatar', file);
    const result = await this.upload('/users/avatar', formData);
    if (result.success) {
      const user = this.getUser();
      if (user) { user.avatar = result.avatar; this.setUser(user); }
    }
    return result;
  },

  async removeAvatar() {
    return this.request('/users/avatar', { method: 'DELETE' });
  },

  async changePassword(currentPassword, newPassword) {
    const result = await this.request('/users/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    // Server rotates the session on password change — store the fresh token
    // so the current tab stays logged in.
    if (result.success && result.token) this.setToken(result.token);
    return result;
  },

  // ----- Two-factor authentication (2FA) -----
  async setupMfa() {
    return this.request('/users/mfa/setup', { method: 'POST', body: '{}' });
  },
  async enableMfa(code) {
    const result = await this.request('/users/mfa/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    if (result.success && result.token) this.setToken(result.token);
    return result;
  },
  async disableMfa(password) {
    return this.request('/users/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  async logoutAll() {
    return this.request('/users/logout-all', { method: 'POST', body: '{}' });
  },

  async deleteUserAccount(password) {
    const result = await this.request('/users/account', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    });
    if (result.success) {
      this.clearToken();
      this.clearUser();
    }
    return result;
  },

  // ========== WHATSAPP ACCOUNTS ==========
  async getAccounts() {
    return this.request('/accounts');
  },

  async getAccount(id) {
    return this.request(`/accounts/${id}`);
  },

  async createWAAccount(data) {
    return this.request('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateWAAccount(id, data) {
    return this.request(`/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async updateAccountColor(id, color, colorClass) {
    return this.request(`/accounts/${id}/color`, {
      method: 'PUT',
      body: JSON.stringify({ color, colorClass }),
    });
  },

  async deleteWAAccount(id) {
    return this.request(`/accounts/${id}`, { method: 'DELETE' });
  },

  async testWAAccount(id) {
    return this.request(`/accounts/${id}/test`, { method: 'POST', body: '{}' });
  },

  // ========== CONTACTS ==========
  async getContacts(q) {
    return this.request('/contacts' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  },
  async createContact(data) {
    return this.request('/contacts', { method: 'POST', body: JSON.stringify(data) });
  },
  async updateContact(id, data) {
    return this.request(`/contacts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async deleteContact(id) {
    return this.request(`/contacts/${id}`, { method: 'DELETE' });
  },
  async importContacts(rows) {
    return this.request('/contacts/import', { method: 'POST', body: JSON.stringify({ contacts: rows }) });
  },
  async exportContactsCsv() {
    // Download with the auth header, then trigger a save dialog.
    const res = await fetch(`${this.baseUrl}/contacts/export`, {
      headers: { 'Authorization': `Bearer ${this.getToken()}` },
    });
    if (!res.ok) return { success: false, message: 'Export failed.' };
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'contacts.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    return { success: true };
  },

  // ========== TEMPLATES ==========
  async getTemplates() {
    return this.request('/templates');
  },
  async createTemplate(data) {
    return this.request('/templates', { method: 'POST', body: JSON.stringify(data) });
  },
  async updateTemplate(id, data) {
    return this.request(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async deleteTemplate(id) {
    return this.request(`/templates/${id}`, { method: 'DELETE' });
  },

  // ========== BROADCASTS ==========
  async getBroadcasts() {
    return this.request('/broadcasts');
  },
  async createBroadcast(data) {
    return this.request('/broadcasts', { method: 'POST', body: JSON.stringify(data) });
  },
  async updateBroadcast(id, data) {
    return this.request(`/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async deleteBroadcast(id) {
    return this.request(`/broadcasts/${id}`, { method: 'DELETE' });
  },
  async getBroadcast(id) {
    return this.request(`/broadcasts/${id}`);
  },
  async sendBroadcast(id) {
    return this.request(`/broadcasts/${id}/send`, { method: 'POST', body: '{}' });
  },

  // ========== DASHBOARD ==========
  async getDashboardStats() {
    return this.request('/dashboard/stats');
  },
};

// Auth guard — redirect to login if not authenticated
function requireAuth() {
  if (!API.isLoggedIn()) {
    window.location.href = '/login';
    return false;
  }
  return true;
}

// Redirect if already logged in
function redirectIfLoggedIn() {
  if (API.isLoggedIn()) {
    window.location.href = '/';
  }
}
