'use strict';
const test = require('node:test'), assert = require('node:assert');
const { detect, chromeIntent } = require('../public/inapp');
const UA = {
  zaloAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Zalo android/12100658 ZaloTheme/light ZaloLanguage/vn',
  zaloIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/514 ZaloTheme/light ZaloLanguage/vn',
  fb: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.33.112;FBBV/1]',
  fbAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.31.110;]',
  messenger: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FB_IAB/MESSENGER;FBAV/440.0.0.31.110;]',
  ig: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 312.0.0.32.112 (iPhone14,5; iOS 17_0; en_US)',
  line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari Line/13.20.0',
  tiktok: 'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/119 Mobile Safari/537.36 trill_310503 BytedanceWebview/d8a21c6 musical_ly_2023105030',
  wechat: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.44(0x18002c2f) NetType/WIFI Language/zh_CN',
  snap: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Snapchat/12.60.0.40 (like Safari/8617.1.17.10.10)',
  wv: 'Mozilla/5.0 (Linux; Android 12; SM-G991B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0 Mobile Safari/537.36',
  chrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};
test('detects in-app browsers', () => {
  const exp = { zaloAndroid: ['Zalo', 'android'], zaloIos: ['Zalo', 'ios'], fb: ['Facebook', 'ios'], fbAndroid: ['Facebook', 'android'], messenger: ['Messenger', 'android'],
    ig: ['Instagram', 'ios'], line: ['Line', 'ios'], tiktok: ['TikTok', 'android'], wechat: ['WeChat', 'ios'], snap: ['Snapchat', 'ios'], wv: ['WebView', 'android'] };
  for (const [k, [app, os]] of Object.entries(exp)) assert.deepStrictEqual(detect(UA[k]), { inApp: true, app, os }, k);
});
test('real browsers are not flagged', () => {
  for (const k of ['chrome', 'safari', 'desktop']) assert.strictEqual(detect(UA[k]).inApp, false, k);
  assert.strictEqual(detect('').inApp, false); assert.strictEqual(detect(undefined).os, 'other');
});
test('chrome intent keeps path + query (join code, ref)', () => {
  const href = 'https://scram.example.com/?code=ABCDE&ref=murray';
  assert.strictEqual(chromeIntent(href), 'intent://scram.example.com/?code=ABCDE&ref=murray#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(href) + ';end');
  assert.match(chromeIntent('http://localhost:3000/p/XYZ12'), /^intent:\/\/localhost:3000\/p\/XYZ12#Intent;scheme=https;/);
});
