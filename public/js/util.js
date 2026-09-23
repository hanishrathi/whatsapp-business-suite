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
