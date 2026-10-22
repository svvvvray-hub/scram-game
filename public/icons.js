// Clean SVG map / UI icons with one color system: hunters red, hiders cyan, teammates purple, drops gold, boundary yellow.
(function () {
  const COL = { hunter: '#ef4444', hider: '#22d3ee', mate: '#a855f7', drop: '#f59e0b', you: '#22c55e', boundary: '#facc15', decoy: '#94a3b8' };
  const G = { // 24x24 stroke glyphs (white)
    hunter: '<circle cx="12" cy="12" r="6"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
    hider: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><path d="M4 20 20 4"/>',
    mate: '<circle cx="8.5" cy="8" r="3"/><circle cx="16" cy="9" r="2.5"/><path d="M3 19c.5-3.5 2.8-5 5.5-5s5 1.5 5.5 5M14 14.5c2.6 0 4.6 1.4 5 4.5"/>',
    you: '<circle cx="12" cy="12" r="3.5" fill="#fff"/>',
    bounty: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.5-1.2-1.5 0-2.6.8-2.6 2s1.2 1.6 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.1 0-2-.4-2.6-1.2M12 6.5V8M12 16v1.5"/>',
    decoy: '<path d="M6 20V11a6 6 0 0 1 12 0v9l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z"/><circle cx="10" cy="11" r=".8" fill="#fff"/><circle cx="14" cy="11" r=".8" fill="#fff"/>',
    gift: '<rect x="4" y="10" width="16" height="10" rx="1"/><path d="M3 7h18v3H3zM12 7v13M12 7c-1-3-5-4-5-1.5S12 7 12 7s5-1 5-1.5S13 4 12 7"/>',
    bolt: '<path d="M13 2 5 13h6l-1 9 8-12h-6z"/>',
    radar: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
    jammer: '<path d="M2 9a14 14 0 0 1 20 0M5.5 12.5a9 9 0 0 1 13 0M9 16a4 4 0 0 1 6 0"/><path d="M3 3l18 18"/>',
    silent: '<path d="M8 4c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5zM6 17h4v2a2 2 0 0 1-4 0zM16 8c2 0 3 2 3 4.5S18 17 16 17s-3-2-3-4.5S14 8 16 8z"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    extraTime: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
    revive: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M12 10v5M9.5 12.5h5"/>',
    sonar: '<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    truth: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 6 6"/>',
    shrink: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="#fff"/>',
    campeek: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    heat: '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-5 1 1.5 1.5 2 2 2 0-2.5 1-4.5 1-7z"/>',
    hound: '<circle cx="7" cy="9" r="1.8"/><circle cx="11" cy="6" r="1.8"/><circle cx="15" cy="6.5" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M12 11c-3 0-5.5 3.5-5.5 6 0 2 2 2.5 3 2s1.5-.8 2.5-.8 1.5.3 2.5.8 3 0 3-2c0-2.5-2.5-6-5.5-6z"/>',
  };
  const svg = (g, size = 24, sw = 2) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[g] || G.gift}</svg>`;
  // round map badge: colored disc, white ring, glyph; optional pulse halo
  const badge = (g, color, { size = 34, pulse = false, cls = '' } = {}) => `<div class="mk ${cls}${pulse ? ' pulse' : ''}" style="--c:${color};width:${size}px;height:${size}px">${svg(g, Math.round(size * .58), 2.2)}</div>`;
  window.Icons = { COL, svg, badge, has: g => !!G[g] };
})();
