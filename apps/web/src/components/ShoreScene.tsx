import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { prefersReducedMotion } from '../lib/format.js';

export type SceneMode = 'shore' | 'throw';

export interface ThrowController {
  // Seconds into the one-shot release timeline; the parent drives it so UI beats stay in sync.
  seek(t: number): void;
}

export type SceneWeather = 'calm' | 'storm';

interface Props {
  mode: SceneMode;
  showBottle?: boolean;
  // Cosmetic only. Terrain, coastline, rocks, shells, grass, the bottle transform and the
  // camera are identical in both states — storm changes materials, lights, fog and the
  // rain/spray/cloud groups and nothing else (weather handoff v1.1 · IMPLEMENTATION.md).
  weather?: SceneWeather;
  onReady?: () => void;
  onController?: (c: ThrowController | null) => void;
}

const TEX = {
  skyShore: '/textures/sky-dusk-equirect-1024x512.png',
  skyThrow: '/textures/sky-golden-equirect-1024x512.png',
  skyStorm: '/textures/sky-storm-equirect-1024x512.png',
  sand: '/textures/sand-dry-512.png',
  sandWet: '/textures/sand-wet-256.png',
  foam: '/textures/foam-512x256.png',
  cloud: '/textures/cloud-sprite-256.png',
  cloudStorm: '/textures/cloud-storm-sprite-256.png',
  spray: '/textures/spray-sheet-sprite-256.png',
};

// The two weather parameter sets (DESIGN_TOKENS.json → three.calm / three.storm). Switching
// between them lerps values only: nothing is allocated, added or removed at switch time.
const WEATHER = {
  calm: {
    exposure: 0.92,
    sun: { color: 0xffe0b8, intensity: 3.1 },
    hemi: { intensity: 1.1 },
    fog: { color: 0x466a76, near: 200, far: 680 },
    water: { color: 0x08293a, roughness: 0.14, clearcoat: 0.45, clearcoatRoughness: 0.12 },
    waveAmplitude: 1,
    waveSpeed: 1,
    foamOpacity: 0.5,
    foamSurgeHz: 0.35,
    foamTravel: 2.6,
    wetRoughness: 0.35,
    sandTint: 0xffffff,
    wetTint: 0xffffff,
    cloudOpacity: 0.55,
    cloudTint: 0xffffff,
    stormCloudOpacity: 0,
    cloudDrift: 0.012,
    birdOpacity: 0.55,
    rainOpacity: 0,
    sprayOpacity: 0,
  },
  storm: {
    exposure: 1.02,
    sun: { color: 0xc4d2d2, intensity: 1.15 },
    hemi: { intensity: 1.95 },
    fog: { color: 0x4d5f66, near: 120, far: 520 },
    water: { color: 0x27505c, roughness: 0.42, clearcoat: 0.28, clearcoatRoughness: 0.3 },
    waveAmplitude: 2.5,
    waveSpeed: 1.5,
    foamOpacity: 0.72,
    foamSurgeHz: 0.62,
    foamTravel: 4.4,
    wetRoughness: 0.16,
    sandTint: 0xb7ad99,
    wetTint: 0x8d9490,
    cloudOpacity: 0.2,
    cloudTint: 0x7d8b90,
    stormCloudOpacity: 0.85,
    cloudDrift: 0.06,
    birdOpacity: 0,
    rainOpacity: 0.46,
    sprayOpacity: 0.34,
  },
} as const;

// 4s cross-weather blend (ANIMATION_STORYBOARD.md §C); reduced motion cuts to a single frame.
const WEATHER_BLEND_S = 4;
// Reduced motion keeps the rain legible as a static field at 22%.
const REDUCED_RAIN_OPACITY = 0.22;
const RAIN_SEGMENTS = 1700;
const SPRAY_SPRITES = 7;
const STORM_CLOUDS = 11;

// Release timeline (ANIMATION_STORYBOARD.md §A), seconds.
export const THROW_TOTAL_S = 4.3;
export const THROW_BEATS = [
  { at: 0.0, name: 'roll', title: 'The letter rolls' },
  { at: 0.5, name: 'insert', title: 'Into the glass' },
  { at: 1.1, name: 'cork', title: 'Sealed' },
  { at: 1.4, name: 'wind-up', title: 'A deep breath' },
  { at: 1.75, name: 'throw', title: 'It leaves your hand' },
  { at: 2.45, name: 'splash', title: 'The sea takes it' },
  { at: 3.0, name: 'floating', title: 'Afloat' },
  { at: 3.4, name: 'pull-back', title: 'Out to sea' },
  { at: 4.3, name: 'map', title: 'Charted' },
] as const;

function makeBottle(env: THREE.Texture | null): {
  group: THREE.Group;
  cork: THREE.Mesh;
  paper: THREE.Mesh;
} {
  const group = new THREE.Group();
  const profile = [
    [0, 0],
    [0.085, 0],
    [0.092, 0.015],
    [0.092, 0.17],
    [0.086, 0.2],
    [0.05, 0.245],
    [0.041, 0.27],
    [0.045, 0.3],
    [0.041, 0.305],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xd9efe9,
    roughness: 0.04,
    metalness: 0,
    transmission: 1,
    thickness: 0.22,
    ior: 1.48,
    transparent: true,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.6,
    side: THREE.DoubleSide,
  });
  if (env) glass.envMap = env;
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), glass);
  body.castShadow = true;
  group.add(body);
  const paper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.17, 20, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xefe0bd, roughness: 0.92, side: THREE.DoubleSide }),
  );
  paper.position.set(0, 0.095, 0);
  paper.rotation.z = 0.12;
  group.add(paper);
  const cork = new THREE.Mesh(
    new THREE.CylinderGeometry(0.043, 0.04, 0.055, 20),
    new THREE.MeshStandardMaterial({ color: 0xc19a63, roughness: 0.85 }),
  );
  cork.position.set(0, 0.318, 0);
  group.add(cork);
  return { group, cork, paper };
}

function rock(size: number): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(size, 1);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(
      i,
      p.getX(i) * (1 + (Math.random() - 0.5) * 0.45),
      p.getY(i) * (1 + (Math.random() - 0.5) * 0.35),
      p.getZ(i) * (1 + (Math.random() - 0.5) * 0.45),
    );
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x4a4740, roughness: 0.95 }),
  );
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

// Real-time coastal scene ported from the handoff's shore3d.js: displaced water, textured sand
// with a wet band, scrolling foam, rocks, shells, dune grass, drifting clouds, gulls and a
// physically-based glass bottle. The parent owns the throw timeline via seek().
export function ShoreScene({
  mode,
  showBottle = true,
  weather = 'calm',
  onReady,
  onController,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const showBottleRef = useRef(showBottle);
  useEffect(() => {
    showBottleRef.current = showBottle;
  }, [showBottle]);
  // The scene reads the target through a ref, so a weather change never re-creates the canvas.
  const weatherRef = useRef<SceneWeather>(weather);
  const repaintRef = useRef<() => void>(() => {});
  useEffect(() => {
    weatherRef.current = weather;
    repaintRef.current();
  }, [weather]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      queueMicrotask(() => setFailed(true));
      return;
    }
    const reduced = prefersReducedMotion();
    const w = host.clientWidth || 390;
    const h = host.clientHeight || 700;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const isThrow = mode === 'throw';
    scene.fog = new THREE.Fog(
      isThrow ? 0x8d6f52 : 0x466a76,
      isThrow ? 220 : 200,
      isThrow ? 700 : 680,
    );
    const cam = new THREE.PerspectiveCamera(isThrow ? 46 : w >= 900 ? 34 : 40, w / h, 0.1, 900);

    const sun = new THREE.DirectionalLight(0xffe0b8, 3.1);
    sun.position.set(isThrow ? 40 : -46, 16, -70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    scene.add(sun);
    const hemi = new THREE.HemisphereLight(0xbcd8de, 0x6b5b45, 1.1);
    scene.add(hemi);

    const loader = new THREE.TextureLoader();
    const load = (url: string) =>
      new Promise<THREE.Texture>((resolve, reject) => loader.load(url, resolve, undefined, reject));

    // Water
    const wGeo = new THREE.PlaneGeometry(700, 700, 96, 96);
    wGeo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(
      wGeo,
      new THREE.MeshPhysicalMaterial({
        color: isThrow ? 0x0a2e3f : 0x08293a,
        roughness: 0.14,
        metalness: 0,
        envMapIntensity: 0.85,
        clearcoat: 0.45,
        clearcoatRoughness: 0.12,
      }),
    );
    water.position.z = -200;
    scene.add(water);
    const wPos = wGeo.attributes.position as THREE.BufferAttribute;
    const wBase = Float32Array.from(wPos.array);

    // Sand
    const sGeo = new THREE.PlaneGeometry(700, 260, 90, 40);
    sGeo.rotateX(-Math.PI / 2);
    const sp = sGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      const z = sp.getZ(i);
      const x = sp.getX(i);
      const slope = Math.max(-1.2, (z + 130) * 0.055) - 1.0;
      const dune = Math.max(0, (z + 60) * 0.02);
      sp.setY(
        i,
        slope +
          dune +
          Math.sin(x * 0.21) * 0.12 +
          Math.sin(z * 0.34 + x * 0.1) * 0.09 +
          (Math.random() - 0.5) * 0.06,
      );
    }
    sGeo.computeVertexNormals();
    const sandMat = new THREE.MeshStandardMaterial({
      color: 0xc9ab7c,
      roughness: 0.96,
      metalness: 0,
    });
    const sand = new THREE.Mesh(sGeo, sandMat);
    sand.position.z = 132;
    sand.receiveShadow = true;
    scene.add(sand);
    const wetMat = new THREE.MeshStandardMaterial({
      color: 0x8a7350,
      roughness: 0.35,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
    });
    const wet = new THREE.Mesh(new THREE.PlaneGeometry(700, 44), wetMat);
    wet.rotation.x = -Math.PI / 2;
    wet.position.set(0, 0.02, 24);
    scene.add(wet);

    // Foam
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      opacity: 0.62,
    });
    const foam = new THREE.Mesh(new THREE.PlaneGeometry(700, 30), foamMat);
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(0, 0.06, 18);
    scene.add(foam);
    const foam2Mat = foamMat.clone();
    foam2Mat.opacity = 0.5;
    const foam2 = new THREE.Mesh(foam.geometry, foam2Mat);
    foam2.rotation.x = -Math.PI / 2;
    foam2.scale.set(1, 1, 0.7);
    foam2.position.set(0, 0.05, 4);
    scene.add(foam2);

    // Rocks, shells, grass
    for (const [s, x, y, z] of [
      [1.5, -11, -0.2, 22],
      [0.9, -8.6, 0.05, 29],
      [2.1, 15, -0.4, 14],
    ]) {
      const r = rock(s!);
      r.position.set(x!, y!, z);
      scene.add(r);
    }
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xf0e3ce, roughness: 0.5 });
    for (let s = 0; s < 7; s++) {
      const sh = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, 0, 1.4),
        shellMat,
      );
      sh.position.set(
        (Math.random() - 0.5) * 16,
        0.16 + Math.random() * 0.06,
        27 + Math.random() * 11,
      );
      sh.rotation.set(Math.random(), Math.random() * 6, Math.random() * 0.4);
      sh.scale.set(1, 0.6, 1);
      sh.castShadow = true;
      scene.add(sh);
    }
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x6f7a4e, roughness: 0.9 });
    for (let g = 0; g < 26; g++) {
      const bl = new THREE.Mesh(new THREE.ConeGeometry(0.07, 1.1 + Math.random(), 4), grassMat);
      bl.position.set(
        (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 16),
        1.5 + Math.random() * 0.5,
        44 + Math.random() * 30,
      );
      bl.rotation.z = (Math.random() - 0.5) * 0.5;
      bl.castShadow = true;
      scene.add(bl);
    }

    // Clouds & birds
    const clouds: THREE.Sprite[] = [];
    const cloudMat = new THREE.SpriteMaterial({
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    for (let c = 0; c < 5; c++) {
      const cl = new THREE.Sprite(cloudMat);
      cl.scale.set(120 + Math.random() * 90, 34 + Math.random() * 18, 1);
      cl.position.set(
        (Math.random() - 0.5) * 300,
        34 + Math.random() * 26,
        -180 - Math.random() * 120,
      );
      clouds.push(cl);
      scene.add(cl);
    }
    const birds: THREE.Line[] = [];
    const birdMat = new THREE.LineBasicMaterial({
      color: 0x2b3238,
      transparent: true,
      opacity: 0.55,
    });
    for (let b = 0; b < 4; b++) {
      const bg = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.9, 0, 0),
        new THREE.Vector3(0, 0.45, 0),
        new THREE.Vector3(0.9, 0, 0),
      ]);
      const bd = new THREE.Line(bg, birdMat);
      bd.position.set(-60 + b * 22, 24 + Math.random() * 12, -110 - Math.random() * 60);
      bd.scale.setScalar(1 + Math.random() * 0.6);
      birds.push(bd);
      scene.add(bd);
    }

    // The storm sky is a back-facing dome that cross-fades over scene.background, so day and
    // weather skies blend rather than cut. Allocated once, driven only by opacity.
    const stormSkyMat = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      color: 0x2b3a42,
    });
    const stormSky = new THREE.Mesh(new THREE.SphereGeometry(860, 32, 16), stormSkyMat);
    stormSky.renderOrder = -1;
    scene.add(stormSky);

    // Storm clouds, rain and spray are allocated once, at load, in both weather states and
    // driven purely by opacity — so switching weather adds and removes nothing (the rule in
    // IMPLEMENTATION.md) and the scene graph differs only in materials and these groups.
    const stormCloudMat = new THREE.SpriteMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      color: WEATHER.storm.cloudTint,
    });
    const stormClouds: THREE.Sprite[] = [];
    for (let c = 0; c < STORM_CLOUDS; c++) {
      const cl = new THREE.Sprite(stormCloudMat);
      cl.scale.set(190 + Math.random() * 110, 62 + Math.random() * 26, 1);
      cl.position.set(
        (Math.random() - 0.5) * 420,
        22 + Math.random() * 40,
        -140 - Math.random() * 160,
      );
      stormClouds.push(cl);
      scene.add(cl);
    }

    // Rain: one LineSegments draw call, 1700 two-point streaks wrapping at 42 units. The spawn
    // volume deliberately excludes the band around the resting bottle, so no streak ever
    // crosses the glass.
    const rainGeo = new THREE.BufferGeometry();
    const rainArr = new Float32Array(RAIN_SEGMENTS * 6);
    const rainSeed = new Float32Array(RAIN_SEGMENTS * 4);
    for (let q = 0; q < RAIN_SEGMENTS; q++) {
      rainSeed[q * 4] = (Math.random() - 0.5) * 52;
      rainSeed[q * 4 + 1] = Math.random() * 40;
      rainSeed[q * 4 + 2] = 8 + Math.random() * 40;
      rainSeed[q * 4 + 3] = 20 + Math.random() * 18;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainArr, 3));
    const rainMat = new THREE.LineBasicMaterial({
      color: 0xe4f1f4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const rain = new THREE.LineSegments(rainGeo, rainMat);
    rain.frustumCulled = false;
    scene.add(rain);
    const rainPos = rainGeo.attributes.position as THREE.BufferAttribute;

    const sprayMat = new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const spray: Array<{ sprite: THREE.Sprite; ph: number; bx: number; k: number }> = [];
    for (let si = 0; si < SPRAY_SPRITES; si++) {
      const sp = new THREE.Sprite(sprayMat);
      sp.scale.set(22 + Math.random() * 16, 5 + Math.random() * 4, 1);
      sp.position.set(
        (Math.random() - 0.5) * 60,
        1.2 + Math.random() * 1.6,
        12 + Math.random() * 14,
      );
      spray.push({
        sprite: sp,
        ph: Math.random() * 6.283,
        bx: sp.position.x,
        k: 0.3 + Math.random() * 0.7,
      });
      scene.add(sp);
    }

    // Bottle + splash
    const bottle = makeBottle(null);
    bottle.group.scale.setScalar(isThrow ? 5 : 4.2);
    scene.add(bottle.group);
    const ripples: THREE.Mesh[] = [];
    const drops: Array<{ mesh: THREE.Mesh; a: number; sp: number; up: number }> = [];
    if (isThrow) {
      for (let i = 0; i < 3; i++) {
        const rp = new THREE.Mesh(
          new THREE.RingGeometry(0.6, 0.85, 48),
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        rp.rotation.x = -Math.PI / 2;
        ripples.push(rp);
        scene.add(rp);
      }
      const dMat = new THREE.MeshPhysicalMaterial({
        color: 0xdff1f3,
        roughness: 0.05,
        transmission: 0.9,
        thickness: 0.2,
        transparent: true,
      });
      for (let i = 0; i < 14; i++) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.09 + Math.random() * 0.1, 8, 6),
          dMat,
        );
        mesh.visible = false;
        drops.push({
          mesh,
          a: Math.random() * Math.PI * 2,
          sp: 1.6 + Math.random() * 3.4,
          up: 3 + Math.random() * 4.5,
        });
        scene.add(mesh);
      }
    }

    let disposed = false;
    let running = true;
    let throwT = 0;
    const timer = new THREE.Timer();
    const t0 = isThrow ? 0 : 3;

    // Wave amplitude and speed ramp with the weather blend; the mesh itself never changes.
    function updateWater(t: number, weatherK = 0) {
      const amp =
        WEATHER.calm.waveAmplitude +
        (WEATHER.storm.waveAmplitude - WEATHER.calm.waveAmplitude) * weatherK;
      const speed =
        WEATHER.calm.waveSpeed + (WEATHER.storm.waveSpeed - WEATHER.calm.waveSpeed) * weatherK;
      const arr = wPos.array as Float32Array;
      for (let i = 0; i < wPos.count; i++) {
        const x = wBase[i * 3]!;
        const z = wBase[i * 3 + 2]!;
        arr[i * 3 + 1] =
          amp *
          (Math.sin(x * 0.07 + t * speed * 1.1) * 0.34 +
            Math.sin(z * 0.09 - t * speed * 0.85) * 0.28 +
            Math.sin((x + z) * 0.045 + t * speed * 1.6) * 0.18);
      }
      wPos.needsUpdate = true;
      wGeo.computeVertexNormals();
    }

    function poseThrow(t: number) {
      // Beats: 0.5 insert → 1.1 cork → 1.4 wind-up → 1.75 throw → 2.45 splash → 3.0 float → 3.4 pull-back.
      const hand = new THREE.Vector3(-3.2, 3.6, 34);
      const insert = smooth((t - 0.5) / 0.6);
      const corkIn = smooth((t - 1.1) / 0.3);
      const wind = smooth((t - 1.4) / 0.35);
      const flight = clamp01((t - 1.75) / 0.7);
      const after = clamp01((t - 2.45) / 0.55);
      const pull = smooth((t - 3.4) / 0.9);

      bottle.paper.position.y = 0.095 + (1 - insert) * 0.36;
      bottle.paper.visible = t >= 0.5 || insert > 0;
      bottle.cork.position.y = 0.318 + (1 - corkIn) * 0.14;

      if (t < 1.75) {
        bottle.group.position.set(hand.x - wind * 1.1, hand.y - wind * 0.4, hand.z + wind * 1.4);
        bottle.group.rotation.set(-0.35 - wind * 0.25, 0.4, 0.5 - wind * 0.3);
        cam.position.set(-4.6, 4.2 - wind * 0.4, 41);
        cam.rotation.set(0, 0, 0);
        cam.lookAt(hand.x * 0.8, 1.4 + (1 - wind) * 1.2, hand.z * 0.55);
        cam.rotateZ(-wind * 0.1);
        ripples.forEach((r) => ((r.material as THREE.MeshBasicMaterial).opacity = 0));
        drops.forEach((d) => (d.mesh.visible = false));
        return;
      }
      const ex = -3.2 + flight * 9.5;
      const ey = 3.6 + Math.sin(flight * Math.PI) * 10 - flight * 3.4;
      const ez = 34 - flight * 40;
      if (flight < 1) {
        bottle.group.position.set(ex, Math.max(ey, 0.1), ez);
        bottle.group.rotation.set(flight * 5.2, flight * 2.1, 0.5 + flight * 3.4);
      } else {
        bottle.group.position.set(ex, 0.15 + Math.sin(t * 2.2) * 0.12, ez);
        bottle.group.rotation.set(-1.2, 0.4, 0.2 + Math.sin(t * 1.6) * 0.05);
      }
      ripples.forEach((r, i) => {
        const rp = Math.max(0, after - i * 0.16);
        r.position.set(ex, 0.05, ez);
        r.scale.setScalar(1 + rp * 11);
        (r.material as THREE.MeshBasicMaterial).opacity =
          after > 0 ? Math.max(0, 0.55 * (1 - rp)) : 0;
      });
      drops.forEach((d) => {
        const dt = after * 1.5;
        if (after <= 0 || dt > 1.1) {
          d.mesh.visible = false;
          return;
        }
        d.mesh.visible = true;
        d.mesh.position.set(
          ex + Math.cos(d.a) * d.sp * dt,
          0.1 + d.up * dt - 9.8 * dt * dt * 0.5,
          ez + Math.sin(d.a) * d.sp * dt,
        );
      });
      const camBase = new THREE.Vector3(-4.6 + flight * 1.4, 4.2 + flight * 1.6, 41 - flight * 3);
      cam.position.set(camBase.x, camBase.y + pull * 22, camBase.z + pull * 6);
      cam.fov = 46 - pull * 6;
      cam.updateProjectionMatrix();
      cam.lookAt(
        bottle.group.position.x * 0.8,
        Math.max(1.4, bottle.group.position.y * 0.7),
        bottle.group.position.z * 0.55,
      );
    }

    // ---- weather blend ----
    // `blend` is 0 at calm and 1 at storm and moves over WEATHER_BLEND_S. Only materials,
    // lights, fog and the weather groups read it.
    let blend = weatherRef.current === 'storm' ? 1 : 0;
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    const tmpA = new THREE.Color();
    const tmpB = new THREE.Color();
    const mix = (a: number, b: number, k: number) =>
      tmpA.setHex(a).lerp(tmpB.setHex(b), k).getHex();

    function applyWeather(dt: number) {
      const target = weatherRef.current === 'storm' ? 1 : 0;
      if (blend !== target) {
        const step = reduced ? 1 : dt / WEATHER_BLEND_S;
        blend = target > blend ? Math.min(target, blend + step) : Math.max(target, blend - step);
      }
      const k = smooth(blend);
      const calm = WEATHER.calm;
      const storm = WEATHER.storm;
      renderer.toneMappingExposure = lerp(calm.exposure, storm.exposure, k);
      sun.color.setHex(mix(calm.sun.color, storm.sun.color, k));
      sun.intensity = lerp(calm.sun.intensity, storm.sun.intensity, k);
      hemi.intensity = lerp(calm.hemi.intensity, storm.hemi.intensity, k);
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.color.setHex(mix(calm.fog.color, storm.fog.color, k));
        scene.fog.near = lerp(calm.fog.near, storm.fog.near, k);
        scene.fog.far = lerp(calm.fog.far, storm.fog.far, k);
      }
      const wm = water.material;
      if (!isThrow) wm.color.setHex(mix(calm.water.color, storm.water.color, k));
      wm.roughness = lerp(calm.water.roughness, storm.water.roughness, k);
      wm.clearcoat = lerp(calm.water.clearcoat, storm.water.clearcoat, k);
      wm.clearcoatRoughness = lerp(
        calm.water.clearcoatRoughness,
        storm.water.clearcoatRoughness,
        k,
      );
      sandMat.color.setHex(mix(calm.sandTint, storm.sandTint, k));
      wetMat.color.setHex(mix(calm.wetTint, storm.wetTint, k));
      wetMat.roughness = lerp(calm.wetRoughness, storm.wetRoughness, k);
      cloudMat.opacity = lerp(calm.cloudOpacity, storm.cloudOpacity, k);
      cloudMat.color.setHex(mix(calm.cloudTint, storm.cloudTint, k));
      stormCloudMat.opacity = lerp(calm.stormCloudOpacity, storm.stormCloudOpacity, k);
      stormSkyMat.opacity = k;
      birdMat.opacity = lerp(calm.birdOpacity, storm.birdOpacity, k);
      const rainTarget = reduced ? REDUCED_RAIN_OPACITY : storm.rainOpacity;
      rainMat.opacity = lerp(calm.rainOpacity, rainTarget, k);
      sprayMat.opacity = lerp(calm.sprayOpacity, storm.sprayOpacity, k) * 0.7;
      return k;
    }

    // Rain streaks fall and wrap; under reduced motion the field is drawn once and held.
    function updateRain(t: number) {
      if (rainMat.opacity <= 0.001) return;
      for (let q = 0; q < RAIN_SEGMENTS; q++) {
        const x = rainSeed[q * 4]!;
        const z = rainSeed[q * 4 + 2]!;
        const speed = rainSeed[q * 4 + 3]!;
        const y = reduced
          ? rainSeed[q * 4 + 1]!
          : (rainSeed[q * 4 + 1]! + 42 - ((t * speed) % 42)) % 42;
        const i = q * 6;
        rainArr[i] = x;
        rainArr[i + 1] = y;
        rainArr[i + 2] = z;
        rainArr[i + 3] = x + 0.11 * 1.4;
        rainArr[i + 4] = y - 1.4;
        rainArr[i + 5] = z;
      }
      rainPos.needsUpdate = true;
    }

    function frame(force = false) {
      if (disposed) return;
      timer.update();
      const dt = timer.getDelta();
      const t = t0 + (reduced && !isThrow ? 0 : timer.getElapsed());
      const wk = applyWeather(dt);
      const foamHz = lerp(WEATHER.calm.foamSurgeHz, WEATHER.storm.foamSurgeHz, wk);
      const foamTravel = lerp(WEATHER.calm.foamTravel, WEATHER.storm.foamTravel, wk);
      const foamPeak = lerp(WEATHER.calm.foamOpacity, WEATHER.storm.foamOpacity, wk);
      const cloudDrift = lerp(WEATHER.calm.cloudDrift, WEATHER.storm.cloudDrift, wk);
      updateWater(isThrow ? throwT + 1.1 : t, wk);
      updateRain(t);
      spray.forEach((sp) => {
        sp.sprite.position.x = sp.bx + (reduced ? 0 : Math.sin(t * 0.5 + sp.ph) * 5);
      });
      if (foamMat.map) foamMat.map.offset.x = t * 0.012;
      if (foam2Mat.map) foam2Mat.map.offset.x = -t * 0.008;
      foam.position.z = 18 + Math.sin(t * foamHz) * foamTravel;
      foamMat.opacity = foamPeak + Math.sin(t * foamHz) * 0.16;
      wetMat.opacity = 0.86 + Math.sin(t * 0.35) * 0.1;
      clouds.forEach((c, i) => (c.position.x += reduced ? 0 : cloudDrift * (i % 2 ? 1 : -1)));
      stormClouds.forEach(
        (c, i) => (c.position.x += reduced ? 0 : cloudDrift * (i % 2 ? 1 : -1) * 0.8),
      );
      birds.forEach((b, i) => {
        b.position.x = -60 + i * 22 + Math.sin(t * 0.12 + i) * 34;
        b.position.y = 24 + i * 3 + Math.sin(t * 0.8 + i * 2) * 1.2;
      });
      if (isThrow) {
        poseThrow(throwT);
      } else {
        // Framing per reference C2: the bottle rests a little left of centre in the lower half of
        // the frame, whole and unclipped, with the horizon in the upper third.
        bottle.group.visible = showBottleRef.current;
        bottle.group.position.set(0.55, 0.14, 28.0);
        bottle.group.rotation.set(-1.3, 0.55 + Math.sin(t * 0.25) * 0.03, 0.24);
        cam.position.set(0.5 + Math.sin(t * 0.08) * 0.6, 2.7 + Math.sin(t * 0.21) * 0.09, 36.5);
        cam.lookAt(0.9, 0.7, 26);
      }
      renderer.render(scene, cam);
      if (running && !force && !(reduced && !isThrow)) requestAnimationFrame(() => frame());
    }

    const controller: ThrowController = {
      seek(t) {
        throwT = t;
        if (reduced || !running) frame(true);
      },
    };
    // Under reduced motion the loop renders a single frame; a weather change has to ask for a
    // new one, exactly as the resize observer does.
    repaintRef.current = () => {
      if (!disposed && (reduced || !running)) frame(true);
    };

    void (async () => {
      try {
        const [sky, sandTex, wetTex, foamTex, cloudTex] = await Promise.all([
          load(isThrow ? TEX.skyThrow : TEX.skyShore),
          load(TEX.sand),
          load(TEX.sandWet),
          load(TEX.foam),
          load(TEX.cloud),
        ]);
        // Weather textures load beside the calm ones and never block first paint; if any of
        // them is missing the scene still renders (tinted sprites carry the read).
        const weatherTex = await Promise.allSettled([
          load(TEX.skyStorm),
          load(TEX.cloudStorm),
          load(TEX.spray),
        ]);
        if (!disposed) {
          const [stormSkyTex, stormCloudTex, sprayTex] = weatherTex;
          if (stormSkyTex.status === 'fulfilled') {
            stormSkyTex.value.mapping = THREE.EquirectangularReflectionMapping;
            stormSkyTex.value.colorSpace = THREE.SRGBColorSpace;
            stormSkyMat.map = stormSkyTex.value;
            stormSkyMat.color.setHex(0xffffff);
            stormSkyMat.needsUpdate = true;
          }
          if (stormCloudTex.status === 'fulfilled') {
            stormCloudMat.map = stormCloudTex.value;
            stormCloudMat.needsUpdate = true;
          }
          if (sprayTex.status === 'fulfilled') {
            sprayMat.map = sprayTex.value;
            sprayMat.needsUpdate = true;
          }
        }
        if (disposed) return;
        sky.mapping = THREE.EquirectangularReflectionMapping;
        sky.colorSpace = THREE.SRGBColorSpace;
        scene.background = sky;
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromEquirectangular(sky).texture;
        for (const tx of [sandTex, wetTex, foamTex]) {
          tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
        }
        sandTex.colorSpace = THREE.SRGBColorSpace;
        sandTex.repeat.set(26, 10);
        sandMat.map = sandTex;
        sandMat.needsUpdate = true;
        wetTex.colorSpace = THREE.SRGBColorSpace;
        wetTex.repeat.set(20, 3);
        wetMat.map = wetTex;
        wetMat.needsUpdate = true;
        foamTex.repeat.set(12, 1);
        foamMat.map = foamTex;
        foamMat.needsUpdate = true;
        foam2Mat.map = foamTex.clone();
        foam2Mat.map.needsUpdate = true;
        foam2Mat.needsUpdate = true;
        cloudMat.map = cloudTex;
        cloudMat.needsUpdate = true;
      } catch {
        // Textures are decorative: the procedural scene still renders without them.
      }
      if (disposed) return;
      frame();
      setReady(true);
      onReady?.();
      onController?.(isThrow ? controller : null);
    })();

    const ro = new ResizeObserver(() => {
      const W = host.clientWidth;
      const H = host.clientHeight;
      if (!W || !H) return;
      renderer.setSize(W, H, false);
      cam.aspect = W / H;
      if (!isThrow) cam.fov = W >= 900 ? 34 : 40;
      cam.updateProjectionMatrix();
      if (reduced) frame(true);
    });
    ro.observe(host);
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries[0]?.isIntersecting ?? true;
        if (vis && !running) {
          running = true;
          frame();
        }
        if (!vis) running = false;
      },
      { threshold: 0.02 },
    );
    io.observe(host);
    const onVis = () => {
      if (document.hidden) running = false;
      else if (!running) {
        running = true;
        frame();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      disposed = true;
      running = false;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      onController?.(null);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const mesh = o as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          mesh.geometry.dispose();
          const m = mesh.material;
          (Array.isArray(m) ? m : [m]).forEach((mm) => mm.dispose());
        }
      });
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <div ref={hostRef} className={`shore-scene ${mode}${ready ? ' ready' : ''}`} aria-hidden>
      <div
        className="poster"
        style={{ backgroundImage: `url(${mode === 'throw' ? TEX.skyThrow : TEX.skyShore})` }}
      />
      <canvas ref={canvasRef} />
      {failed ? (
        <p className="scene-fallback">The shore needs WebGL, which this browser cannot provide.</p>
      ) : null}
    </div>
  );
}
