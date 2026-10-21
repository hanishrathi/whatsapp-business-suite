/**
 * WhatsApp Suite — sign-up funnel analytics
 * ---------------------------------------------------------------
 * Reports page views for the PRE-LOGIN pages (login, register, verify) to the
 * same GA4 property as acquihiretech.com and its other subdomains, so a visit
 * that starts on the marketing site and ends in a registration is one journey.
 * The ID below is the one in the marketing site's js/analytics.js; if that one
 * ever changes, change this one (`npm run check:subdomains` in the marketing
 * repo fails when they drift).
 *
 * Deliberately NOT loaded on index.html (the dashboard) or profile.html.
 * Once signed in, this app shows people's customer conversations, contacts and
 * broadcast lists. GA never reads page content, but we do not put a third-party
 * tag in the room where that data is on screen. Do not add this script to those
 * pages. reset-password.html, where a suite has one, is excluded for a
 * different reason: its URL carries the reset token.
 *
 * What is sent is built by hand rather than left to gtag's defaults:
 *   - page_location is origin + path, with no query string or fragment, so
 *     nothing a link happens to carry can reach Google;
 *   - page_referrer is cut down the same way (a referrer from this same app
 *     is a full URL by default).
 *
 * Only runs on wa.acquihiretech.com. This file is also reachable from the
 * marketing domain (products/ is part of that web root), and a page view
 * reported from there would be a phantom hostname in the shared property.
 */
(function (window, document) {
  'use strict';

  var GA_ID = 'G-XGCN7KZKVK';
  if (window.location.hostname !== 'wa.acquihiretech.com') return;

  function bare(url) {
    try {
      var u = new URL(url, window.location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return '';
    }
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, {
    anonymize_ip: true,
    page_location: bare(window.location.href),
    page_referrer: document.referrer ? bare(document.referrer) : ''
  });

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
  document.head.appendChild(s);
})(window, document);
