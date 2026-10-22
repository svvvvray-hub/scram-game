// Platform-neutral social handles: parse/validate per platform, profile URLs, tiny inline icons (no CDN).
// Works in the browser (window.Socials) and in Node (require('./public/socials')).
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Socials = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // re: allowed (lowercased) handle; min/max length; keepCase: platform shows handles with their case (X, YouTube); matching is always case-insensitive
  const P = {
    instagram: { chars: 'letters, numbers, . and _', label: 'Instagram', short: 'IG', color: '#e1306c', re: /^[a-z0-9._]+$/, min: 1, max: 30, dots: true, url: h => 'https://www.instagram.com/' + h + '/',
      hosts: /^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)$/, reserved: /^(p|reel|reels|stories|explore|accounts|tv|direct)$/ },
    tiktok: { chars: 'letters, numbers, . and _', label: 'TikTok', short: 'TT', color: '#25f4ee', re: /^[a-z0-9._]+$/, min: 2, max: 24, dots: true, url: h => 'https://www.tiktok.com/@' + h,
      hosts: /^(?:www\.|m\.|vm\.)?tiktok\.com$/, at: true, reserved: /^(discover|explore|tag|music|video|foryou|following|live)$/ },
    x: { chars: 'letters, numbers and _', label: 'X', short: 'X', color: '#e5e7eb', re: /^[a-z0-9_]+$/, min: 1, max: 15, keepCase: true, url: h => 'https://x.com/' + h,
      hosts: /^(?:www\.|m\.|mobile\.)?(?:x\.com|twitter\.com)$/, reserved: /^(home|explore|search|i|intent|share|hashtag|settings|messages|notifications)$/ },
    snapchat: { chars: 'letters, numbers, . _ and -, starting with a letter', label: 'Snapchat', short: 'SC', color: '#fffc00', re: /^[a-z][a-z0-9._-]*[a-z0-9]$/, min: 3, max: 15, url: h => 'https://www.snapchat.com/add/' + h,
      hosts: /^(?:www\.)?snapchat\.com$/, path: /^\/(?:add|@)\/?([^/?#\s]+)|^\/@([^/?#\s]+)/, reserved: /^(add|discover|spotlight)$/ },
    youtube: { chars: 'letters, numbers, . _ and -', label: 'YouTube', short: 'YT', color: '#ff0033', re: /^[a-z0-9._-]+$/, min: 3, max: 30, keepCase: true, url: h => 'https://www.youtube.com/@' + h,
      hosts: /^(?:www\.|m\.)?youtube\.com$/, at: true, reserved: /^(watch|channel|c|user|shorts|results|feed)$/ },
    threads: { chars: 'letters, numbers, . and _', label: 'Threads', short: '@', color: '#a3a3a3', re: /^[a-z0-9._]+$/, min: 1, max: 30, dots: true, url: h => 'https://www.threads.net/@' + h,
      hosts: /^(?:www\.)?threads\.(?:net|com)$/, at: true, reserved: /^(search|activity)$/ },
    facebook: { chars: 'letters, numbers and .', label: 'Facebook', short: 'f', color: '#1877f2', re: /^[a-z0-9.]+$/, min: 5, max: 30, dots: true, url: h => 'https://www.facebook.com/' + h,
      hosts: /^(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com)$/, reserved: /^(profile\.php|people|groups|pages|watch|events|share|login|marketplace|reel|photo|story\.php)$/ },
  };
  const LIST = Object.keys(P), DEFAULT = 'instagram';
  const isPlatform = p => typeof p === 'string' && Object.prototype.hasOwnProperty.call(P, p);
  const plat = p => (isPlatform(p) ? p : DEFAULT);
  const GENERAL = /^[A-Za-z0-9._-]{1,30}$/;
  // pasted profile URL -> { platform, handle } (handle still raw), or null
  function fromUrl(s) {
    const m = s.match(/^(?:https?:\/\/)?([^/?#\s]+)(\/[^?#\s]*)?/i); if (!m || !/\./.test(m[1])) return null;
    const host = m[1].toLowerCase(), path = m[2] || '/';
    for (const k of LIST) { const d = P[k]; if (!d.hosts.test(host)) continue;
      let h;
      if (d.path) { const x = path.match(d.path); h = x && (x[1] || x[2]); }
      else { const seg = path.split('/').filter(Boolean)[0] || ''; h = d.at ? (seg.startsWith('@') ? seg.slice(1) : '') : seg; }
      return { platform: k, handle: h ? decodeURIComponent(h) : '' };
    }
    return null;
  }
  function valid(h, k) { const d = P[k]; return h.length >= d.min && h.length <= d.max && d.re.test(h) && !d.reserved.test(h) && !(d.dots && /^\.|\.$|\.\./.test(h)); }
  // parse(raw, platform) -> { handle, platform } or null. A pasted URL overrides the chosen platform.
  function parse(raw, platform) {
    let s = String(raw == null ? '' : raw).trim(), k = plat(platform);
    if (!s) return null;
    const u = fromUrl(s); if (u) { k = u.platform; s = u.handle; } else if (/[/:]/.test(s)) return null;
    s = s.replace(/^@/, '');
    if (!GENERAL.test(s)) return null;
    const h = P[k].keepCase ? s : s.toLowerCase();
    return valid(h.toLowerCase(), k) ? { handle: h, platform: k } : null;
  }
  // accept { handle, platform } (missing platform = Instagram, unknown = rejected) | legacy string (Instagram) | null
  function norm(v, platform) { if (v && typeof v === 'object') return typeof v.handle === 'string' && (v.platform == null || v.platform === '' || isPlatform(v.platform)) ? parse(v.handle, v.platform) : null; return typeof v === 'string' ? parse(v, platform) : null; }
  const key = s => s.platform + ':' + s.handle.toLowerCase();
  const url = s => (s && isPlatform(s.platform) ? P[s.platform].url(encodeURIComponent(s.handle)) : '');
  const label = p => P[plat(p)].label;
  const hint = p => { const d = P[plat(p)]; return `${d.label} handle: ${d.chars} (${d.min > 1 ? d.min + '-' + d.max : 'max ' + d.max})`; };
  // tiny badge: rounded square in the platform color with a short glyph (text, so no external assets)
  function icon(p, size = 16) { const d = P[plat(p)], dark = /fffc00|25f4ee|e5e7eb|a3a3a3/.test(d.color);
    return `<svg class="sicon" viewBox="0 0 20 20" width="${size}" height="${size}" role="img" aria-label="${d.label}"><rect width="20" height="20" rx="5" fill="${d.color}"/><text x="10" y="14.2" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" style="font-size:${d.short.length > 1 ? 9 : 12}px;fill:${dark ? '#111' : '#fff'}">${d.short}</text></svg>`; }
  return { PLATFORMS: P, LIST, DEFAULT, isPlatform, parse, norm, key, url, label, hint, icon, fromUrl };
});
