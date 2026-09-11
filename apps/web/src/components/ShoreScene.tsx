import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { prefersReducedMotion } from '../lib/format.js';

export type SceneMode = 'shore' | 'throw';

export interface ThrowController {
  // Seconds into the one-shot release timeline; the parent drives it so UI beats stay in sync.
  seek(t: number): void;
}

interface Props {
  mode: SceneMode;
  showBottle?: boolean;
  onReady?: () => void;
  onController?: (c: ThrowController | null) => void;
}

const TEX = {
  skyShore: '/textures/sky-dusk-equirect-1024x512.png',
  skyThrow: '/textures/sky-golden-equirect-1024x512.png',
  sand: '/textures/sand-dry-512.png',
  sandWet: '/textures/sand-wet-256.png',
  foam: '/textures/foam-512x256.png',
  cloud: '/textures/cloud-sprite-256.png',
};

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
export function ShoreScene({ mode, showBottle = true, onReady, onController }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const showBottleRef = useRef(showBottle);
  useEffect(() => {
    showBottleRef.current = showBottle;
  }, [showBottle]);

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
    scene.add(new THREE.HemisphereLight(0xbcd8de, 0x6b5b45, 1.1));

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

    function updateWater(t: number) {
      const arr = wPos.array as Float32Array;
      for (let i = 0; i < wPos.count; i++) {
        const x = wBase[i * 3]!;
        const z = wBase[i * 3 + 2]!;
        arr[i * 3 + 1] =
          Math.sin(x * 0.07 + t * 1.1) * 0.34 +
          Math.sin(z * 0.09 - t * 0.85) * 0.28 +
          Math.sin((x + z) * 0.045 + t * 1.6) * 0.18;
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

    function frame(force = false) {
      if (disposed) return;
      timer.update();
      const t = t0 + (reduced && !isThrow ? 0 : timer.getElapsed());
      updateWater(isThrow ? throwT + 1.1 : t);
      if (foamMat.map) foamMat.map.offset.x = t * 0.012;
      if (foam2Mat.map) foam2Mat.map.offset.x = -t * 0.008;
      foam.position.z = 18 + Math.sin(t * 0.35) * 2.6;
      foamMat.opacity = 0.5 + Math.sin(t * 0.35) * 0.16;
      wetMat.opacity = 0.86 + Math.sin(t * 0.35) * 0.1;
      clouds.forEach((c, i) => (c.position.x += reduced ? 0 : 0.012 * (i % 2 ? 1 : -1)));
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

    void (async () => {
      try {
        const [sky, sandTex, wetTex, foamTex, cloudTex] = await Promise.all([
          load(isThrow ? TEX.skyThrow : TEX.skyShore),
          load(TEX.sand),
          load(TEX.sandWet),
          load(TEX.foam),
          load(TEX.cloud),
        ]);
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
