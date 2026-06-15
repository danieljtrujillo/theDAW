import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Boot cinematic, per the locked spec:
 *   - mildly shiny dark purple steel background
 *   - the theDAW.gltf model in liquid chrome (the cymatics chrome material), it
 *     assembles from scattered vertices into the solid object
 *   - "by GANTASMO" directly beneath it, drawn as the electric-wave visualizer's
 *     actual electricity: glowing crackling filament arcs (NOT dust particles)
 *     that converge into the letterforms, in the visualizer's colour palette.
 * Both form over ~7 seconds once the assets are loaded, then hold. No text says
 * "loading". Reports inactive if WebGL won't start. Reports complete once the
 * formation has fully resolved so the host holds for the real runtime.
 */

interface LiquidChromeTitleProps {
  onActive?: (active: boolean) => void;
  onComplete?: () => void;
}

const FORM_SECONDS = 7;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// "by GANTASMO" world strip geometry. The strip is sampled centred on y = 0 and
// placed at runtime just below the (measured) bottom of the theDAW model so the
// two lines sit almost touching.
const GANTASMO_TEX_W = 1024;
const GANTASMO_TEX_H = 200;
const GANTASMO_WORLD_W = 3.0;
const GANTASMO_WORLD_H = (GANTASMO_TEX_H / GANTASMO_TEX_W) * GANTASMO_WORLD_W;
const GANTASMO_GAP = 0.08; // gap between theDAW's bottom and the GANTASMO line

// The gltf node transform bakes a +45deg Y turn into the logo (verified from the
// matrix columns), which makes it lie back at an angle. Counter it so the logo
// faces the camera.
const DAW_BASE_ROT_Y = -Math.PI / 4;

/**
 * Sample "by GANTASMO" into glowing filament SEGMENTS (the electric-wave look):
 * adjacent lit pixels along each scan row become a line segment, so the letters
 * are drawn as horizontal electric filaments rather than dots. Returns the
 * target (solid) endpoints, a scattered start endpoint per vertex, and a seed.
 */
function sampleByGantasmoFilaments(): {
  target: Float32Array;
  start: Float32Array;
  seed: Float32Array;
} {
  const W = GANTASMO_TEX_W;
  const H = GANTASMO_TEX_H;
  const empty = { target: new Float32Array(0), start: new Float32Array(0), seed: new Float32Array(0) };
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) return empty;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 110px "Orbitron", system-ui, sans-serif';
  ctx.fillText('by GANTASMO', W / 2, H / 2 + 4);
  const data = ctx.getImageData(0, 0, W, H).data;

  const worldW = GANTASMO_WORLD_W;
  const worldH = GANTASMO_WORLD_H;
  const step = 3;
  const target: number[] = [];
  const start: number[] = [];
  const seed: number[] = [];

  const toWorldX = (x: number) => (x / W - 0.5) * worldW;
  const toWorldY = (y: number) => -((y / H - 0.5) * worldH); // y up, centred at 0
  const pushStart = (wy: number) => {
    const ang = Math.random() * Math.PI * 2;
    const rad = 3 + Math.random() * 5;
    start.push(Math.cos(ang) * rad, wy + Math.sin(ang) * rad * 0.5, (Math.random() - 0.5) * 4);
  };

  for (let y = 0; y < H; y += step) {
    let prevX = -999;
    let prevWX = 0;
    let prevWY = 0;
    for (let x = 0; x < W; x += step) {
      const lit = data[(y * W + x) * 4 + 3] > 140;
      if (lit) {
        const wx = toWorldX(x);
        const wy = toWorldY(y);
        if (prevX >= 0 && x - prevX <= step * 1.5) {
          // segment prev -> current
          target.push(prevWX, prevWY, (Math.random() - 0.5) * 0.05, wx, wy, (Math.random() - 0.5) * 0.05);
          pushStart(prevWY);
          pushStart(wy);
          const s = Math.random() * 6.2832;
          seed.push(s, s);
        }
        prevX = x;
        prevWX = wx;
        prevWY = wy;
      } else {
        prevX = -999;
      }
    }
  }
  return {
    target: new Float32Array(target),
    start: new Float32Array(start),
    seed: new Float32Array(seed),
  };
}

export const LiquidChromeTitle: React.FC<LiquidChromeTitleProps> = ({ onActive, onComplete }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Keep a transient WebGL context loss from permanently bricking the boot
    // screen: preventDefault marks the context as restorable.
    const onContextLost = (e: Event) => e.preventDefault();
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      onActive?.(true);
    } catch {
      onActive?.(false);
      return;
    }
    let w = canvas.clientWidth || window.innerWidth;
    let h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(w, h, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    camera.position.set(0, -0.15, 4.2);

    // Background: mildly shiny dark purple steel. A large plane that catches the
    // env reflection just enough to read as brushed dark-purple metal.
    const bgMat = new THREE.MeshStandardMaterial({
      color: 0x1c1338,
      metalness: 0.7,
      roughness: 0.42,
      envMapIntensity: 0.5,
    });
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(60, 36), bgMat);
    backdrop.position.set(0, 0, -7);
    scene.add(backdrop);

    // Cymatics chrome light rig.
    const key = new THREE.DirectionalLight(0xfff5ea, 1.4);
    key.position.set(6, 9, 5);
    const rim = new THREE.DirectionalLight(0xb14dff, 0.9);
    rim.position.set(-6, -3, -4);
    const fill = new THREE.DirectionalLight(0x00d2ff, 0.4);
    fill.position.set(0, -6, 5);
    scene.add(key, rim, fill, new THREE.AmbientLight(0x0c0714, 0.15));

    // The cymatics chrome material, no different, plus a formation vertex shader
    // (uForm 0 = vertices flung out along random dirs, 1 = solid).
    let dawShader: THREE.WebGLProgramParametersWithUniforms | null = null;
    const chrome = new THREE.MeshStandardMaterial({
      color: 0x010101,
      metalness: 0.99,
      roughness: 0.008,
      emissive: 0x000000,
    });
    chrome.onBeforeCompile = (shader) => {
      shader.uniforms.uForm = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uForm;
           float h11(float n){ return fract(sin(n)*43758.5453); }`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float seed = dot(position, vec3(12.9898, 78.233, 37.719));
           vec3 dir = normalize(vec3(h11(seed)-0.5, h11(seed+1.7)-0.5, h11(seed+3.1)-0.5));
           float spread = 1.0 - uForm;
           vec3 scattered = position + dir * spread * 5.0 + normal * spread * 1.1;
           scattered += normal * sin(uForm * 6.2832 + h11(seed) * 6.2832) * spread * 0.35;
           transformed = mix(scattered, position, smoothstep(0.0, 1.0, uForm));`,
        );
      dawShader = shader;
    };

    const dawGroup = new THREE.Group();
    // Constant Y that centres the (theDAW + GANTASMO) pair around the camera's
    // look target (-0.1); the model-height term cancels out so this does not
    // depend on the model's proportions.
    dawGroup.position.y = -0.1 + (GANTASMO_GAP + GANTASMO_WORLD_H) / 2;
    dawGroup.position.z = -0.6; // a little further from camera: flatter, less lit-from-below
    dawGroup.rotation.y = DAW_BASE_ROT_Y; // face the camera
    dawGroup.visible = false;
    scene.add(dawGroup);

    // "by GANTASMO" electricity: glowing crackling filament arcs (the electric-
    // wave visualizer's look + palette) that converge into the letterforms.
    let gantasmoOriginY = -1.4; // updated once the model is measured
    let filamentsReady = false;
    const eGeo = new THREE.BufferGeometry();
    const eMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uForm: { value: 0 }, uOriginY: { value: gantasmoOriginY } },
      vertexShader: `
        uniform float uTime;
        uniform float uForm;
        uniform float uOriginY;
        attribute vec3 aStart;
        attribute float aSeed;
        varying float vMix;
        varying float vX;
        float rnd(vec2 st){ return fract(sin(dot(st.xy, vec2(12.9898,78.233)))*43758.5453123); }
        float noise(vec2 st){
          vec2 i=floor(st); vec2 f=fract(st);
          float a=rnd(i); float b=rnd(i+vec2(1.0,0.0));
          float c=rnd(i+vec2(0.0,1.0)); float d=rnd(i+vec2(1.0,1.0));
          vec2 u=f*f*(3.0-2.0*f);
          return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;
        }
        void main(){
          float m = smoothstep(0.0, 1.0, uForm);
          vec3 base = mix(aStart, position, m);
          // electric crackle: violent while forming, gentle idle wave once solid
          float crackle = (1.0 - uForm) * 0.7 + 0.05;
          float e1 = (noise(vec2(position.x*15.0, uTime*3.0 + aSeed)) - 0.5) * 2.0;
          float e2 = (noise(vec2(position.x*30.0, uTime*6.0 + aSeed)) - 0.5) * 1.0;
          float idle = sin(position.x*5.0 + uTime*0.8 + aSeed) * 0.15;
          base.y += (idle + e1 + e2) * 0.06 * (0.5 + crackle*2.5);
          base.x += sin(uTime*14.0 + aSeed) * 0.03 * crackle;
          base.y += uOriginY;
          vMix = uForm;
          vX = position.x;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(base, 1.0);
        }
      `,
      fragmentShader: `
        varying float vMix;
        varying float vX;
        void main(){
          // electric-wave visualizer palette: cyan / pink / purple / green
          vec3 c0 = vec3(0.0, 0.82, 1.0);
          vec3 c1 = vec3(1.0, 0.0, 0.5);
          vec3 c2 = vec3(0.44, 0.0, 1.0);
          vec3 c3 = vec3(0.0, 1.0, 0.53);
          float f = fract(vX * 0.55 + 0.5);
          vec3 col = mix(c0, c1, smoothstep(0.0, 0.33, f));
          col = mix(col, c2, smoothstep(0.33, 0.66, f));
          col = mix(col, c3, smoothstep(0.66, 1.0, f));
          // dimmer than the first pass so the lightning is not blown out by bloom
          float a = 0.12 + 0.32 * vMix;
          gl_FragColor = vec4(col * 0.7, a);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const electricity = new THREE.LineSegments(eGeo, eMat);
    electricity.visible = false;
    electricity.frustumCulled = false; // geometry is populated asynchronously
    scene.add(electricity);

    // Build the wordmark only once Orbitron has actually loaded, so the canvas
    // samples the techno face instead of a system fallback. Runs as a microtask/
    // promise, after the effect body, so `disposed` is already initialised.
    const buildFilaments = () => {
      if (disposed) return;
      const f = sampleByGantasmoFilaments();
      eGeo.setAttribute('position', new THREE.BufferAttribute(f.target, 3));
      eGeo.setAttribute('aStart', new THREE.BufferAttribute(f.start, 3));
      eGeo.setAttribute('aSeed', new THREE.BufferAttribute(f.seed, 1));
      filamentsReady = true;
    };
    if (typeof document !== 'undefined' && document.fonts?.load) {
      document.fonts.load('700 110px "Orbitron"').then(buildFilaments).catch(buildFilaments);
    } else {
      Promise.resolve().then(buildFilaments);
    }

    // Env reflections (cymatics EXR).
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    let envRT: THREE.WebGLRenderTarget | null = null;
    let disposed = false;
    let envReady = false;
    let modelReady = false;
    new EXRLoader().load('/piz_compressed.exr', (tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.mapping = THREE.EquirectangularReflectionMapping;
      envRT = pmrem.fromEquirectangular(tex);
      chrome.envMap = envRT.texture;
      bgMat.envMap = envRT.texture;
      scene.environment = envRT.texture;
      tex.dispose();
      pmrem.dispose();
      envReady = true;
    });

    new GLTFLoader().load('/theDAW.gltf', (gltf) => {
      if (disposed) return;
      // Smooth the faceted normals: weld duplicate verts (-> indexed) then average
      // shared face normals, so the chrome reads as liquid metal, not low-poly.
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) {
          const welded = mergeVertices(m.geometry);
          welded.computeVertexNormals();
          m.geometry = welded;
          m.material = chrome;
        }
      });
      // Centre the content at the group origin (so the counter-rotation turns it
      // in place), then measure it FRONT-FACING (after the -45deg counter-rotation)
      // for the scale and the GANTASMO placement.
      const cbox = new THREE.Box3().setFromObject(gltf.scene);
      const center = new THREE.Vector3();
      cbox.getCenter(center);
      gltf.scene.position.sub(center);
      dawGroup.add(gltf.scene);
      dawGroup.updateMatrixWorld(true);
      const fbox = new THREE.Box3().setFromObject(dawGroup);
      const size = new THREE.Vector3();
      fbox.getSize(size);
      const scale = 3.3 / Math.max(size.x, 0.001); // bigger than the 2.4 pass
      dawGroup.scale.setScalar(scale);
      // Place "by GANTASMO" just below the model's measured bottom so the two
      // lines sit almost touching.
      const modelBottom = dawGroup.position.y - (size.y * scale) / 2;
      gantasmoOriginY = modelBottom - GANTASMO_GAP - GANTASMO_WORLD_H / 2;
      modelReady = true;
    });

    // Post: bloom gives the chrome its hot highlights and the electricity its glow.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.15, 0.8, 0.18);
    composer.addPass(bloom);

    const clock = new THREE.Clock();
    let raf = 0;
    let startedAt = -1; // formation clock starts once assets are ready
    let completed = false;

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      eMat.uniforms.uTime.value = t;
      eMat.uniforms.uOriginY.value = gantasmoOriginY;

      // Hold on the dark-purple-steel background until the assets are loaded
      // (the "visibly loaded" state), then run the ~7s formation.
      const ready = envReady && modelReady;
      if (ready && startedAt < 0) startedAt = t;
      const form = startedAt < 0 ? 0 : clamp01((t - startedAt) / FORM_SECONDS);

      // theDAW assembles over the first ~80% of the window.
      const dawForm = easeOutCubic(clamp01(form / 0.8));
      dawGroup.visible = dawGroup.children.length > 0;
      if (dawShader) dawShader.uniforms.uForm.value = dawForm;
      dawGroup.rotation.y = DAW_BASE_ROT_Y + Math.sin(t * 0.28) * 0.05;

      // "by GANTASMO" electricity streams in over the last ~70% (starts at 30%).
      const eForm = easeOutCubic(clamp01((form - 0.3) / 0.7));
      electricity.visible = filamentsReady && eForm > 0.001;
      eMat.uniforms.uForm.value = eForm;

      // Report completion once both halves have fully resolved, so the host can
      // hold for the real runtime instead of a blind timer.
      if (!completed && startedAt >= 0 && form >= 1) {
        completed = true;
        onComplete?.();
      }

      camera.position.x = Math.sin(t * 0.18) * 0.14;
      camera.lookAt(0, -0.1, 0);
      composer.render();
    };
    raf = requestAnimationFrame(animate);

    const onResize = () => {
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      envRT?.dispose();
      chrome.dispose();
      bgMat.dispose();
      eMat.dispose();
      eGeo.dispose();
      composer.dispose();
      renderer.dispose();
      // NOTE: do NOT forceContextLoss() here. Under React StrictMode (dev) the
      // effect runs mount -> unmount -> mount; force-losing the context on the
      // first unmount leaves the shared canvas with a dead context that the
      // remount reuses, so nothing paints (white screen / CONTEXT_LOST_WEBGL).
      // dispose() frees the three resources; the canvas context stays alive.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />;
};
