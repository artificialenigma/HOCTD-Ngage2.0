/**
 * DEEPWATER — a clean-room fishing game.
 * Inspired by the gameplay of "Hooked On: Creatures of the Deep" (N-Gage, 2008)
 * as documented in period reviews. No original code, art, audio or data used:
 * every texture is painted on canvas, every sound is synthesized in WebAudio.
 *
 * Slice implemented:
 *   MENU → CAST (hold/power) → FLOAT (bite window) → STRIKE →
 *   FIGHT (reel-vs-strain duel with distance bar) → CATCH CARD (species/weight/XP)
 *   → XP & levels, logbook bestiary, day/sunset/night moods.
 */

import * as THREE from 'three';

/* ============================================================
   TINY helpers
   ============================================================ */
const $ = id => document.getElementById(id);
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry(20261028);
const rr = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function canvasTex(w, h, painter) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  painter(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ============================================================
   SFX — fully synthesized (WebAudio)
   ============================================================ */
const SFX = (() => {
  let ctx = null;
  const ready = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

  function env(g, t0, a, d, peak = 1) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }
  function noise(dur, freq, q, peak) {
    const c = ready(); const t0 = c.currentTime;
    const len = Math.ceil(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = c.createGain(); env(g, t0, 0.005, dur, peak);
    src.connect(bp).connect(g).connect(c.destination);
    src.start();
  }
  function blip(f0, f1, dur, type = 'sine', peak = 0.25) {
    const c = ready(); const t0 = c.currentTime;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = c.createGain(); env(g, t0, 0.008, dur, peak);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(t0 + dur + 0.05);
  }
  function chord(freqs, dur, peak = 0.14) {
    const c = ready(); const t0 = c.currentTime;
    freqs.forEach((f, i) => {
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      g.gain.linearRampToValueAtTime(peak, t0 + i * 0.09 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0 + i * 0.09); o.stop(t0 + dur + 0.1);
    });
  }
  return {
    unlock: () => ready().resume().catch(() => {}),
    cast: () => { noise(0.5, 900, 0.8, 0.30); blip(500, 120, 0.4, 'triangle', 0.12); },
    plop: () => { blip(420, 130, 0.16, 'sine', 0.4); noise(0.12, 1200, 2, 0.22); },
    tick: () => blip(900, 700, 0.05, 'square', 0.06),
    nibble: () => { blip(300, 220, 0.1, 'sine', 0.22); },
    strike: () => { blip(660, 990, 0.18, 'triangle', 0.3); blip(440, 660, 0.24, 'sine', 0.2); },
    snap: () => { noise(0.18, 2400, 3, 0.5); blip(220, 60, 0.35, 'sawtooth', 0.3); },
    catch: () => chord([392, 494, 587, 784], 0.9, 0.16),
    rare: () => chord([523, 659, 784, 1047, 1319], 1.3, 0.13),
    fail: () => chord([330, 262, 196], 0.7, 0.13),
    splashBig: () => { noise(0.7, 700, 0.7, 0.42); noise(0.4, 2000, 1.2, 0.2); },
  };
})();

/* ============================================================
   Species table (original text)
   ============================================================ */
const SPECIES = [
  { n: 'Speckled Coby',     w: [0.2, 0.9],  r: 1,  f: '#5e8fac', q: 'Small, curious, utterly fearless.' },
  { n: 'Silver Darter',     w: [0.5, 2.2],  r: 2,  f: '#9fb9c9', q: 'A flash of chrome in the shallows.' },
  { n: 'Verdant Parrotfin', w: [1.0, 4.5],  r: 2,  f: '#4fae72', q: 'Bites only during bright noon days.' },
  { n: 'Banded Snapper',   w: [2, 7],      r: 3,  f: '#c96a4a', q: 'Reef bruiser with an attitude.' },
  { n: 'Amber Grouper',     w: [4, 18],     r: 3,  f: '#a97b3c', q: 'Hugs the bottom, pulls like a truck.' },
  { n: 'Bluefin Marauder',  w: [12, 60],    r: 4,  f: '#3c6ea8', q: 'Runs long, runs deep, runs angry.' },
  { n: 'Storm Swordfish',   w: [40, 140],   r: 4,  f: '#565f74', q: 'Surface action guaranteed. Hold on.' },
  { n: 'Ghost Sailray',     w: [8, 30],     r: 5,  f: '#7f9fc0', q: 'Sightings cluster near midnight tides.' },
  { n: 'Old Boot',          w: [0.3, 1.1],  r: 0,  f: '#5a4a3a', q: 'One owner. Many seas. “Left foot.”' },
  { n: 'Message in a Bottle', w: [0.4, 0.8], r: 0, f: '#4a7a6a', q: 'Letters from somebody’s other summer.' },
  { n: 'Royal Marbled Leviathan', w: [180, 900], r: 6, f: '#2e4a5e', q: 'The one the old skippers won’t joke about.', legendary: true },
];
const RARITY = { 0: 'junk', 1: 'common', 2: 'common', 3: 'uncommon', 4: 'rare', 5: 'very rare', 6: 'legendary' };
const pick = (lvl) => {
  // deeper level = richer table
  const pool = SPECIES.filter(s => s.r <= 2 + lvl * 0.9);
  const roll = Math.random() * 100;
  let acc = 0, ccum = [34, 20, 18, 12, 7, 2, 0.8];
  let type = 'fish';
  if (roll < 6) type = 'junk';
  const list = type === 'junk' ? SPECIES.filter(s => s.r === 0) : pool;
  // rarity-weighted pick inside list
  const weights = list.map(s => 1 / (1 + s.r * s.r));
  let tw = weights.reduce((a, b) => a + b), x = Math.random() * tw;
  for (let i = 0; i < list.length; i++) { x -= weights[i]; if (x <= 0) return list[i]; }
  return list[list.length - 1];
};
const xpFor = s => Math.round(8 + s.w[1] * (0.8 + 0.5 * s.r) + (s.legendary ? 250 : 0));

/* ============================================================
   WORLD — all-procedural renderer
   ============================================================ */
class World {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 5000);
    this.camera.position.set(0, 2.9, 4.4);
    this.camera.lookAt(0, 0.3, -25);

    this.clock = new THREE.Clock();
    this.moods = this.makeMoods();
    this.setMood('day');

    this.buildSky();
    this.buildWater();
    this.buildCoast();
    this.buildBoat();
    this.buildBobber();
    this.buildSplash();
    this.buildFishLeap();
    this.buildAmbience();

    addEventListener('resize', () => this.onResize());
  }
  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  /* time-of-day moods (all our own palettes) */
  makeMoods() {
    return {
      day:    { top: 0x2a7ac2, mid: 0x9ed2ea, bot: 0xf6e7c6, warm: 0xffc984,
                far: [0.03, 0.23, 0.42], near: [0.16, 0.52, 0.62], skyMix: 0x9ed2ea,
                sun: 0xfff2d8, sunI: 1.35, ambI: 0.75, expo: 1.05, coast: '#5e88a3',
                fog: null, label: 'MORNING · COSTA VERDE BAY' },
      sunset: { top: 0x35436f, mid: 0xfa9a63, bot: 0xffd9a0, warm: 0xff9a4e,
                far: [0.06, 0.18, 0.34], near: [0.32, 0.40, 0.52], skyMix: 0xf9b078,
                sun: 0xffc98a, sunI: 1.1, ambI: 0.5, expo: 1.12, coast: '#4a4f66',
                fog: null, label: 'SUNSET · COSTA VERDE BAY' },
      night:  { top: 0x0a1230, mid: 0x1c2f55, bot: 0x31425e, warm: 0x7a86c2,
                far: [0.02, 0.07, 0.16], near: [0.07, 0.20, 0.30], skyMix: 0x27324e,
                sun: 0xbfd0ff, sunI: 0.45, ambI: 0.35, expo: 1.0, coast: '#232c3e',
                fog: null, label: 'MIDNIGHT · COSTA VERDE BAY' },
      storm:  { top: 0x4a5560, mid: 0x8b9aa4, bot: 0xa8b0b6, warm: 0xb8bcc4,
                far: [0.05, 0.16, 0.24], near: [0.14, 0.34, 0.42], skyMix: 0x94a4b0,
                sun: 0xe8eef2, sunI: 0.5, ambI: 0.6, expo: 0.98, coast: '#57636e',
                fog: new THREE.Fog(0x7d8994, 200, 2400), label: 'THUNDERSTORM · COSTA VERDE BAY' },
    };
  }
  setMood(name) {
    const m = this.moods[name];
    this.mood = m;
    if (this.skyMat) {
      const C = h => new THREE.Color(h);
      this.skyMat.uniforms.top.value = C(m.top);
      this.skyMat.uniforms.mid.value = C(m.mid);
      this.skyMat.uniforms.bot.value = C(m.bot);
      this.skyMat.uniforms.warm.value = C(m.warm);
    }
    if (this.waterMat) {
      this.waterMat.uniforms.farC.value.fromArray(m.far);
      this.waterMat.uniforms.nearC.value.fromArray(m.near);
      this.waterMat.uniforms.skyMix.value = new THREE.Color(m.skyMix);
    }
    if (this.sunLight) { this.sunLight.color = new THREE.Color(m.sun); this.sunLight.intensity = m.sunI; }
    if (this.amb) { this.amb.intensity = m.ambI; }
    this.renderer.toneMappingExposure = m.expo;
    this.scene.fog = m.fog || null;
    if (this.coastMatA) { this.coastMatA.color = new THREE.Color(m.coast); }
    if (this.rainGroup) this.rainGroup.visible = name === 'storm';
    if (this.stars) this.stars.visible = name === 'night';
    $('spotbox').textContent = m.label;
  }

  /* ---------- sky ---------- */
  buildSky() {
    const geo = new THREE.SphereGeometry(2200, 32, 20);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x2a7ac2) }, mid: { value: new THREE.Color(0x9ed2ea) },
        bot: { value: new THREE.Color(0xf6e7c6) }, warm: { value: new THREE.Color(0xffc984) },
        sunDir: { value: this.sunDir },
      },
      vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        uniform vec3 top,mid,bot,warm,sunDir; varying vec3 vP;
        void main(){
          vec3 d=normalize(vP); float t=d.y;
          vec3 c = t>0.0 ? mix(mid,top,smoothstep(0.02,0.75,t)) : mix(bot,mid,smoothstep(-0.08,0.02,t));
          float sun=max(dot(d,sunDir),0.0);
          c+=warm*pow(sun,5.0)*0.4;
          c+=vec3(1.0)*pow(sun,300.0)*0.9;
          gl_FragColor=vec4(c,1.);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, this.skyMat));

    this.sunDir = new THREE.Vector3(-0.35, 0.34, -1).normalize();
    this.skyMat.uniforms.sunDir.value = this.sunDir;

    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTex(256, 256, g => {
        const gr = g.createRadialGradient(128, 128, 10, 128, 128, 128);
        gr.addColorStop(0, 'rgba(255,252,240,1)');
        gr.addColorStop(0.12, 'rgba(255,244,214,.9)');
        gr.addColorStop(0.35, 'rgba(255,214,150,.35)');
        gr.addColorStop(1, 'rgba(255,190,120,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
      }), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.sun.position.copy(this.sunDir).multiplyScalar(1700);
    this.sun.scale.set(500, 500, 1);
    this.scene.add(this.sun);

    this.sunLight = new THREE.DirectionalLight(0xfff0d8, 1.35);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(60);
    this.scene.add(this.sunLight);
    this.amb = new THREE.AmbientLight(0x9cc4dc, 0.75);
    this.scene.add(this.amb);
    this.scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x24506b, 0.5));

    // stars (night)
    const starGeo = new THREE.BufferGeometry();
    const sp = [];
    for (let i = 0; i < 400; i++) {
      const v = new THREE.Vector3().setFromSphericalCoords(1800, Math.acos(rr(0.05, 0.95)), R() * Math.PI * 2);
      sp.push(v.x, v.y, v.z);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 3.2, sizeAttenuation: false, transparent: true, opacity: 0.85 }));
    this.scene.add(this.stars);

    // clouds
    const cloudTex = canvasTex(256, 128, g => {
      const puff = (x, y, r, a) => {
        const gr = g.createRadialGradient(x, y, 2, x, y, r);
        gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      };
      puff(90, 80, 42, .8); puff(128, 70, 50, .9); puff(170, 82, 40, .75); puff(120, 92, 55, .6); puff(60, 88, 30, .5);
    });
    this.clouds = [];
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: rr(.5, .85), depthWrite: false }));
      m.position.set((R() - .5) * 2000, rr(240, 620), -rr(600, 1400));
      const s = rr(280, 620);
      m.scale.set(s, s * 0.45, 1);
      this.clouds.push(m); this.scene.add(m);
    }

    // rain (storm mood)
    const rainGeo = new THREE.BufferGeometry();
    const rp = [];
    for (let i = 0; i < 900; i++) rp.push(rr(-30, 30), rr(0, 26), rr(-4, -30));
    rainGeo.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
    this.rainGroup = new THREE.Points(rainGeo, new THREE.PointsMaterial({ color: 0xcfe0ea, size: 0.07, transparent: true, opacity: 0.6 }));
    this.rainGroup.visible = false;
    this.scene.add(this.rainGroup);
  }

  /* ---------- water ---------- */
  buildWater() {
    const geo = new THREE.PlaneGeometry(3200, 3200, 128, 128);
    geo.rotateX(-Math.PI / 2);
    // our own procedural caustic noise (no game tiles)
    const causticTex = (seed) => canvasTex(256, 256, (g, w, h) => {
      const rng = mulberry(seed), id = g.createImageData(w, h), d = id.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (Math.sin(x * 0.11 + seed) + Math.sin(y * 0.09 + seed * 2) + Math.sin((x + y) * 0.07 + seed * 3)) * 0.5
                + Math.sin(Math.hypot(x - 128, y - 128) * 0.12) * 0.6;
        const b = clamp(92 + v * 40 + (rng() - 0.5) * 24, 0, 255);   // dark-biased: mean ≈ 0.36
        const i = (y * w + x) * 4;
        d[i] = b; d[i + 1] = Math.min(255, b + 26); d[i + 2] = Math.min(255, b + 52); d[i + 3] = 255;
      }
      g.putImageData(id, 0, 0);
    });
    const tA = causticTex(1), tB = causticTex(2), tC = causticTex(4);
    [tA, tB, tC].forEach(t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(60, 60); });

    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        tA: { value: tA }, tB: { value: tB }, tC: { value: tC }, time: { value: 0 },
        sunDir: { value: this.sunDir }, skyMix: { value: new THREE.Color(0x9ed2ea) },
        farC: { value: new THREE.Color().fromArray(this.moods.day.far) },
        nearC: { value: new THREE.Color().fromArray(this.moods.day.near) },
        camPos: { value: this.camera.position },
      },
      vertexShader: `
        uniform float time; varying vec2 vUv; varying vec3 vWp;
        void main(){
          vUv=uv; vec3 p=position;
          p.y += sin(p.x*0.08+time*1.1)*0.35 + sin(p.z*0.11-time*0.8)*0.30 + sin((p.x+p.z)*0.045+time*0.55)*0.45;
          vWp=(modelMatrix*vec4(p,1.)).xyz;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
        }`,
      fragmentShader: `
        uniform sampler2D tA,tB,tC; uniform float time;
        uniform vec3 sunDir,skyMix,farC,nearC,camPos;
        varying vec2 vUv; varying vec3 vWp;
        void main(){
          vec3 a=texture2D(tA,vUv + vec2(time*0.006,time*0.004)).rgb;
          vec3 b=texture2D(tB,vUv*1.7 - vec2(time*0.004,time*0.005)).rgb;
          vec3 c=texture2D(tC,vUv*3.1 + vec2(-time*0.008,0.)).rgb;
          float dist=distance(camPos.xz,vWp.xz);
          vec3 col=mix(nearC, farC, smoothstep(20.0,900.0,dist));
          float lum=dot(a+b*0.8+c*0.6, vec3(0.33));
          col+=vec3(0.45,0.62,0.70)*(lum-0.45)*0.85;
          col+=vec3(1.0,0.93,0.8)*smoothstep(1.35,2.0,lum)*0.3;
          vec3 V=normalize(camPos-vWp);
          // grazing-angle tint of the sky color onto the water (sunset glow etc.)
          float fres=pow(1.0-clamp(V.y,0.0,1.0),3.0);
          col=mix(col, skyMix*0.9, fres*0.62*smoothstep(3.,30.,dist));
          vec3 N=normalize(vec3(0.,1.,0.)+vec3(sin(vUv.x*80.+time*2.),0.,sin(vUv.y*70.-time*1.7))*0.06);
          float spec=pow(max(dot(reflect(-normalize(sunDir),N),V),0.0),700.0);
          col+=skyMix*spec*2.0*smoothstep(60.,300.,dist);
          col=mix(col,skyMix,smoothstep(500.,1500.,dist));
          gl_FragColor=vec4(col,1.);
        }`,
    });
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.set(0, 0, -40);
    this.scene.add(this.water);
  }

  /* ---------- coast ---------- */
  buildCoast() {
    const ridgeTex = (seed) => canvasTex(1024, 256, (g, w, h) => {
      const rng = mulberry(seed);
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) {
        const y = h - h2(x);
        function h2(x) {
          return 210 * (0.55 * Math.sin(x * 0.006 + seed) + 0.22 * Math.sin(x * 0.017 + seed * 2) + 0.12 * Math.sin(x * 0.043 + seed * 5) + 0.45) * (0.6 + rng() * 0.08);
        }
        g.lineTo(x, clamp(y, 0, h));
      }
      g.lineTo(w, h); g.closePath(); g.fill();
    });
    this.coastMatA = new THREE.MeshBasicMaterial({ map: ridgeTex(3), transparent: true, color: 0x5e88a3, fog: false, depthWrite: false });
    this.coastA = new THREE.Mesh(new THREE.PlaneGeometry(2600, 380), this.coastMatA);
    this.coastA.position.set(-120, 130, -1900);
    this.scene.add(this.coastA);
    this.coastB = new THREE.Mesh(
      new THREE.PlaneGeometry(3400, 320),
      new THREE.MeshBasicMaterial({ map: ridgeTex(7), transparent: true, color: 0x83acc6, fog: false, depthWrite: false })
    );
    this.coastB.position.set(240, 96, -2600);
    this.scene.add(this.coastB);
  }

  /* ---------- boat ---------- */
  buildBoat() {
    const g = new THREE.Group();
    const hullMat = new THREE.MeshPhongMaterial({ color: 0xf2ede2, shininess: 55, specular: 0x555566 });
    const deckMat = new THREE.MeshLambertMaterial({ map: canvasTex(256, 128, (g2, w, h) => {
      for (let i = 0; i < 8; i++) {
        g2.fillStyle = ['#b08d5f', '#a5834f', '#bc976a'][i % 3];
        g2.fillRect(0, i * 16, w, 16);
        g2.fillStyle = 'rgba(0,0,0,.18)'; g2.fillRect(0, i * 16, w, 1);
      }
      g2.fillStyle = 'rgba(60,40,20,.25)'; g2.fillRect(0, 0, w, h);
    }) });
    const trimMat = new THREE.MeshPhongMaterial({ color: 0x2f6f7e, shininess: 80, specular: 0x8899aa });

    const prof = [[0, -0.62], [0.38, -0.56], [0.66, -0.38], [0.84, -0.12], [0.92, 0.10], [0.98, 0.30], [1, 0.44]]
      .map(p => new THREE.Vector2(p[0], p[1]));
    const hull = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), hullMat);
    hull.scale.set(1.05, 1, 2.6); hull.position.y = 1.05;
    g.add(hull);
    const deck = new THREE.Mesh(new THREE.CircleGeometry(0.96, 24), deckMat);
    deck.rotation.x = -Math.PI / 2; deck.scale.set(1.02, 2.55, 1); deck.position.y = 1.13;
    g.add(deck);
    const curve = new THREE.EllipseCurve(0, 0, 1.0, 2.56);
    const pts = curve.getPoints(64).map(p => new THREE.Vector3(p.x, 0, p.y));
    const rim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.05, 8, true), trimMat);
    rim.position.y = 1.42;
    g.add(rim);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.34), trimMat);
    bench.position.set(0, 1.34, 0.55); g.add(bench);
    const bench2 = bench.clone(); bench2.position.set(0, 1.30, -0.75); g.add(bench2);

    // rod (right hand)
    const rodMat = new THREE.MeshPhongMaterial({ color: 0x23262b, shininess: 90, specular: 0x888888 });
    const rod = new THREE.Group();
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.024, 2.9, 6), rodMat);
    seg.rotation.z = Math.PI / 2; rod.add(seg);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.55, 8), new THREE.MeshPhongMaterial({ color: 0x1b2b22 }));
    grip.rotation.z = Math.PI / 2; grip.position.x = -0.36; rod.add(grip);
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.045, 16), new THREE.MeshPhongMaterial({ color: 0x35505e, shininess: 120, specular: 0xbbbbbb }));
    reel.rotation.x = Math.PI / 2; reel.position.set(-0.18, -0.075, 0.02); rod.add(reel);
    rod.position.set(0.62, 1.9, 0.2); rod.rotation.z = -0.62; rod.rotation.x = 0.12;
    g.add(rod);
    this.rodPivot = rod;

    g.position.set(0, 0, -0.6);
    this.rodGroup = g;
    this.scene.add(g);

    this.lineMesh = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xe8f2ff, transparent: true, opacity: 0.75 }));
    this.lineMesh.visible = false;
    this.scene.add(this.lineMesh);
  }

  buildBobber() {
    this.bobber = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), new THREE.MeshPhongMaterial({ color: 0xe0452c, shininess: 60 }));
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.075, 6), new THREE.MeshPhongMaterial({ color: 0xffffff }));
    tip.position.y = 0.07;
    this.bobber.add(body, tip);
    this.bobber.visible = false;
    this.scene.add(this.bobber);
  }

  buildSplash() {
    this.splash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTex(128, 128, g => {
        const gr = g.createRadialGradient(64, 80, 4, 64, 80, 60);
        gr.addColorStop(0, 'rgba(235,250,255,.95)'); gr.addColorStop(0.5, 'rgba(190,230,250,.55)'); gr.addColorStop(1, 'rgba(190,230,250,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
        // droplets
        g.fillStyle = 'rgba(235,250,255,.9)';
        for (let i = 0; i < 14; i++) { const a = R() * 7, r = 20 + R() * 40; g.beginPath(); g.arc(64 + Math.cos(a) * r, 78 - Math.abs(Math.sin(a)) * r * 0.8, R() * 2.4 + 1, 0, 7); g.fill(); }
      }), transparent: true, depthWrite: false}));
    this.splash.scale.set(1.4, 1.4, 1);
    this.splash.visible = false;
    this.scene.add(this.splash);
  }

  buildFishLeap() {
    this.leaper = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTex(96, 40, g => {
        g.fillStyle = '#33627e';
        g.beginPath();
        g.moveTo(3, 20); g.quadraticCurveTo(24, 3, 56, 12); g.lineTo(88, 5);
        g.quadraticCurveTo(84, 20, 88, 35); g.lineTo(56, 26); g.quadraticCurveTo(24, 35, 3, 20); g.fill();
      }), transparent: true, depthWrite: false }));
    this.leaper.scale.set(2.4, 1.05, 1);
    this.leaper.visible = false;
    this.scene.add(this.leaper);
    this.leapT = 0;
  }

  buildAmbience() {
    this.shadows = [];
    const shadowTex = canvasTex(64, 32, g => {
      const gr = g.createRadialGradient(32, 16, 4, 32, 16, 30);
      gr.addColorStop(0, 'rgba(4,26,44,.65)'); gr.addColorStop(1, 'rgba(4,26,44,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 32);
      g.fillStyle = 'rgba(2,16,30,.8)'; g.beginPath(); g.ellipse(32, 16, 22, 6, 0, 0, 7); g.fill();
    });
    for (let i = 0; i < 7; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: rr(.25, .5) }));
      const r = rr(12, 60), a = R() * 7;
      s.position.set(Math.cos(a) * r, 0.06, -8 + Math.sin(a) * r);
      const sc = rr(1, 2.4); s.scale.set(sc, sc * 0.5, 1);
      s.userData = { a, r, w: rr(.05, .17), ph: R() * 7 };
      this.shadows.push(s); this.scene.add(s);
    }
    const bt = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8), new THREE.MeshPhongMaterial({ color: 0x35535a, transparent: true, opacity: .85, shininess: 120 }));
    bt.rotation.x = Math.PI / 2;
    this.bottle = new THREE.Group(); this.bottle.add(bt);
    this.bottle.position.set(-5, 0.05, -18);
    this.scene.add(this.bottle);
  }

  leap(pos) { // fish jumps out right at a spot
    this.leapT = 0.0001;
    this.leaper.position.copy(pos);
    this.leaper.visible = true;
  }

  update() {
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    this.waterMat.uniforms.time.value = t;

    for (const c of this.clouds) { c.position.x += dt * 2.2; if (c.position.x > 1000) c.position.x = -1000; }
    for (const s of this.shadows) {
      const u = s.userData; u.a += dt * u.w;
      s.position.x = Math.cos(u.a) * u.r; s.position.z = -8 + Math.sin(u.a) * u.r;
      s.material.opacity = 0.4 + Math.sin(t * 0.8 + u.ph) * 0.2;
    }
    this.bottle.position.y = 0.06 + Math.sin(t * 1.1) * 0.03;
    this.bottle.rotation.z = Math.sin(t * 0.9) * 0.15;

    if (this.rainGroup.visible) {
      const p = this.rainGroup.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) - dt * 22;
        if (y < 0) y = 26;
        p.setY(i, y);
      }
      p.needsUpdate = true;
      if (Math.random() < dt * 0.25) { // lightning flash
        this.amb.intensity = 2.5;
        setTimeout(() => { this.amb.intensity = this.mood.ambI; SFX.snap(); }, 90);
      }
    }

    if (this.leaper.visible) {
      this.leapT += dt * 2.2;
      const p = Math.min(1, this.leapT);
      this.leaper.position.y = Math.sin(p * Math.PI) * 1.6;
      this.leaper.material.rotation = Math.sin(p * Math.PI) * 0.5 - 0.6;
      if (p >= 1) { this.leaper.visible = false; }
    }

    // boat bob (stronger in storm)
    const amp = this.mood === this.moods.storm ? 2.2 : 1;
    this.rodGroup.position.y = Math.sin(t * 0.75) * 0.07 * amp;
    this.rodGroup.rotation.x = Math.sin(t * 0.7) * 0.015 * amp;
    this.rodGroup.rotation.z = Math.sin(t * 0.55 + 1) * 0.02 * amp;

    return { dt, t };
  }
}

/* ============================================================
   GAME — menus, cast, fight, catch, xp
   ============================================================ */
const SAVE_KEY = 'deepwater_save_v1';
function loadSave() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || fresh(); } catch { return fresh(); } }
function fresh() { return { xp: 0, lvl: 1, caught: {}, count: {}, best: {}, casts: 0, days: 1 }; }
function save(st) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(st)); } catch {} }

class Game {
  constructor(world) {
    this.w = world;
    this.save = loadSave();
    this.state = 'MENU';
    this.bindUI();
    this.showMenu();
    requestAnimationFrame(() => {}); // renderer loop started by main()
  }

  /* ---------- menus & panels ---------- */
  showMenu() {
    ['menu'].forEach(id => $(id).classList.remove('hidden'));
    ['how', 'log', 'hud'].forEach(id => $(id).classList.add('hidden'));
    $('hud').classList.add('hidden');
    this.state = 'MENU';
  }
  goto(id) {
    SFX.tick();
    if (id === 'fish') {
      ['menu', 'how', 'log'].forEach(x => $(x).classList.add('hidden'));
      $('hud').classList.remove('hidden');
      this.startDay();
    } else if (id === 'how') {
      $('menu').classList.add('hidden'); $('how').classList.remove('hidden');
    } else if (id === 'log') {
      $('menu').classList.add('hidden'); $('log').classList.remove('hidden');
      this.renderLog();
    } else this.showMenu();
  }
  renderLog() {
    const s = this.save;
    $('logstats').textContent = `level ${s.lvl} · ${s.xp} xp · ${s.casts} casts · ${s.days} session${s.days > 1 ? 's' : ''}`;
    const b = $('bestiary'); b.innerHTML = '';
    SPECIES.forEach(sp => {
      const c = s.caught[sp.n];
      const el = document.createElement('div');
      el.className = 'sp' + (c ? '' : ' uncaught');
      el.innerHTML = `<span class="nm">${sp.n}</span><span class="ct">${c ? `${c} caught · best ${s.best[sp.n].toFixed(2)} kg` : 'not yet'}</span>`;
      b.appendChild(el);
    });
  }

  bindUI() {
    document.querySelectorAll('.mi').forEach(el => el.addEventListener('click', () => this.goto(el.dataset.go)));
    addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (this.state !== 'MENU') this.showMenu(); }
    });
    $('catchcard').addEventListener('click', () => {
      $('catchcard').classList.add('hidden');
      this.reset(false);
    });
  }

  uiState(txt, cls) {
    const el = $('statebox');
    el.textContent = txt;
    el.className = (cls || '') ? cls : '';
  }

  /* ---------- a fresh fishing day ---------- */
  startDay() {
    this.save.days++; save(this.save);
    const moods = ['day', 'sunset', 'night', 'storm'];
    // early levels: friendlier moods
    const pool = this.save.lvl >= 3 ? moods : (this.save.lvl >= 2 ? ['day', 'sunset', 'storm'] : ['day', 'sunset']);
    this.w.setMood(pool[Math.floor(R() * pool.length)]);
    this.reset(true);
  }

  reset(full) {
    this.power = 0; this.distance = 0;
    this.w.bobber.visible = false; this.w.lineMesh.visible = false;
    this.w.splash.visible = false; this.w.leaper.visible = false;
    $('meterwrap').classList.add('hidden');
    $('fightwrap').classList.add('hidden');
    this.setState('IDLE');
    this.updateXPBox();
  }

  setState(s) {
    this.state = s;
    const labels = {
      IDLE: 'HOLD TO CAST', CHARGE: 'RELEASE TO CAST…', CAST: '',
      FLOAT: 'WAITING FOR A BITE…', STRIKE: 'STRIKE! CLICK!', FIGHT: '',
      CATCHLIST: '', LOST: '',
    };
    this.uiState(labels[s] || '');
  }
  updateXPBox() {
    $('xpbox').textContent = `LVL ${this.save.lvl} · ${this.save.xp} XP`;
  }
  toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show'); t.classList.toggle('bad', !!bad);
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ---------- input events (from main loop) ---------- */
  onDown() {
    SFX.unlock();
    switch (this.state) {
      case 'IDLE': this.setState('CHARGE'); SFX.tick(); break;
      case 'STRIKE': this.hooked(); break;
      case 'FIGHT': this.reeling = true; break;
    }
  }
  onUp() {
    if (this.state === 'CHARGE') this.cast();
    if (this.state === 'FIGHT') this.reeling = false;
  }

  /* ---------- cast ---------- */
  cast() {
    const p = this.power;
    this.power = 0;
    $('meterwrap').classList.add('hidden');
    const dir = new THREE.Vector3(0, 0.62, -1).normalize();
    this.bobPos = new THREE.Vector3(0.45, 2.0, -0.5);
    this.bobVel = dir.multiplyScalar(8 + 17 * p);
    this.w.bobber.visible = true;
    this.w.lineMesh.visible = true;
    this.save.casts++; save(this.save);
    SFX.cast();
    this.castLandZ = -6 - p * 34;                 // power decides distance
    this.setState('CAST');
  }

  land() {
    this.bobPos.y = 0;
    this.w.splash.position.copy(this.bobPos);
    this.w.splash.visible = true;
    this.splashT = 0;
    SFX.plop();
    this.fish = pick(this.save.lvl);
    // dunno the real weight until caught; approximate rarity→bite timing
    this.biteAt = rr(1.5, 7) * (1 - Math.min(0.5, this.save.lvl * 0.08));
    this.setState('FLOAT');
  }

  hooked() {
    $('fightwrap').classList.remove('hidden');
    $('statebox').textContent = '';
    $('statebox').className = '';
    this.strain = 0.25;
    this.fishDist = 1.0;                        // relative distance left (1→0)
    this.fishFreak = 0;
    this.reeling = false;
    this.setState('FIGHT');
    $('fighttip').textContent = 'HOLD to reel · RELEASE to rest · don\'t redline the strain!';
    // excitement: leaping fish out at bobber + big splash
    this.w.leap(this.bobPos);
    SFX.splashBig();
  }

  /* ---------- catch resolution ---------- */
  lose(reason) {
    $('fightwrap').classList.add('hidden');
    SFX.snap(); SFX.fail();
    this.uiState(reason === 'snap' ? 'THE LINE SNAPPED!' : 'IT SLIPPED THE HOOK…', 'snap');
    setTimeout(() => this.reset(false), 1500);
  }

  catchIt() {
    $('fightwrap').classList.add('hidden');
    const sp = this.fish;
    const wk = rr(sp.w[0], sp.w[1]);
    const xp = xpFor(sp);
    this.save.xp += xp;
    this.save.caught[sp.n] = (this.save.caught[sp.n] || 0) + 1;
    this.save.best[sp.n] = Math.max(this.save.best[sp.n] || 0, wk);
    while (this.save.xp >= this.save.lvl * 120) { this.save.xp -= this.save.lvl * 120; this.save.lvl++; this.save.pendingLvl = true; }
    save(this.save);
    this.updateXPBox();

    $('ccname').textContent = sp.n + (sp.legendary ? ' ✦' : '');
    $('ccweight').textContent = wk.toFixed(2) + ' kg';
    $('ccrarity').textContent = RARITY[sp.r].toUpperCase();
    $('cchint').textContent = 'click to continue';
    if (sp.legendary) {
      $('ccname').classList.add('legacy');
      $('ccquote').textContent = sp.q;
      $('ccxp').textContent = `+${xp} XP · LEGEND SECURED`;
      SFX.rare();
    } else {
      $('ccname').classList.remove('legacy');
      $('ccquote').textContent = sp.q;
      $('ccxp').textContent = `+${xp} XP`;
      SFX.catch();
    }
    if (this.save.pendingLvl) { this.toast('LEVEL UP! new waters & species unlocked'); this.save.pendingLvl = false; save(this.save); }
    $('catchcard').classList.remove('hidden');
    this.w.leap(this.bobPos);
    this.state = 'CATCHLIST';
  }

  /* ---------- tick ---------- */
  update(dt, t) {
    const w = this.w;
    switch (this.state) {
      case 'CHARGE': {
        this.power = Math.min(1, this.power + dt * 0.9);
        $('meterwrap').classList.remove('hidden');
        $('meterfill').style.width = (this.power * 100) + '%';
        w.rodPivot.rotation.z = -0.62 - 0.35 * this.power;
        break;
      }
      case 'CAST': {
        this.bobVel.y -= 9.8 * dt;
        this.bobPos.addScaledVector(this.bobVel, dt);
        if (this.bobPos.y <= 0 || this.bobPos.z <= this.castLandZ) { this.land(); }
        break;
      }
      case 'FLOAT': {
        this.bobPos.y = Math.sin(t * 2.2) * 0.045;
        if (Math.random() < dt * 0.12) { this.toast('…something circles down there'); }
        this.biteAt -= dt;
        if (this.biteAt <= 0) { this.setState('STRIKE'); this.deadline = 1.2; SFX.strike(); w.leap(this.bobPos); }
        break;
      }
      case 'STRIKE': {
        $('statebox').classList.add('strike');
        this.bobPos.y = -0.12 - Math.sin(t * 24) * 0.05;
        this.deadline -= dt;
        if (this.deadline <= 0) {
          this.uiState('it got away…', '');
          this.toast('too slow — the fish spat the lure', true);
          setTimeout(() => this.reset(false), 900);
          this.state = 'LOST';
        }
        break;
      }
      case 'FIGHT': {
        // fish AI: erratic dashes
        this.fishFreak -= dt;
        if (this.fishFreak <= 0) {
          this.fishFreak = rr(0.6, 2.2);
          this.fishPull = rr(0.35, 1.15) * (1 + this.fish.r * 0.18);
          if (Math.random() < 0.25) this.w.leap(this.bobPos); // leaps during the fight
        }
        if (this.reeling) {
          this.fishDist -= dt * (0.22 / (1 + this.fishPull * 0.8));
          this.strain += dt * (0.14 + this.fishPull * 0.12);
          if (Math.random() < dt * 8) SFX.tick();
        } else {
          this.strain -= dt * 0.24;
          this.fishDist += dt * (0.035 + 0.05 * this.fishPull);
        }
        this.strain = clamp(this.strain, 0, 1);
        this.fishDist = clamp(this.fishDist, 0, 1);
        $('distfill').style.width = (this.fishDist * 100) + '%';
        $('strainfill').style.width = (this.strain * 100) + '%';
        // bobber gets dragged by the battle
        this.bobPos.x += Math.sin(t * 1.4) * dt * this.fishPull * 1.8;
        this.bobPos.z += Math.cos(t * 1.1) * dt * this.fishPull * 1.2;
        if (this.strain >= 1) { this.lose('snap'); this.state = 'LOST'; }
        else if (this.fishDist <= 0) { this.catchIt(); }
        break;
      }
    }

    // bobber & line visuals
    if (w.bobber.visible) {
      w.bobber.position.copy(this.bobPos);
      const tip = new THREE.Vector3(0.85, 3.1, -1.1);
      const attr = w.lineMesh.geometry.getAttribute('position');
      attr.setXYZ(0, tip.x, tip.y, tip.z);
      attr.setXYZ(1, this.bobPos.x, Math.max(this.bobPos.y, 0.02) + 0.05, this.bobPos.z);
      attr.needsUpdate = true;
    }
    if (w.splash.visible) {
      this.splashT += dt;
      const s = 1.2 + this.splashT * 2.4;
      w.splash.scale.set(s, s, 1);
      if (this.splashT > 0.8) w.splash.visible = false;
    }
    w.camera.position.y = 2.9 + Math.sin(t * 0.9) * 0.05;
  }
}

/* ============================================================
   BOOT
   ============================================================ */
const world = new World();
const game = new Game(world);
window.WORLD = world; window.GAME = game;   // debug hooks

addEventListener('mousedown', () => { if (game.state !== 'MENU') game.onDown(); });
addEventListener('mouseup', () => { if (game.state !== 'MENU') game.onUp(); });
addEventListener('touchstart', e => { e.preventDefault(); if (game.state !== 'MENU') game.onDown(); }, { passive: false });
addEventListener('touchend', () => { if (game.state !== 'MENU') game.onUp(); });

(function loop() {
  requestAnimationFrame(loop);
  const { dt, t } = world.update();
  game.update(dt, t);
  world.renderer.render(world.scene, world.camera);
})();
