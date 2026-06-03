/**
 * CymaticsVisualizer — React/Three.js port of the GANTASMO cymatics renderer
 * (originally a Lit `visual-3d` web component). Renders one of four reflective
 * black-chrome modes inside a panel-sized canvas:
 *   - orb               : ferrofluid blob (Rosensweig spikes)
 *   - cymatics          : Chladni / Faraday liquid platform (fills the panel)
 *   - landscape-chrome  : infinite synthwave liquid-chrome valley
 *   - landscape-ferrofluid : the valley with magnetic spike terrain
 *
 * Differences from the original:
 *   - Sized to its CONTAINER (ResizeObserver) instead of the window.
 *   - Reacts to LIVE app audio via the shared player-engine master gain
 *     (playerStore). When nothing is audible it self-drives with gentle
 *     synthetic levels (crossfaded) so the panel stays alive at idle.
 *   - Dialed-back bloom; orb zoom + per-panel pole tilt; cymatics camera that
 *     covers the whole panel; landscape fog-to-black + a purple "plasma fusor"
 *     sun in the sky.
 *   - No Gemini / Lit dependencies; full Three.js teardown on unmount (two of
 *     these run side-by-side, so we free every GL resource).
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Circle, Droplet, Grid3x3, Mountain } from 'lucide-react';
import { fs as backdropFS, vs as backdropVS } from './cymatics/backdrop-shader';
import { vs as sphereVS } from './cymatics/sphere-shader';
import { vs as cymaticsVS } from './cymatics/cymatics-shader';
import { vs as landscapeVS } from './cymatics/landscape-shader';
import { Analyser } from './cymatics/analyser';

export type CymaticsMode = 'orb' | 'cymatics' | 'landscape-chrome' | 'landscape-ferrofluid';

/** Shared shape so the render loop can read real or synthetic frequency data. */
interface FreqSource {
  update(): void;
  readonly data: Uint8Array;
}

/**
 * Gentle self-driving frequency data for when no audio is audible, so the
 * meshes breathe/ripple/scroll at idle instead of sitting dead flat.
 */
class IdleSource implements FreqSource {
  private dataArray = new Uint8Array(16);
  private seed: number;
  constructor(seed = 0) {
    this.seed = seed;
  }
  update() {
    const t = performance.now() / 1000 + this.seed;
    for (let i = 0; i < 16; i++) {
      const bandFall = 1 - i / 24; // highs a touch quieter
      const slow = 0.5 + 0.5 * Math.sin(t * 0.45 + i * 0.55);
      const fast = 0.5 + 0.5 * Math.sin(t * 1.6 + i * 1.27);
      const v = (0.4 * slow + 0.28 * fast) * bandFall;
      this.dataArray[i] = Math.max(0, Math.min(255, Math.round(v * 120)));
    }
  }
  get data() {
    return this.dataArray;
  }
}

/**
 * Real audio (master-gain analyser) crossfaded with idle: when the track is
 * audible the visualizer follows it; when it goes quiet it eases back to gentle
 * idle motion rather than freezing.
 */
class HybridSource implements FreqSource {
  private real: Analyser;
  private idle: IdleSource;
  private buf = new Uint8Array(16);
  private activity = 0;
  constructor(node: AudioNode, seed = 0) {
    this.real = new Analyser(node);
    this.idle = new IdleSource(seed);
  }
  update() {
    this.real.update();
    this.idle.update();
    const rd = this.real.data;
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += rd[i];
    const target = sum > 16 ? 1 : 0; // audible vs silent
    this.activity += (target - this.activity) * 0.06; // ~1s ease
    const a = this.activity;
    const id = this.idle.data;
    for (let i = 0; i < 16; i++) this.buf[i] = Math.round((rd[i] || 0) * a + id[i] * (1 - a));
  }
  get data() {
    return this.buf;
  }
  dispose() {
    this.real.dispose();
  }
}

interface CymaticsVisualizerProps {
  mode: CymaticsMode;
  /** Optional live audio tap. When omitted, the visualizer self-drives. */
  audioNode?: AudioNode | null;
  /** Orb pole-axis tilt in degrees (use +90 / -90 on two panels to mirror). */
  orbTilt?: number;
  className?: string;
}

// Served from frontend/public at the site root (Vite default base '/').
const EXR_URL = '/piz_compressed.exr';
const FOV = 65;
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);

const CymaticsVisualizerImpl: React.FC<CymaticsVisualizerProps> = ({ mode, audioNode, orbTilt = 0, className }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<CymaticsMode>(mode);
  modeRef.current = mode;
  const orbTiltRef = useRef<number>(orbTilt);
  orbTiltRef.current = orbTilt;

  // Keep the live audio source in a ref so the (mount-once) render loop can
  // pick up a node that arrives/changes after init without re-creating the scene.
  const sourceRef = useRef<{ input: FreqSource; output: FreqSource }>({
    input: new IdleSource(0),
    output: new IdleSource(100),
  });

  useEffect(() => {
    let dispose: (() => void) | undefined;
    if (audioNode) {
      try {
        const h = new HybridSource(audioNode);
        sourceRef.current = { input: h, output: h };
        dispose = () => h.dispose();
      } catch {
        sourceRef.current = { input: new IdleSource(0), output: new IdleSource(100) };
      }
    } else {
      sourceRef.current = { input: new IdleSource(0), output: new IdleSource(100) };
    }
    return () => dispose?.();
  }, [audioNode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Let Three.js create and OWN its canvas. A canvas only ever returns its
    // first WebGL context, so reusing a stable canvas ref across React
    // StrictMode's mount→unmount→remount (where cleanup force-loses the
    // context) hands the remount a dead context → "getShaderPrecisionFormat
    // returns null" crash. A fresh canvas per mount avoids that entirely.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      // WebGL unavailable / context exhausted — leave the panel dark rather
      // than crashing the React tree.
      return;
    }
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
    container.appendChild(canvas);

    // --- Tunables (the original Lit component's @property defaults) ---
    const spikeDensity = 5.0;
    const spikeAmplitude = 0.8;
    const noiseViscosity = 1.2;
    const isFerrofluid = 1.0;
    const landscapeHeight = 1.5;
    const scrollSpeed = 1.0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e0912);
    // Fog used only in landscape modes so the valley dissolves into black.
    const landscapeFog = new THREE.Fog(0x000000, 5, 16);

    const backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(12, 5),
      new THREE.RawShaderMaterial({
        uniforms: {
          resolution: { value: new THREE.Vector2(1, 1) },
          rand: { value: 0 },
        },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    (backdrop.material as THREE.RawShaderMaterial).side = THREE.BackSide;
    scene.add(backdrop);

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
    camera.position.set(2, -2, 5);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    // 1. Ferrofluid blob (pristine high-gloss wet obsidian black)
    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0x010101,
      metalness: 0.99,
      roughness: 0.003,
      emissive: 0x000000,
    });
    sphereMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.uniforms.inputData = { value: new THREE.Vector4() };
      shader.uniforms.outputData = { value: new THREE.Vector4() };
      shader.uniforms.spikeDensity = { value: spikeDensity };
      shader.uniforms.spikeAmplitude = { value: spikeAmplitude };
      shader.uniforms.noiseViscosity = { value: noiseViscosity };
      shader.uniforms.isFerrofluid = { value: isFerrofluid };
      sphereMaterial.userData.shader = shader;
      shader.vertexShader = sphereVS;
    };
    const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 64), sphereMaterial);
    sphere.visible = false;
    scene.add(sphere);

    // 2. Cymatic platform (opaque black reflecting liquid ripples)
    const planeMaterial = new THREE.MeshStandardMaterial({
      color: 0x010101,
      metalness: 0.98,
      roughness: 0.005,
      emissive: 0x000000,
    });
    planeMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.uniforms.audioLevels = { value: new Float32Array(16) };
      shader.uniforms.activeModeIndex = { value: 0.0 };
      shader.uniforms.smoothedAmplitude = { value: 0.0 };
      shader.uniforms.cymaticAmplitude = { value: 1.0 };
      planeMaterial.userData.shader = shader;
      shader.vertexShader = cymaticsVS;
    };
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 3.5, 160, 160), planeMaterial);
    plane.visible = false;
    scene.add(plane);

    // 3. Infinite-scroll synthwave landscape (liquid obsidian & chrome)
    const landscapeMaterial = new THREE.MeshStandardMaterial({
      color: 0x010101,
      metalness: 0.99,
      roughness: 0.008,
      emissive: 0x000000,
    });
    landscapeMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.uniforms.audioData = { value: new THREE.Vector4() };
      shader.uniforms.scrollSpeed = { value: scrollSpeed };
      shader.uniforms.mountainHeight = { value: landscapeHeight };
      shader.uniforms.isFerrofluid = { value: 0.0 };
      landscapeMaterial.userData.shader = shader;
      shader.vertexShader = landscapeVS;
    };
    // Longer than the original so it recedes further before the fog swallows it.
    const landscape = new THREE.Mesh(new THREE.PlaneGeometry(16, 38, 220, 300), landscapeMaterial);
    landscape.rotation.x = -Math.PI / 2.3;
    landscape.position.set(0, -1.15, -8);
    landscape.visible = false;
    scene.add(landscape);

    // 3b. "Nuclear fusor" plasma sun in the synthwave sky (landscape modes).
    // MeshBasic + fog:false so it stays bright while the terrain fogs to black,
    // and blooms purple. A double counter-rotating wireframe cage = the fusor grid.
    const sun = new THREE.Group();
    const sunCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.45, 5),
      new THREE.MeshBasicMaterial({ color: 0xff4dff, fog: false }),
    );
    const sunCorona = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.05, 4),
      new THREE.MeshBasicMaterial({
        color: 0x9b30ff,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    const sunCage1 = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.55, 1),
      new THREE.MeshBasicMaterial({ color: 0xc77dff, wireframe: true, transparent: true, opacity: 0.7, fog: false }),
    );
    const sunCage2 = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.95, 2),
      new THREE.MeshBasicMaterial({ color: 0x36e0ff, wireframe: true, transparent: true, opacity: 0.35, fog: false }),
    );
    sun.add(sunCorona, sunCore, sunCage1, sunCage2);
    sun.position.set(0, 2.0, -10);
    sun.visible = false;
    scene.add(sun);

    // 4. Three-point studio + neon accent lighting
    const keyLight = new THREE.DirectionalLight(0xfff5ea, 1.2);
    keyLight.position.set(6, 9, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xb14dff, 0.9);
    rimLight.position.set(-6, -3, -4);
    scene.add(rimLight);
    const fillLight = new THREE.DirectionalLight(0x00d2ff, 0.4);
    fillLight.position.set(0, -6, 5);
    scene.add(fillLight);
    const ambientLight = new THREE.AmbientLight(0x0c0714, 0.15);
    scene.add(ambientLight);

    // Reflection environment map
    let isEnvMapLoaded = false;
    let envRenderTarget: THREE.WebGLRenderTarget | null = null;
    let disposed = false;
    let pmremDisposed = false;
    const exrLoader = new EXRLoader();
    exrLoader.load(EXR_URL, (texture: THREE.Texture) => {
      // The panel may have unmounted while the EXR was loading; don't touch the
      // disposed renderer/PMREM generator.
      if (disposed) {
        texture.dispose();
        return;
      }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const rt = pmremGenerator.fromEquirectangular(texture);
      envRenderTarget = rt;
      sphereMaterial.envMap = rt.texture;
      planeMaterial.envMap = rt.texture;
      landscapeMaterial.envMap = rt.texture;
      texture.dispose();
      pmremGenerator.dispose();
      pmremDisposed = true;
      isEnvMapLoaded = true;
    });

    const renderPass = new RenderPass(scene, camera);
    // Dialed back from the original strength 4.0 — keep glow tasteful while the
    // plasma sun still blooms.
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.55, 0.5, 0.2);
    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    const applySize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const dpr = renderer.getPixelRatio();
      (backdrop.material as THREE.RawShaderMaterial).uniforms.resolution.value.set(w * dpr, h * dpr);
      renderer.setSize(w, h, false); // updateStyle=false → CSS keeps the canvas full-bleed
      composer.setSize(w, h);
    };
    applySize();

    const ro = new ResizeObserver(() => applySize());
    ro.observe(container);

    // --- Animation state ---
    let prevTime = performance.now();
    const rotation = new THREE.Vector3(0, 0, 0);
    let smoothedMode = 0;
    let smoothedAmplitude = 0;
    let rafId = 0;

    const animate = () => {
      rafId = requestAnimationFrame(animate);

      // Skip work when the tab/window is hidden (two GL contexts run at once)
      // or if the context has been lost.
      if (typeof document !== 'undefined' && document.hidden) return;
      if (renderer.getContext().isContextLost()) return;

      const { input, output } = sourceRef.current;
      input.update();
      output.update();
      const inData = input.data;
      const outData = output.data;

      const t = performance.now();
      const dt = (t - prevTime) / (1000 / 60);
      prevTime = t;

      const backdropMaterial = backdrop.material as THREE.RawShaderMaterial;
      backdropMaterial.uniforms.rand.value = Math.random() * 10000;

      const m = modeRef.current;
      const isOrb = m === 'orb';
      const isCymatics = m === 'cymatics';
      const isLandscape = m === 'landscape-chrome' || m === 'landscape-ferrofluid';

      sphere.visible = isOrb && isEnvMapLoaded;
      plane.visible = isCymatics && isEnvMapLoaded;
      landscape.visible = isLandscape && isEnvMapLoaded;
      sun.visible = isLandscape;
      scene.fog = isLandscape ? landscapeFog : null;

      if (isOrb) {
        const shader = sphereMaterial.userData.shader;
        if (shader) {
          shader.uniforms.spikeDensity.value = spikeDensity;
          shader.uniforms.spikeAmplitude.value = spikeAmplitude;
          shader.uniforms.noiseViscosity.value = noiseViscosity;
          shader.uniforms.isFerrofluid.value = isFerrofluid;

          // Per-panel pole tilt so two orbs can be mirrored (+90 / -90).
          sphere.rotation.z = THREE.MathUtils.degToRad(orbTiltRef.current);

          let inBass = 0, inMids = 0, inHighs = 0;
          let outBass = 0, outMids = 0, outHighs = 0;
          for (let i = 0; i < 4; i++) {
            inBass += inData[i] || 0;
            outBass += outData[i] || 0;
          }
          for (let i = 4; i < 11; i++) {
            inMids += inData[i] || 0;
            outMids += outData[i] || 0;
          }
          for (let i = 11; i < 16; i++) {
            inHighs += inData[i] || 0;
            outHighs += outData[i] || 0;
          }
          inBass /= 1020; outBass /= 1020;
          inMids /= 1785; outMids /= 1785;
          inHighs /= 1275; outHighs /= 1275;
          const inAmp = (inBass + inMids + inHighs) / 3.0;
          const outAmp = (outBass + outMids + outHighs) / 3.0;

          const combinedBass = Math.max(inBass, outBass);
          const combinedMids = Math.max(inMids, outMids);

          sphere.scale.setScalar(1.0 + 0.04 * combinedBass);

          const f = 0.001;
          rotation.x += dt * f * 0.45;
          rotation.y += dt * f * 0.18 + combinedMids * 0.005;
          rotation.z += dt * f * 0.15;

          const euler = new THREE.Euler(rotation.x, rotation.y, rotation.z);
          const quaternion = new THREE.Quaternion().setFromEuler(euler);
          // Zoomed in a touch from the original 4.2.
          const vector = new THREE.Vector3(0, 0, 3.3);
          vector.applyQuaternion(quaternion);
          camera.position.copy(vector);
          camera.up.set(0, 1, 0);
          camera.lookAt(sphere.position);

          const speedScale = 0.015 * (1.0 + 0.6 * combinedBass);
          shader.uniforms.time.value += dt * speedScale;

          shader.uniforms.inputData.value.set(inBass, inMids, inHighs, inAmp);
          shader.uniforms.outputData.value.set(outBass, outMids, outHighs, outAmp);
        }
      } else if (isCymatics) {
        const shader = planeMaterial.userData.shader;
        if (shader) {
          const audioLevels = new Float32Array(16);
          let avgVolume = 0;
          let sumWeights = 0;
          let sumIndices = 0;
          for (let i = 0; i < 16; i++) {
            const val = Math.max(inData[i] || 0, outData[i] || 0) / 255;
            audioLevels[i] = val;
            avgVolume += val;
            const weight = i === 0 ? val * 0.15 : val * val;
            sumWeights += weight;
            sumIndices += weight * i;
          }
          avgVolume /= 16;

          const targetMode = sumWeights > 0.005 ? sumIndices / sumWeights : 0.0;
          const modeSmoothFactor = targetMode < smoothedMode ? 0.04 : 0.08;
          smoothedMode += (targetMode - smoothedMode) * modeSmoothFactor * dt;
          smoothedMode = Math.max(0, Math.min(15, smoothedMode));

          const ampSmoothFactor = avgVolume > smoothedAmplitude ? 0.28 : 0.07;
          smoothedAmplitude += (avgVolume - smoothedAmplitude) * ampSmoothFactor * dt;

          shader.uniforms.time.value += dt * 0.08;
          shader.uniforms.audioLevels.value.set(audioLevels);
          shader.uniforms.activeModeIndex.value = smoothedMode;
          shader.uniforms.smoothedAmplitude.value = smoothedAmplitude;
          shader.uniforms.cymaticAmplitude.value = 1.0;

          // Pull the camera in so the rippling liquid covers the whole panel
          // (cover, not contain): the larger viewport axis must stay inside the
          // active plate region (~1.45 of the 1.75 half so we never show the
          // damped flat rim).
          const d = 1.45 / (TAN_HALF_FOV * Math.max(1, camera.aspect));
          camera.position.set(0, 0, d);
          camera.up.set(0, 1, 0);
          camera.lookAt(0, 0, 0);
        }
      } else if (isLandscape) {
        const shader = landscapeMaterial.userData.shader;
        if (shader) {
          let inBass = 0, inMids = 0, inHighs = 0;
          let outBass = 0, outMids = 0, outHighs = 0;
          for (let i = 0; i < 4; i++) {
            inBass += inData[i] || 0;
            outBass += outData[i] || 0;
          }
          for (let i = 4; i < 11; i++) {
            inMids += inData[i] || 0;
            outMids += outData[i] || 0;
          }
          for (let i = 11; i < 16; i++) {
            inHighs += inData[i] || 0;
            outHighs += outData[i] || 0;
          }
          inBass /= 1020; outBass /= 1020;
          inMids /= 1785; outMids /= 1785;
          inHighs /= 1275; outHighs /= 1275;

          const b = Math.max(inBass, outBass);
          const mid = Math.max(inMids, outMids);
          const h = Math.max(inHighs, outHighs);

          shader.uniforms.audioData.value.set(b, mid, h, 0);

          const speedMultiplier = scrollSpeed * (1.0 + b * 1.5);
          shader.uniforms.time.value += dt * 0.012 * speedMultiplier;
          shader.uniforms.scrollSpeed.value = scrollSpeed;
          shader.uniforms.mountainHeight.value = landscapeHeight;

          const ferrofluidWeight = m === 'landscape-ferrofluid' ? isFerrofluid : 0.0;
          shader.uniforms.isFerrofluid.value = ferrofluidWeight;

          // Plasma fusor sun: counter-rotating cages + bass-driven pulse.
          sunCage1.rotation.y += dt * 0.004;
          sunCage1.rotation.x += dt * 0.0022;
          sunCage2.rotation.y -= dt * 0.006;
          sunCage2.rotation.z += dt * 0.003;
          const pulse = 1 + 0.06 * Math.sin(t * 0.003) + 0.3 * b;
          sunCore.scale.setScalar(pulse);
          sunCorona.scale.setScalar(pulse * 1.05 + 0.12 * mid);

          // Lock camera looking forward into the synthwave horizon down the valley.
          camera.position.set(0, 0.42, 2.3);
          camera.up.set(0, 1, 0);
          camera.lookAt(0, -0.28, -5.0);
        }
      }

      composer.render();
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      if (!pmremDisposed) pmremGenerator.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as THREE.Mesh).material;
        if (mat) {
          (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        }
      });
      envRenderTarget?.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
  }, []);

  return <div ref={containerRef} className={`block h-full w-full ${className ?? ''}`} />;
};

export const CymaticsVisualizer = memo(CymaticsVisualizerImpl);

/* ------------------------------------------------------------------ */
/* Panel wrapper: full-bleed visualizer + 4 stacked mode icons (no heading) */

const MODES: { key: CymaticsMode; label: string; Icon: typeof Circle }[] = [
  { key: 'orb', label: 'Ferrofluid orb', Icon: Circle },
  { key: 'cymatics', label: 'Cymatic platform', Icon: Grid3x3 },
  { key: 'landscape-chrome', label: 'Liquid chrome valley', Icon: Mountain },
  { key: 'landscape-ferrofluid', label: 'Ferrofluid valley', Icon: Droplet },
];

interface VisualizerPanelProps {
  audioNode?: AudioNode | null;
  initialMode?: CymaticsMode;
  /** Orb pole tilt in degrees (use +90 / -90 on the two panels to mirror). */
  orbTilt?: number;
  className?: string;
}

const VisualizerPanelImpl: React.FC<VisualizerPanelProps> = ({ audioNode, initialMode = 'orb', orbTilt = 0, className }) => {
  const [vizMode, setVizMode] = useState<CymaticsMode>(initialMode);
  return (
    <div className={`relative overflow-hidden rounded-lg bg-black ${className ?? ''}`}>
      <CymaticsVisualizer mode={vizMode} audioNode={audioNode} orbTilt={orbTilt} className="absolute inset-0" />
      <div className="absolute right-1.5 bottom-1.5 z-10 flex flex-col gap-1">
        {MODES.map(({ key, label, Icon }) => {
          const on = vizMode === key;
          return (
            <button
              key={key}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={on}
              onClick={() => setVizMode(key)}
              className={`grid h-6 w-6 place-items-center rounded-md border backdrop-blur-sm transition-colors ${
                on
                  ? 'border-purple-400/60 bg-purple-600/40 text-white shadow-[0_0_8px_rgba(168,85,247,0.6)]'
                  : 'border-white/10 bg-black/40 text-zinc-400 hover:bg-black/60 hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const VisualizerPanel = memo(VisualizerPanelImpl);
