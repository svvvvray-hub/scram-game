// In-app browser detection (Zalo, Facebook, Instagram, Messenger, Line, TikTok, WeChat, Snapchat, Android WebView).
// These webviews often drop the page (and its WebSocket/localStorage) when the user switches chats, so we nudge
// players to a real browser. UMD: window.InApp in the browser, require('./public/inapp') in node tests.
(function (root, factory) { const m = factory(); if (typeof module === 'object' && module.exports) module.exports = m; else root.InApp = m; })(this, function () {
  const APPS = [
    ['Zalo', /Zalo/i], ['Messenger', /FB_IAB\/MESSENGER|FBAN\/Messenger|MessengerForiOS|\bOrca-Android/i],
    ['Facebook', /FBAN|FBAV|FB_IAB|FBIOS|\[FB/i], ['Instagram', /Instagram/i], ['Line', /\bLine\//i],
    ['TikTok', /TikTok|musical_ly|BytedanceWebview|ByteLocale/i], ['WeChat', /MicroMessenger/i], ['Snapchat', /Snapchat/i],
  ];
  function detect(ua) {
    ua = String(ua || '');
    const ios = /iPhone|iPad|iPod/i.test(ua), android = /Android/i.test(ua);
    const os = ios ? 'ios' : android ? 'android' : 'other';
    for (const [name, re] of APPS) if (re.test(ua)) return { inApp: true, app: name, os };
    if (android && /; wv\)/.test(ua)) return { inApp: true, app: 'WebView', os };
    return { inApp: false, app: null, os };
  }
  // intent://HOST/PATH?QUERY#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=ENCODED;end
  function chromeIntent(href) {
    const u = new URL(href);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(u.href)};end`;
  }
  return { detect, chromeIntent };
});
