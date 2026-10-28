/**
 * Hooked On: Creatures of the Deep — three.js port scaffold
 *
 * Vertical slice: the core "cast" loop.
 *   IDLE → hold to CHARGE → release to CAST (projectile arc + line) →
 *   bobber FLOATS → random BITE window ("STRIKE!") → catch = fish leap + score, miss = escape.
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
          this.textures.set(name, tt); done++; onProgress(done / total); res(tt);
        }, undefined, rej);
      });
      jobs.push(p);
    };

    K.causticTiles.forEach((k, i) => loadTex(k, 'caustic' + i));
    K.terrainStrip.forEach((k, i) => loadTex(k, 'strip' + i));
    loadTex(K.splashDecal, 'splash');
    loadTex(K.checker, 'checker');

    // classify SFX: probe durations
    await this.loadSfx();
    await Promise.allSettled(jobs);
    onProgress(1);
  }

  async loadSfx() {
    const entries = Object.entries(this.index.sfx);
    // decode durations via AudioContext to label sounds: shortest few = UI pips, longest = ambience
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
   World
   ============================================================ */
class World {
  constructor(assets) {
    this.assets = assets;
    this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x9fc8dd, 0.0035);

    this.camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.1, 2000);
    this.camera.position.set(0, 2.4, 7.5);
    this.camera.lookAt(0, 0.6, -10);

    this.clock = new THREE.Clock();

    this.buildSky();
    this.buildWater();
    this.buildTerrain();
    this.buildBoatAndRod();
    this.buildBobber();
    this.buildSplash();
    this.buildFish();

    addEventListener('resize', () => this.onResize());
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  buildSky() {
    // gradient dome
    const geo = new THREE.SphereGeometry(900, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x2e6fb2) },
        mid: { value: new THREE.Color(0x9fc8dd) },
        bot: { value: new THREE.Color(0xe8d8b8) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `
        uniform vec3 top, mid, bot; varying vec3 vP;
        void main(){
          float t = clamp(vP.y / 900.0, -1.0, 1.0);
          vec3 c = t > 0.12 ? mix(mid, top, smoothstep(.12, .8, t))
                 : mix(bot, mid, smoothstep(-.25, .12, t));
          gl_FragColor = vec4(c, 1.);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));

    const sun = new THREE.DirectionalLight(0xfff2d8, 1.4);
    sun.position.set(30, 60, -20);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x99b8cc, 0.65));
  }

  buildWater() {
    // big animated plane; caustic tiles scroll as underwater shimmer overlay is faked by scrolling uv layers
    const geo = new THREE.PlaneGeometry(600, 600, 96, 96);
    geo.rotateX(-Math.PI / 2);
    const texs = ['caustic0', 'caustic1', 'caustic2'].map(n => this.assets.textures.get(n));
    texs.forEach(t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40); });
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        tA: { value: texs[0] }, tB: { value: texs[1] }, tC: { value: texs[2] },
        time: { value: 0 },
      },
      vertexShader: `
        uniform float time;
        varying vec2 vUv; varying float vH;
        void main(){
          vUv = uv;
          vec3 p = position;
          float w1 = sin(p.x*0.09 + time*1.1) * 0.35 + sin(p.z*0.12 - time*0.8) * 0.30;
          float w2 = sin((p.x+p.z)*0.05 + time*0.55) * 0.45;
          p.y += w1 + w2;
          vH = p.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
        }`,
      fragmentShader: `
        uniform sampler2D tA, tB, tC; uniform float time;
        varying vec2 vUv; varying float vH;
        void main(){
          vec3 a = texture2D(tA, vUv*1.0 + vec2(time*0.006, time*0.004)).rgb;
          vec3 b = texture2D(tB, vUv*1.7 - vec2(time*0.004, time*0.005)).rgb;
          vec3 c = texture2D(tC, vUv*3.1 + vec2(-time*0.008, 0.)).rgb;
          vec3 deep = vec3(0.02,0.19,0.30);
          float lum = dot(a + b*0.8 + c*0.6, vec3(0.33));
          vec3 col = deep + (a*1.2 + b*0.9 + c*0.7) * 0.75;
          col += vec3(0.55,0.75,0.9) * smoothstep(1.05, 1.9, lum) * 0.35;  // sparkle highlights
          col += vH * 0.05;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.set(0, 0, -60);
    this.scene.add(this.water);
  }

  buildTerrain() {
    // underwater shelf: strip textures laid as a ground plane ring (cheap stand-in from the game's own art)
    const stmtex = this.assets.textures.get('strip2');
    stmtex.wrapS = stmtex.wrapT = THREE.RepeatWrapping;
    stmtex.repeat.set(6, 3);
    const geo = new THREE.PlaneGeometry(400, 400);
    geo.rotateX(Math.PI / 2); // face upward
    const mat = new THREE.MeshLambertMaterial({ map: stmtex, transparent: true, opacity: 0.95 });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -2.2;
    this.scene.add(m);
  }

  buildBoatAndRod() {
    // rod: faint line from a first-person anchor
    this.rodGroup = new THREE.Group();
    const rodMat = new THREE.MeshBasicMaterial({ color: 0x1c1c1c });
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.035, 2.4, 6), rodMat);
    seg.position.set(0.35, 1.6, 0.4);
    seg.rotation.set(0.6, 0, -0.35);
    this.rodGroup.add(seg);
    // simple boat silhouette below the camera (player stands in a boat)
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1.15, 20, 10, 0, Math.PI * 2, Math.PI * 0.52, Math.PI * 0.48), new THREE.MeshLambertMaterial({ color: 0x24333a }));
    hull.scale.set(0.9, 0.42, 2.0);
    hull.position.set(0, 0.72, 1.5);
    this.rodGroup.add(hull);
    this.scene.add(this.rodGroup);

    // line
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.lineMesh = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xe8e8ff, transparent: true, opacity: 0.7 }));
    this.lineMesh.visible = false;
    this.scene.add(this.lineMesh);
  }

  buildBobber() {
    const g = new THREE.SphereGeometry(0.09, 12, 10);
    const mat = new THREE.MeshPhongMaterial({ color: 0xd8402a });
    this.bobber = new THREE.Mesh(g, mat);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.09, 6), new THREE.MeshPhongMaterial({ color: 0xffffff }));
    tip.position.y = 0.085;
    this.bobber.add(tip);
    this.bobber.visible = false;
    this.scene.add(this.bobber);
  }

  buildSplash() {
    // splash decal as vertical sprite
    const tex = this.assets.textures.get('splash');
    this.splash = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.splash.scale.set(1.6, 1.6, 1);
    this.splash.visible = false;
    this.scene.add(this.splash);
  }

  buildFish() {
    // procedural fish silhouette (flat sprite planes) that leaps on a catch
    const c = document.createElement('canvas'); c.width = 64; c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(20,60,110,1)';
    g.beginPath();
    g.moveTo(4, 16); g.quadraticCurveTo(20, 2, 44, 12); g.lineTo(60, 6); g.lineTo(56, 16);
    g.lineTo(60, 26); g.lineTo(44, 20); g.quadraticCurveTo(20, 30, 4, 16);
    g.fill();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.fish = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.fish.scale.set(2.2, 1.1, 1);
    this.fish.visible = false;
    this.scene.add(this.fish);
  }

  update() {
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    this.waterMat.uniforms.time.value = t;
    return { dt, t };
  }
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
    this.bobPos = new THREE.Vector3(0.35, 1.9, 0.4);
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
    this.ui.score.textContent = this.score + (this.score === 1 ? ' fish' : ' fish');
    // fish leap: animate a sprite out of the water at bobber
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
      // gentle rod windup
      this.w.rodGroup.rotation.x = -0.25 * this.power;
    } else if (this.state === ST.CAST && this.bobVel) {
      this.bobVel.y -= 9.8 * dt;
      this.bobPos.addScaledVector(this.bobVel, dt);
      if (this.bobPos.y <= 0) this.landAt(this.bobPos.clone().setY(0));
    } else if (this.state === ST.FLOAT) {
      this.bobPos.y = Math.sin(t * 2.2) * 0.045;                 // bobbing
      this.biteAt -= dt;
      if (this.biteAt <= 0) {
        this.setState(ST.STRIKE);
        this.biteDeadline = 1.1;  // window
      }
    } else if (this.state === ST.STRIKE) {
      this.ui.state.classList.add('strike');
      this.bobPos.y = -0.12 - Math.sin(t * 24) * 0.05;           // aggressive dip
      this.biteDeadline -= dt;
      if (this.biteDeadline <= 0) { this.missBite(); }
    } else if (this.state === ST.CATCH) {
      const p = Math.min(1, (t - this.fishStart) / 0.9);
      this.w.fish.position.y = Math.sin(p * Math.PI) * 2.2;      // arc leap
      this.w.fish.scale.set(2.2 * (1 - p) + 0.6, 1.1 * (1 - p) + 0.3, 1);
    }

    // bobber + rod tip
    if (this.w.bobber.visible) {
      this.w.bobber.position.copy(this.bobPos);
      // line from rod tip to bobber
      const tip = new THREE.Vector3(0.55, 2.6, 0.2);
      const attr = this.w.lineMesh.geometry.getAttribute('position');
      attr.setXYZ(0, tip.x, tip.y, tip.z);
      attr.setXYZ(1, this.bobPos.x, Math.max(this.bobPos.y, 0.02) + 0.05, this.bobPos.z + 0.05);
      attr.needsUpdate = true;
    }
    if (this.w.splash.visible) {
      this.splashT += dt;
      const s = 1.2 + this.splashT * 2.4;
      this.w.splash.scale.set(s, s, 1);
      if (this.splashT > 0.8) this.w.splash.visible = false;
    }
    // idle camera breathing
    this.w.camera.position.y = 2.4 + Math.sin(t * 0.9) * 0.06;
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

  let amb = 0;
  document.getElementById('startbtn').addEventListener('click', async () => {
    await assets.audioCtx.resume().catch(() => {});
    document.getElementById('loadscreen').classList.add('done');
    document.getElementById('hud').classList.remove('hidden');
    game.armed = true;                       // input active only now
    try {
      const amb = SFX_KEYS.tune && SFX_KEYS.tune.k ? SFX_KEYS.tune.k : null;
      if (amb) assets.play(amb, 0.12);
    } catch { /* ambience is optional */ }
    amb = 1;
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
