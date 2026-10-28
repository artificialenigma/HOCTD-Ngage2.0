/**
 * Hooked On: Creatures of the Deep — three.js port scaffold
 *
 * Vertical slice: the core "cast" loop.
 *   IDLE → hold to CHARGE → release to CAST (projectile arc + line) →
 *   bobber FLOATS → random BITE window ("STRIKE!") → catch = fish leap + score, miss = escape.
 *
 * Visual target (from reviews of the original): fixed 3D view from your boat,
 * bright tropical sea with animated surface, distant coastline, sun & clouds.
 *
 * Assets come straight out of the reverse-engineered data0000.pak (see README.md):
 *   - water caustic JPEG tiles (blobs 04684–04724)
 *   - underwater terrain strips (03677–03683)
 *   - wave splash decal (03543)
 *   - suggested SFX from the /assets/sfx pool (name mapping still partially open)
 */

import * as THREE from 'three';

/* ============================================================
   Asset registry
   real filenames in web/assets are per-blob hashes (k%05d); the
   human-readable name table linkage is documented in
   ../PAK_FORMAT_NOTES.md and wired conservatively in JS below.
   ============================================================ */
const ASSET_INDEX_URL = 'assets/index.json';

const K = {
  causticTiles: ['04684', '04692', '04700', '04708', '04716', '04724'],   // 256×256 caustic / water-light tiles
  terrainStrip: ['03677', '03678', '03679', '03680', '03681', '03682', '03683'], // 512×96 underwater shelf
  splashDecal: '03543',      // waves\splash decal
  checker: '02251',          // decoded NE3DNTEX test texture (bobber)
};

// candidate SFX by heuristic (duration-based; real name mapping is a to-do)
const SFX_KEYS = { cast: null, plop: null, reel: null, tune: null };

class Assets {
  constructor() { this.textures = new Map(); this.sfx = new Map(); this.index = null; }

  async load(onProgress) {
    this.index = await (await fetch(ASSET_INDEX_URL)).json();
    const jobs = [];
    const total = K.causticTiles.length + K.terrainStrip.length + 2;
    let done = 0;

    const loadTex = (key, name = key) => {
      const url = this.index.img[key];
      if (!url) throw new Error('missing asset ' + key);
      const p = new Promise((res, rej) => {
        const t = new THREE.TextureLoader().load(url, tt => {
          tt.colorSpace = THREE.SRGBColorSpace;
          this.textures.set(name, tt); done++; onProgress(done / total * 0.8); res(tt);
        }, undefined, rej);
      });
      jobs.push(p);
    };

    K.causticTiles.forEach((k, i) => loadTex(k, 'caustic' + i));
    K.terrainStrip.forEach((k, i) => loadTex(k, 'strip' + i));
    loadTex(K.splashDecal, 'splash');
    loadTex(K.checker, 'checker');

    await this.loadSfx();
    await Promise.allSettled(jobs);
    onProgress(1);
  }

  async loadSfx() {
    const entries = Object.entries(this.index.sfx);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioCtx = ctx;
    const probed = [];
    await Promise.allSettled(entries.map(async ([k, url]) => {
      const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      probed.push({ k, dur: buf.duration, buf });
    }));
    probed.sort((a, b) => a.dur - b.dur);
    if (probed.length >= 4) {
      SFX_KEYS.plop = probed[0].k;      // shortest: a "pip"
      SFX_KEYS.cast = probed[1].k;
      SFX_KEYS.reel = probed[2].k;
      SFX_KEYS.tune = probed[probed.length - 1]; // longest: ambience/wind
    }
    this.sfxPool = probed;
  }

  play(name, volume = 0.5) {
    const e = this.sfxPool && this.sfxPool.find(s => s.k === name);
    if (!e) return;
    const src = this.audioCtx.createBufferSource();
    src.buffer = e.buf;
    const g = this.audioCtx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.audioCtx.destination);
    src.start();
  }
}

/* ============================================================
   helpers — canvas-painted textures
   ============================================================ */
function canvasTex(w, h, painter) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  painter(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ============================================================
   World
   ============================================================ */
class World {
  constructor(assets) {
    this.assets = assets;
    this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 4000);
    this.camera.position.set(0, 2.9, 4.4);
    this.camera.lookAt(0, 0.3, -25);

    this.clock = new THREE.Clock();

    this.sunDir = new THREE.Vector3(-0.35, 0.42, -1).normalize(); // sun in front of the player

    this.buildSky();
    this.buildWater();
    this.buildTerrain();
    this.buildCoast();
    this.buildBoat();
    this.buildBobber();
    this.buildSplash();
    this.buildFish();
    this.buildAmbience();

    addEventListener('resize', () => this.onResize());
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  /* ---------- sky: gradient dome + sun glow + soft clouds ---------- */
  buildSky() {
    const R = 1500;
    const geo = new THREE.SphereGeometry(R, 32, 20);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        top:    { value: new THREE.Color(0x2a7ac2) },
        mid:    { value: new THREE.Color(0x9ed2ea) },
        bot:    { value: new THREE.Color(0xf6e7c6) },
        warm:   { value: new THREE.Color(0xffc984) },
        sunDir: { value: this.sunDir.clone() },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `
        uniform vec3 top, mid, bot, warm, sunDir; varying vec3 vP;
        void main(){
          vec3 d = normalize(vP);
          float t = d.y;
          vec3 c = t > 0.0 ? mix(mid, top, smoothstep(0.02, 0.75, t))
                           : mix(bot, mid, smoothstep(-0.08, 0.02, t));
          float sun = max(dot(d, sunDir), 0.0);
          c += warm * pow(sun, 6.0) * 0.35;          // warm halo around the sun
          c += vec3(1.0) * pow(sun, 300.0) * 0.9;     // compact sun disc glow
          gl_FragColor = vec4(c, 1.);
        }`,
    });
    this.skyMat = mat;
    this.scene.add(new THREE.Mesh(geo, mat));

    // billboard sun with big soft glow
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTex(256, 256, (g) => {
        const gr = g.createRadialGradient(128, 128, 10, 128, 128, 128);
        gr.addColorStop(0, 'rgba(255,252,240,1)');
        gr.addColorStop(0.12, 'rgba(255,244,214,0.9)');
        gr.addColorStop(0.35, 'rgba(255,214,150,0.35)');
        gr.addColorStop(1, 'rgba(255,190,120,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
      }),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.sun.position.copy(this.sunDir).multiplyScalar(1100);
    this.sun.scale.set(420, 420, 1);
    this.scene.add(this.sun);

    // momentum lights
    this.sunLight = new THREE.DirectionalLight(0xfff0d8, 1.35);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(50);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x9cc4dc, 0.75));
    this.scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x24506b, 0.5));

    // a few soft cumulus billboards mid-sky
    const cloudTex = canvasTex(256, 128, (g) => {
      g.clearRect(0, 0, 256, 128);
      const puff = (x, y, r, a) => {
        const gr = g.createRadialGradient(x, y, 2, x, y, r);
        gr.addColorStop(0, `rgba(255,255,255,${a})`);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      };
      puff(90, 80, 42, .8); puff(128, 70, 50, .9); puff(170, 82, 40, .75);
      puff(120, 92, 55, .6); puff(60, 88, 30, .5);
    });
    this.clouds = [];
    const rng = mulberry(11);
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.55 + rng() * 0.3, depthWrite: false,
      }));
      m.position.set((rng() - 0.5) * 1600, 220 + rng() * 340, -(500 + rng() * 700));
      const s = 260 + rng() * 320;
      m.scale.set(s, s * 0.45, 1);
      this.clouds.push(m);
      this.scene.add(m);
    }
  }

  /* ---------- ocean: animated verts + 3 scrolling caustics + sun glitter ---------- */
  buildWater() {
    const geo = new THREE.PlaneGeometry(3000, 3000, 128, 128);
    geo.rotateX(-Math.PI / 2);
    const texs = ['caustic0', 'caustic1', 'caustic2'].map(n => {
      const t = this.assets.textures.get(n);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(60, 60);
      return t;
    });
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        tA: { value: texs[0] }, tB: { value: texs[1] }, tC: { value: texs[2] },
        time: { value: 0 },
        sunDir: { value: this.sunDir.clone() },
        skyMix: { value: new THREE.Color(0x9ed2ea) },
        camPos: { value: this.camera.position },
      },
      vertexShader: `
        uniform float time;
        varying vec2 vUv; varying vec3 vWp;
        void main(){
          vUv = uv;
          vec3 p = position;
          float w1 = sin(p.x*0.08 + time*1.1) * 0.35 + sin(p.z*0.11 - time*0.8) * 0.30;
          float w2 = sin((p.x+p.z)*0.045 + time*0.55) * 0.45;
          p.y += w1 + w2;
          vWp = (modelMatrix * vec4(p,1.)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
        }`,
      fragmentShader: `
        uniform sampler2D tA, tB, tC; uniform float time;
        uniform vec3 sunDir, skyMix, camPos;
        varying vec2 vUv; varying vec3 vWp;
        void main(){
          vec3 a = texture2D(tA, vUv*1.0 + vec2(time*0.006, time*0.004)).rgb;
          vec3 b = texture2D(tB, vUv*1.7 - vec2(time*0.004, time*0.005)).rgb;
          vec3 c = texture2D(tC, vUv*3.1 + vec2(-time*0.008, 0.)).rgb;
          float dist = distance(camPos.xz, vWp.xz);
          // bright tropical turquoise, fading to deep steel blue offshore
          vec3 farC  = vec3(0.03,0.23,0.42);
          vec3 nearC = vec3(0.16,0.52,0.62);
          vec3 col = mix(nearC, farC, smoothstep(20.0, 900.0, dist));
          float lum = dot(a + b*0.8 + c*0.6, vec3(0.33));
          col += vec3(0.4,0.62,0.72) * lum * 0.75;                 // caustics
          col += vec3(1.0,0.93,0.8) * smoothstep(1.2, 2.0, lum) * 0.4; // sparkle
          // sun glitter path — only offshore, narrow and elongated
          vec3 V = normalize(camPos - vWp);
          vec3 N = normalize(vec3(0.0,1.0,0.0) + vec3(sin(vUv.x*80.0+time*2.0),0.0,sin(vUv.y*70.0-time*1.7))*0.06);
          float spec = pow(max(dot(reflect(-normalize(sunDir), N), V), 0.0), 700.0);
          col += vec3(1.0,0.93,0.82) * spec * 1.6 * smoothstep(60.0, 300.0, dist);
          // horizon fade into sky color
          col = mix(col, skyMix, smoothstep(500.0, 1400.0, dist));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.set(0, 0, -40);
    this.scene.add(this.water);
  }

  /* ---------- underwater shelf (visible when the camera dips or in teal shallows) ---------- */
  buildTerrain() {
    // near-shore turquoise: paint the area around the boat with a brighter shallow plane deep below
    const tex = this.assets.textures.get('strip2');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(14, 6);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(420, 420),
      new THREE.MeshLambertMaterial({ map: tex })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, -3.5, -30);
    this.scene.add(m);
  }

  /* ---------- distant coastline: silhouette ridge textures (two parallax layers) ---------- */
  buildCoast() {
    const ridgeTex = (seed, dark, hScale) => canvasTex(1024, 256, (g, w, h) => {
      const rng = mulberry(seed);
      g.clearRect(0, 0, w, h);
      g.fillStyle = dark;
      g.beginPath();
      g.moveTo(0, h);
      let y = h - hScale * (0.55 + rng() * 0.2);
      g.lineTo(0, y);
      for (let x = 0; x <= w; x += 8) {
        y = h - hScale * (
          0.55 * Math.sin(x * 0.006 + seed) +
          0.22 * Math.sin(x * 0.017 + seed * 2) +
          0.12 * Math.sin(x * 0.043 + seed * 5) + 0.45
        ) * (0.6 + rng() * 0.08);
        y = Math.min(h, Math.max(0, y));
        g.lineTo(x, y);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fill();
      // add gentle haze at the base
      const gr = g.createLinearGradient(0, h - hScale * 0.5, 0, h);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(1, 'rgba(255,255,255,0.14)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    this.coastA = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 380),
      new THREE.MeshBasicMaterial({ map: ridgeTex(3, '#5e88a3', 210), transparent: true, fog: false, depthWrite: false })
    );
    this.coastA.position.set(-120, 130, -1900);
    this.scene.add(this.coastA);
    this.coastB = new THREE.Mesh(
      new THREE.PlaneGeometry(3400, 320),
      new THREE.MeshBasicMaterial({ map: ridgeTex(7, '#83acc6', 150), transparent: true, fog: false, depthWrite: false })
    );
    this.coastB.position.set(240, 96, -2600);
    this.scene.add(this.coastB);
  }

  /* ---------- the player's boat — lathe hull + wooden deck ---------- */
  buildBoat() {
    const g = new THREE.Group();
    const hullMat = new THREE.MeshPhongMaterial({ color: 0xf2ede2, shininess: 55, specular: 0x555566 });
    const deckMat = new THREE.MeshLambertMaterial({ map: canvasTex(256, 128, (g2, w, h) => {
      // painted-wood planks
      for (let i = 0; i < 8; i++) {
        g2.fillStyle = ['#b08d5f', '#a5834f', '#bc976a'][i % 3];
        g2.fillRect(0, i * 16, w, 16);
        g2.fillStyle = 'rgba(0,0,0,0.18)';
        g2.fillRect(0, i * 16, w, 1);
      }
      g2.fillStyle = 'rgba(60,40,20,0.25)'; g2.fillRect(0, 0, w, h);
    }) });
    const trimMat = new THREE.MeshPhongMaterial({ color: 0x2f6f7e, shininess: 80, specular: 0x8899aa });

    // hull: lathe profile rotated → then stretched along z to boat proportions
    const prof = [
      [0.00, -0.62], [0.38, -0.56], [0.66, -0.38], [0.84, -0.12],
      [0.92, 0.10], [0.98, 0.30], [1.00, 0.44],
    ].map(p => new THREE.Vector2(p[0], p[1]));
    const hull = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), hullMat);
    hull.scale.set(1.05, 1.0, 2.6);      // lathe axis stays up = open bowl; z-stretch = boat length
    hull.position.y = 1.05;
    g.add(hull);
    // cream deck slightly under the rim
    const deck = new THREE.Mesh(new THREE.CircleGeometry(0.96, 24), deckMat);
    deck.rotation.x = -Math.PI / 2;
    deck.scale.set(1.02, 2.55, 1);
    deck.position.y = 1.13;
    g.add(deck);
    // gunwale: elliptical tube along the rim
    const curve = new THREE.EllipseCurve(0, 0, 1.0, 2.56);
    const pts = curve.getPoints(64).map(p => new THREE.Vector3(p.x, 0, p.y));
    const rim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.05, 8, true), trimMat);
    rim.position.y = 1.42;
    g.add(rim);
    // bowsprit seat blocks
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.34), trimMat);
    bench.position.set(0, 1.34, 0.55);
    g.add(bench);
    const bench2 = bench.clone(); bench2.position.z = -0.75; bench2.position.y = 1.30;
    g.add(bench2);

    // rod — held in the lower-right, graphite blank with reel + grip
    const rodMat = new THREE.MeshPhongMaterial({ color: 0x23262b, shininess: 90, specular: 0x888888 });
    const rod = new THREE.Group();
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.024, 2.9, 6), rodMat);
    seg.rotation.z = Math.PI / 2;                 // axis along X
    rod.add(seg);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.55, 8),
      new THREE.MeshPhongMaterial({ color: 0x1b2b22, shininess: 20 }));
    grip.rotation.z = Math.PI / 2; grip.position.x = -0.36;
    rod.add(grip);
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.045, 16),
      new THREE.MeshPhongMaterial({ color: 0x35505e, shininess: 120, specular: 0xbbbbbb }));
    reel.rotation.x = Math.PI / 2; reel.position.set(-0.18, -0.075, 0.02);
    rod.add(reel);
    rod.position.set(0.62, 1.9, 0.2);
    rod.rotation.z = -0.62;        // tips up-right
    rod.rotation.x = 0.12;
    g.add(rod);
    this.rodPivot = rod;

    g.position.set(0, 0, -0.6);

    this.rodGroup = g;
    this.scene.add(g);

    this.lineMesh = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xe8f2ff, transparent: true, opacity: 0.75 })
    );
    this.lineMesh.visible = false;
    this.scene.add(this.lineMesh);
  }

  buildBobber() {
    const g = new THREE.SphereGeometry(0.075, 12, 10);
    const mat = new THREE.MeshPhongMaterial({ color: 0xe0452c, shininess: 60 });
    this.bobber = new THREE.Mesh(g, mat);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.075, 6), new THREE.MeshPhongMaterial({ color: 0xffffff }));
    tip.position.y = 0.07;
    this.bobber.add(tip);
    this.bobber.visible = false;
    this.scene.add(this.bobber);
  }

  buildSplash() {
    const tex = this.assets.textures.get('splash');
    this.splash = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.splash.scale.set(1.4, 1.4, 1);
    this.splash.visible = false;
    this.scene.add(this.splash);
  }

  buildFish() {
    // leaping fish silhouette on a canvas — tinted teal like the game's fighters
    const tex = canvasTex(96, 40, (g) => {
      g.fillStyle = '#33627e';
      g.beginPath();
      g.moveTo(3, 20); g.quadraticCurveTo(24, 3, 56, 12);
      g.lineTo(88, 5); g.quadraticCurveTo(84, 20, 88, 35); g.lineTo(56, 26);
      g.quadraticCurveTo(24, 35, 3, 20);
      g.fill();
      g.fillStyle = '#cfe6f2';
      g.beginPath(); g.arc(70, 14, 4, 0, 7); g.fill();       // eye
      g.fillStyle = '#7fa8bd';
      g.fillRect(30, 16, 26, 2);                             // lateral fin hint
    });
    this.fish = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.fish.scale.set(2.4, 1.05, 1);
    this.fish.visible = false;
    this.scene.add(this.fish);
  }

  /* ---------- ambient life: fish shadows near the surface, drifting bottle ---------- */
  buildAmbience() {
    const rng = mulberry(3);
    this.shadows = [];
    const shadowTex = canvasTex(64, 32, (g) => {
      const gr = g.createRadialGradient(32, 16, 4, 32, 16, 30);
      gr.addColorStop(0, 'rgba(4,26,44,0.65)');
      gr.addColorStop(1, 'rgba(4,26,44,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 32);
      g.fillStyle = 'rgba(2,16,30,0.8)';
      g.beginPath(); g.ellipse(32, 16, 22, 6, 0, 0, 7); g.fill();
    });
    for (let i = 0; i < 7; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.35 + rng() * 0.2 }));
      const r = 12 + rng() * 50, a = rng() * Math.PI * 2;
      s.position.set(Math.cos(a) * r, 0.06, -8 + Math.sin(a) * r);
      const sc = 1.0 + rng() * 1.4;
      s.scale.set(sc, sc * 0.5, 1);
      s.userData = { a, r, w: 0.05 + rng() * 0.12, ph: rng() * 7 };
      this.shadows.push(s);
      this.scene.add(s);
    }

    // drifting bottle (glinting pale green cylinder)
    const bt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8),
      new THREE.MeshPhongMaterial({ color: 0x35535a, transparent: true, opacity: 0.85, shininess: 120 })
    );
    bt.rotation.x = Math.PI / 2;
    const bottle = new THREE.Group();
    bottle.add(bt);
    bottle.position.set(-5, 0.05, -18);
    bottle.userData = { ph: rng() * 7 };
    this.bottle = bottle;
    this.scene.add(bottle);

    // a far-off boat silhouette for atmosphere
    const far = new THREE.Group();
    const fh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 12, 6, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
      new THREE.MeshBasicMaterial({ color: 0x2c3f4c }));
    fh.scale.set(0.8, 0.5, 1.6); fh.position.y = 0.5;
    far.add(fh);
    far.position.set(-26, 0.02, -60);
    this.farBoat = far;
    this.scene.add(far);
  }

  update() {
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    this.waterMat.uniforms.time.value = t;

    // clouds drift
    for (const c of this.clouds) {
      c.position.x += dt * 2.2;
      if (c.position.x > 900) c.position.x = -900;
    }
    // ambient fish shadows orbit & bob
    for (const s of this.shadows) {
      const u = s.userData;
      u.a += dt * u.w;
      s.position.x = Math.cos(u.a) * u.r;
      s.position.z = -8 + Math.sin(u.a) * u.r;
      s.material.opacity = 0.55 + Math.sin(t * 0.8 + u.ph) * 0.25;
    }
    // bob bobbing
    this.bottle.position.y = 0.06 + Math.sin(t * 1.1 + this.bottle.userData.ph) * 0.03;
    this.bottle.rotation.z = Math.sin(t * 0.9) * 0.15;
    this.farBoat.position.y = 0.02 + Math.sin(t * 0.8) * 0.04;
    // boat bob
    this.rodGroup.position.y = Math.sin(t * 0.75) * 0.07;
    this.rodGroup.rotation.x = Math.sin(t * 0.7) * 0.015;
    this.rodGroup.rotation.z = Math.sin(t * 0.55 + 1) * 0.02;

    return { dt, t };
  }
}

function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   Game flow (cast slice)
   ============================================================ */
const ST = { IDLE: 'idle', CHARGE: 'charge', CAST: 'cast', FLOAT: 'float', STRIKE: 'strike', CATCH: 'catch' };

class Game {
  constructor(world, assets) {
    this.w = world;
    this.assets = assets;
    this.state = ST.IDLE;
    this.power = 0;
    this.castT = 0;
    this.v0 = null;
    this.biteAt = 0;
    this.score = 0;

    this.ui = {
      state: document.getElementById('statebox'),
      powerWrap: document.getElementById('powerwrap'),
      powerFill: document.getElementById('powerfill'),
      score: document.getElementById('scorebox'),
    };
    this.bindInput();
    this.setState(ST.IDLE);
  }

  bindInput() {
    this.armed = false;
    addEventListener('mousedown', () => { if (this.armed) this.tap(); });
    addEventListener('mouseup', () => { if (this.armed) this.release(); });
    addEventListener('touchstart', e => { e.preventDefault(); if (this.armed) this.tap(); }, { passive: false });
    addEventListener('touchend', () => { if (this.armed) this.release(); });
    addEventListener('keydown', e => { if (e.key === 'Escape') this.reset(); });
  }

  tap() {
    if (this.state === ST.IDLE) { this.setState(ST.CHARGE); this.assets.play(SFX_KEYS.plop, 0.35); }
    else if (this.state === ST.STRIKE) this.doCatch();
  }

  release() {
    if (this.state === ST.CHARGE) { this.doCast(); }
  }

  reset() {
    this.power = 0; this.castT = 0; this.v0 = null;
    this.w.bobber.visible = false; this.w.lineMesh.visible = false;
    this.w.fish.visible = false; this.w.splash.visible = false;
    this.setState(ST.IDLE);
  }

  setState(s) {
    this.state = s;
    this.ui.state.classList.remove('strike');
    const label = {
      [ST.IDLE]: 'HOLD TO CAST', [ST.CHARGE]: 'RELEASE TO CAST…',
      [ST.CAST]: '', [ST.FLOAT]: 'WAITING FOR A BITE…',
      [ST.STRIKE]: 'STRIKE! CLICK!', [ST.CATCH]: 'CATCH!',
    }[s] || '';
    this.ui.state.textContent = label;
    this.ui.powerWrap.classList.toggle('hidden', s !== ST.CHARGE);
  }

  doCast() {
    const p = Math.min(1, this.power);
    this.power = 0;
    const dir = new THREE.Vector3(0, 0.55 + 0.25 * p, -1).normalize();
    const speed = 8 + 16 * p;
    this.bobPos = new THREE.Vector3(0.45, 2.0, -0.5);
    this.bobVel = dir.multiplyScalar(speed);
    this.w.bobber.visible = true;
    this.w.lineMesh.visible = true;
    this.ui.powerWrap.classList.add('hidden');
    this.assets.play(SFX_KEYS.cast, 0.5);
    this.setState(ST.CAST);
  }

  landAt(p) {
    this.bobPos.copy(p); this.bobVel = null;
    this.w.splash.position.copy(p);
    this.w.splash.visible = true;
    this.splashT = 0;
    this.assets.play(SFX_KEYS.reel, 0.5);
    this.biteAt = 1.5 + Math.random() * 3.5;
    this.setState(ST.FLOAT);
  }

  doCatch() {
    this.score += 1;
    this.ui.score.textContent = this.score + ' fish';
    this.fishStart = this.w.clock.elapsedTime;
    this.w.fish.position.copy(this.bobPos).setY(0);
    this.w.fish.visible = true;
    this.assets.play(SFX_KEYS.plop, 0.4);
    this.setState(ST.CATCH);
    setTimeout(() => this.reset(), 1600);
  }

  missBite() {
    this.assets.play(SFX_KEYS.reel, 0.3);
    setTimeout(() => this.reset(), 700);
    this.ui.state.textContent = 'it got away…';
  }

  update(dt, t) {
    if (this.state === ST.CHARGE) {
      this.power = Math.min(1, this.power + dt * 0.9);
      this.ui.powerFill.style.width = (this.power * 100) + '%';
      this.w.rodGroup.rotation.x = -0.22 * this.power;
    } else if (this.state === ST.CAST && this.bobVel) {
      this.bobVel.y -= 9.8 * dt;
      this.bobPos.addScaledVector(this.bobVel, dt);
      if (this.bobPos.y <= 0) this.landAt(this.bobPos.clone().setY(0));
    } else if (this.state === ST.FLOAT) {
      this.bobPos.y = Math.sin(t * 2.2) * 0.045;
      this.biteAt -= dt;
      if (this.biteAt <= 0) {
        this.setState(ST.STRIKE);
        this.biteDeadline = 1.1;
      }
    } else if (this.state === ST.STRIKE) {
      this.ui.state.classList.add('strike');
      this.bobPos.y = -0.12 - Math.sin(t * 24) * 0.05;
      this.biteDeadline -= dt;
      if (this.biteDeadline <= 0) { this.missBite(); }
    } else if (this.state === ST.CATCH) {
      const p = Math.min(1, (t - this.fishStart) / 0.9);
      this.w.fish.position.y = Math.sin(p * Math.PI) * 2.2;
      this.w.fish.scale.set(2.4 * (1 - p) + 0.6, 1.05 * (1 - p) + 0.3, 1);
    }

    if (this.w.bobber.visible) {
      this.w.bobber.position.copy(this.bobPos);
      const tip = new THREE.Vector3(0.85, 3.1, -1.1);
      const attr = this.w.lineMesh.geometry.getAttribute('position');
      attr.setXYZ(0, tip.x, tip.y, tip.z);
      attr.setXYZ(1, this.bobPos.x, Math.max(this.bobPos.y, 0.02) + 0.05, this.bobPos.z);
      attr.needsUpdate = true;
    }
    if (this.w.splash.visible) {
      this.splashT += dt;
      const s = 1.2 + this.splashT * 2.4;
      this.w.splash.scale.set(s, s, 1);
      if (this.splashT > 0.8) this.w.splash.visible = false;
    }
    this.w.camera.position.y = 2.6 + Math.sin(t * 0.9) * 0.05;
  }
}

/* ============================================================
   Boot
   ============================================================ */
(async function main() {
  const loadFill = document.getElementById('loadfill');
  const loadText = document.getElementById('loadtext');
  const onProgress = p => { loadFill.style.width = (p * 90) + '%'; };

  const assets = new Assets();
  try {
    await assets.load(onProgress);
  } catch (e) {
    loadText.textContent = 'asset load failed: ' + e.message;
    console.error(e);
    return;
  }

  const world = new World(assets);
  const game = new Game(world, assets);

  document.getElementById('startbtn').addEventListener('click', async () => {
    await assets.audioCtx.resume().catch(() => {});
    document.getElementById('loadscreen').classList.add('done');
    document.getElementById('hud').classList.remove('hidden');
    game.armed = true;
    try {
      const amb = SFX_KEYS.tune && SFX_KEYS.tune.k ? SFX_KEYS.tune.k : null;
      if (amb) assets.play(amb, 0.12);
    } catch { /* ambience is optional */ }
    (function loop() {
      requestAnimationFrame(loop);
      const { dt, t } = world.update();
      game.update(dt, t);
      world.renderer.render(world.scene, world.camera);
    })();
  }, { once: true });
  document.getElementById('loadtext').textContent = 'assets ready — ' + Object.keys(assets.index.img).length + ' images available';
  loadFill.style.width = '100%';
  document.getElementById('startbtn').classList.remove('hidden');
})();
