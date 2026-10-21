/**
 * WhatsApp Suite — sign-up funnel analytics (GA4 + Meta Pixel)
 * ---------------------------------------------------------------
 * Reports the PRE-LOGIN pages (login, register, verify) to the same GA4
 * property and Meta Pixel as acquihiretech.com and its other subdomains, so a
 * visit that starts on the marketing site (or a Meta ad) and ends in a
 * registration is one journey. Both IDs are the ones in the marketing site's
 * js/analytics.js; if either changes there, change it here
 * (`npm run check:subdomains` in the marketing repo fails when they drift).
 *
 * Deliberately NOT loaded on index.html (the dashboard) or profile.html.
 * Once signed in, this app shows people's customer conversations, contacts and
 * broadcast lists. Neither tag reads page content, but we do not put
 * third-party tags in the room where that data is on screen. Do not add this
 * script to those pages. reset-password.html, where a suite has one, is
 * excluded for a different reason: its URL carries the reset token.
 *
 * What is sent is built by hand rather than left to the tags' defaults:
 *   - GA: page_location and page_referrer are origin + path, with no query
 *     string or fragment, so nothing a link happens to carry reaches Google;
 *   - Meta: the pixel always reports the full URL and offers no override, so
 *     it only fires when the query string holds nothing but campaign
 *     parameters (utm_*, fbclid, gclid). Automatic configuration is off, so it
 *     does not scrape buttons or page metadata on pages with sign-up forms.
 *     (Referrer-Policy is no-referrer app-wide, via helmet.)
 *
 * Conversion: register sets a session flag via WAAnalytics.markRegistered()
 * just before it navigates to /verify; this file fires GA sign_up and Meta
 * CompleteRegistration when /verify loads with that flag, then clears it. Firing
 * on the next page instead of before the navigation means the hit is not lost
 * to the page unloading, and a later visit to /verify does not count again.
 *
 * Only runs on wa.acquihiretech.com. A copy of this app's front end is also
 * reachable from the marketing domain, and hits from there would be phantom
 * traffic in the shared property and pixel.
 */
(function (window, document) {
  'use strict';

  var GA_ID = 'G-XGCN7KZKVK';
  var PIXEL_ID = '1659929699486976';
  var FLAG = 'wa_registered';
  var CAMPAIGN_PARAM = /^(utm_[a-z]+|fbclid|gclid)$/;

  if (window.location.hostname !== 'wa.acquihiretech.com') return;

  function bare(url) {
    try {
      var u = new URL(url, window.location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return '';
    }
  }

  function onlyCampaignParams(href) {
    try {
      var keys = Array.from(new URL(href).searchParams.keys());
      return keys.every(function (k) { return CAMPAIGN_PARAM.test(k); });
    } catch (e) {
      return false;
    }
  }

  function load(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  // ── GA4 ────────────────────────────────────────────────────────────
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, {
    anonymize_ip: true,
    page_location: bare(window.location.href),
    page_referrer: document.referrer ? bare(document.referrer) : ''
  });
  load('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID));

  // ── Meta Pixel ─────────────────────────────────────────────────────
  // The standard base-code stub: calls queue until fbevents.js loads.
  var pixel = onlyCampaignParams(window.location.href);
  if (pixel) {
    var fbq = window.fbq = function () {
      fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    load('https://connect.facebook.net/en_US/fbevents.js');
    fbq('set', 'autoConfig', false, PIXEL_ID);
    fbq('init', PIXEL_ID);
    fbq('track', 'PageView');
  }

  // ── Conversion ─────────────────────────────────────────────────────
  var store = null;
  try { store = window.sessionStorage; } catch (e) { /* storage blocked */ }

  if (store && /^\/verify(\.html)?$/.test(window.location.pathname) && store.getItem(FLAG) === '1') {
    store.removeItem(FLAG);
    window.gtag('event', 'sign_up', { method: 'email' });
    if (pixel) window.fbq('track', 'CompleteRegistration');
  }

  window.WAAnalytics = {
    markRegistered: function () {
      try { if (store) store.setItem(FLAG, '1'); } catch (e) { /* storage blocked */ }
    }
  };
})(window, document);
