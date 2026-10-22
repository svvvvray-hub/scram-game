const C=[51.5313,-0.1570];
function hud(){document.body.insertAdjacentHTML('beforeend',`
<div class="hudbar" id="hud"><span id="roleBadge">🫣 HIDER</span><span id="clock">23:41</span><span id="pingClock">📡 Ping in<br><b>0:42</b></span></div>`)}
function rec(style){document.body.insertAdjacentHTML('beforeend',`<div class="recbar" style="${style}"><span class="recDot"></span><b>REC</b><span class="mono" style="color:#fff;font-size:1em">01:23</span><button>🔄 Flip</button><button class="danger">■ Stop</button></div>`)}
function decoy(){document.body.insertAdjacentHTML('beforeend',`<button class="decoy">🎭 Drop Decoy <small>· 2 charges left</small></button>`)}
function label(t){document.body.insertAdjacentHTML('beforeend',`<div class="lbl">${t}</div>`)}
function mkMap(el,{bold=false,zoom=15,interactive=true,controls=false}={}){
 const m=L.map(el,{zoomControl:controls,attributionControl:false,dragging:interactive,scrollWheelZoom:interactive}).setView(C,zoom);
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(m);
 const w=bold?5:3;
 L.circle(C,{radius:650,color:'#facc15',weight:w+1,fill:false,dashArray:bold?null:'8 6'}).addTo(m);
 L.circle(C,{radius:650,color:'#000',weight:1,fillColor:'#facc15',fillOpacity:bold?.08:.05}).addTo(m);
 L.marker([51.5352,-0.1530],{icon:L.divIcon({className:'',html:'<div class="bounty">💰</div>',iconSize:[28,28],iconAnchor:[14,14]})}).addTo(m);
 L.circle([51.5281,-0.1612],{radius:120,color:'#ef4444',weight:bold?4:2,fillOpacity:.15}).addTo(m);
 L.marker([51.5281,-0.1612],{icon:L.divIcon({className:'',html:'<div class="pingIc"></div>',iconSize:[22,22],iconAnchor:[11,11]})}).addTo(m);
 L.marker([51.5300,-0.1555],{icon:L.divIcon({className:'',html:'<div class="meIc"></div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(m);
 return m}
function drag(el,onTap){let sx,sy,ox,oy,moved;el.addEventListener('pointerdown',e=>{sx=e.clientX;sy=e.clientY;ox=el.offsetLeft;oy=el.offsetTop;moved=false;el.setPointerCapture(e.pointerId)});
 el.addEventListener('pointermove',e=>{if(sx==null)return;const dx=e.clientX-sx,dy=e.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>6)moved=true;if(moved){el.style.left=ox+dx+'px';el.style.top=oy+dy+'px';el.style.right='auto'}});
 el.addEventListener('pointerup',()=>{sx=null;if(!moved&&onTap)onTap()})}
