/* =========================================================
   Shared helpers. Loaded before the page scripts.
   ========================================================= */

/*
 * Escape text for insertion into HTML. Everything user- or customer-supplied
 * goes through this: inbound WhatsApp message bodies in particular are chosen
 * by whoever messaged the number, so they are untrusted input.
 */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Short alias used throughout the page scripts.
const esc = escapeHtml;

/*
 * Format an amount in an ISO 4217 currency code ("INR" -> "₹1,234.50"). The
 * spend figures come from the server with the currency their rates are written
 * in, so the symbol is never assumed. Falls back to "CODE 1.23" if the browser
 * does not know the code.
 */
function formatMoney(amount, code) {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code || 'USD' }).format(n);
  } catch (e) {
    return (code || 'USD') + ' ' + n.toFixed(2);
  }
}
