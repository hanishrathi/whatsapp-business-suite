// Generate WhatsApp Suite favicon dynamically
(function() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#25D366"/><path d="M21.6 18.3c-.4-.2-2.2-1.1-2.5-1.2-.4-.1-.6-.2-.8.2-.3.4-1 1.2-1.2 1.5-.2.2-.4.3-.8.1-.4-.2-1.6-.6-3-1.9-1.1-1-1.9-2.2-2.1-2.6-.2-.4 0-.6.2-.8.2-.2.4-.4.5-.7.2-.2.2-.4.4-.6.1-.3.1-.5 0-.7-.1-.2-.8-2-1.2-2.8-.3-.7-.6-.6-.8-.7h-.7c-.3 0-.7.1-1 .5s-1.3 1.3-1.3 3.1c0 1.8 1.3 3.6 1.5 3.9.2.2 2.6 4 6.4 5.6.9.4 1.6.6 2.1.8.9.3 1.7.2 2.4.1.7-.1 2.2-.9 2.5-1.8.3-.9.3-1.6.2-1.8-.1-.2-.3-.2-.7-.4z" fill="#fff"/><path d="M16 3C9.9 3 5 7.9 5 14c0 2.4.7 4.6 1.8 6.5L5 25l4.8-1.8c1.8 1 3.9 1.5 6.2 1.5 6.1 0 11-4.9 11-11S22.1 3 16 3z" fill="none" stroke="#fff" stroke-width="1.2"/></svg>`;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  document.head.appendChild(link);
})();
