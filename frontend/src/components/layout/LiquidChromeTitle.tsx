import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Boot cinematic — the theDAW model only.
 *   - the theDAW.glb model in liquid chrome (the cymatics chrome material),
 *     assembling from scattered vertices into the solid object over ~7s
 *   - rendered on a TRANSPARENT canvas so the one shared dark background shows
 *     through (no separate metallic backdrop, no different scene)
 *   - the "by" line + the GANTASMO logo live in the DOM around this canvas (see
 *     LoadingScreen) so the three credit elements keep an exact size proportion.
 * Reports inactive if WebGL won't start; reports complete once the model has
 * fully resolved so the host holds for the real runtime.
 */

interface LiquidChromeTitleProps {
  onActive?: (active: boolean) => void;
  onComplete?: () => void;
  /**
   * Fires once the wordmark has essentially resolved out of the goo. The host
   * uses it to reveal "by" and then the GANTASMO logo AFTER theDAW, rather than
   * on blind timers that used to run while the model was still assembling.
   */
  onFormed?: () => void;
  /** Canvas class. The boot screen passes a full-bleed one so the goo covers
   *  the entire window rather than just the wordmark's layout box. */
  className?: string;
}

const FORM_SECONDS = 5.2;
// The wordmark is legible well before the easing fully settles; reveal the
// credits at this point rather than waiting for the last few percent.
const FORMED_AT = 0.82;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// The gltf node transform bakes a +45deg Y turn into the logo (verified from the
// matrix columns), which makes it lie back at an angle. Counter it so the logo
// faces the camera.
const DAW_BASE_ROT_Y = -Math.PI / 4;

// World depth of the goo sheet. The wordmark sits in front of it at z -0.6 and
// dissolves back INTO it, so this is also the depth the formation sinks to.
const GOO_Z = -3.2;

export const LiquidChromeTitle: React.FC<LiquidChromeTitleProps> = ({ onActive, onComplete, onFormed, className }) => {
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
    renderer.setClearColor(0x000000, 0); // transparent — the DOM background shows through
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // The near-perfect mirror is the POINT — the wordmark and the goo are the
    // same wet-obsidian material and you read them purely by what the lights and
    // the environment reflect off their surfaces. Exposure is the only lever
    // pulled here; albedo/emissive stay black so nothing goes matte or tinted.
    renderer.toneMappingExposure = 2.1;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    camera.position.set(0, 0, 4.2);

    // The assistant orb's colours (FerroOrbCore) but re-AIMED, because on a
    // near-mirror the angle is the whole image: a surface only shows a light
    // whose reflection vector happens to reach the camera. The orb is a sphere,
    // so some part of it always satisfies that from any angle; the wordmark is
    // a mostly camera-facing slab, so lights parked high above it (6,9,5) only
    // ever lit the top bevels and the readable front stayed black. Both keys now
    // live in the FORWARD hemisphere (+z, camera side) at a raking height, and
    // they orbit through it each frame so the highlight travels across the
    // letterforms instead of sitting still. The goo sheet shares the material,
    // so its wave normals catch these same lights at different angles — that
    // difference is what separates the logo from the background.
    const key = new THREE.DirectionalLight(0xfff5ea, 2.6);
    key.position.set(5, 3.5, 7);
    const key2 = new THREE.DirectionalLight(0xfff5ea, 2.2);
    key2.position.set(-5, 3.5, 7);
    const rim = new THREE.DirectionalLight(0xb14dff, 1.2);
    rim.position.set(-6, -3, -4);
    const fill = new THREE.DirectionalLight(0x00d2ff, 0.4);
    fill.position.set(0, -6, 5);
    // Two close point lights sit just in front of the sheet, off the sides of
    // frame. On a glossy surface these are what you actually SEE moving in the
    // liquid — the directional keys are for the wordmark's bevels.
    const gooA = new THREE.PointLight(0xfff2e2, 260, 40, 2);
    gooA.position.set(-7, 3.5, -0.6);
    const gooB = new THREE.PointLight(0xb14dff, 200, 40, 2);
    gooB.position.set(7, -2.5, -0.6);
    scene.add(key, key2, rim, fill, gooA, gooB, new THREE.AmbientLight(0x0c0714, 0.15));

    // The cymatics chrome material plus a formation vertex shader
    // (uForm 0 = vertices flung out along random dirs, 1 = solid).
    let dawShader: THREE.WebGLProgramParametersWithUniforms | null = null;
    // EXACTLY the assistant orb's wet-obsidian material (FerroOrbCore's
    // sphereMaterial). Black albedo, no emissive, near-mirror: everything you
    // see is reflection. envMapIntensity is the one lift, so the EXR carries
    // enough light for the letterforms to separate from the sheet behind them.
    const CHROME = {
      color: 0x010101,
      metalness: 0.99,
      roughness: 0.003,
      emissive: 0x000000,
      envMapIntensity: 4.5,
    } as const;
    const chrome = new THREE.MeshStandardMaterial({ ...CHROME });
    // uForm 0 = the wordmark is still dissolved INTO the goo sheet behind it
    // (pushed back to the sheet's depth, spread across it, riding the same
    // standing wave); 1 = fully resolved solid logo. So the logo is not
    // assembled from random debris any more — it rises out of the same black
    // liquid it is made of.
    chrome.onBeforeCompile = (shader) => {
      shader.uniforms.uForm = { value: 0 };
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uSink = { value: 2.6 };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uForm;
           uniform float uTime;
           uniform float uSink;
           float h11(float n){ return fract(sin(n)*43758.5453); }`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float seed = dot(position, vec3(12.9898, 78.233, 37.719));
           float spread = 1.0 - uForm;
           // Fan out across the sheet and sink back into it. uSink is the local
           // -Z distance that lands the vertices exactly ON the goo plane once
           // the group's scale is applied, so the wordmark genuinely surfaces
           // out of the sheet rather than out of empty space in front of it.
           vec2 lat = vec2(h11(seed) - 0.5, h11(seed + 3.1) - 0.5) * 2.0;
           vec3 sunk = position;
           sunk.xy += lat * spread * 1.25;
           sunk.z -= spread * uSink;
           // The same Chladni-style standing wave that drives the sheet, so the
           // dissolved vertices vibrate WITH the goo instead of floating free.
           float cym = sin(sunk.x * 3.1 + uTime * 1.8) * cos(sunk.y * 3.1 - uTime * 1.5);
           sunk.z += cym * spread * 0.5;
           sunk += normal * cym * spread * 0.18;
           transformed = mix(sunk, position, smoothstep(0.0, 1.0, uForm));`,
        );
      dawShader = shader;
    };

    // ── the black goo the wordmark is made of, and emerges from ──────────────
    // A dense sheet behind the logo running Chladni-style standing waves: two
    // crossed sine fields (the classic cymatic figure) plus a slow swell, so it
    // reads as a vibrating liquid rather than a scrolling noise plane. It uses
    // the same near-black metal response as the logo so the two are visibly the
    // same substance. The pointer pushes a travelling ripple into it.
    const gooUniforms = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },   // sheet-space world units
      uMouseStrength: { value: 0 },                  // eases in on first move
      uForm: { value: 0 },                           // calms as the logo resolves
      // The sheet is a UNIT plane scaled by the model matrix, so position.xy in
      // the shader only spans -0.5..0.5. Multiplying by this restores real world
      // units, which keeps the wave frequency constant instead of stretching
      // with the window.
      uSheetSize: { value: new THREE.Vector2(1, 1) },
    };
    // Oversized on purpose: the sheet must fill the whole window at any aspect
    // ratio, and it is resized again in onResize from the camera frustum so a
    // wide monitor never sees its edges.
    const gooGeo = new THREE.PlaneGeometry(1, 1, 360, 240);
    // The SAME material as the wordmark — same black albedo, same near-mirror.
    // They are one substance; the only thing separating them on screen is the
    // angle each surface reflects the lights back at the camera.
    const gooMat = new THREE.MeshStandardMaterial({ ...CHROME, roughness: 0.075, envMapIntensity: 1.15 });
    gooMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, gooUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uTime;
           uniform vec2  uMouse;
           uniform float uMouseStrength;
           uniform float uForm;
           uniform vec2  uSheetSize;
           // Crossed standing waves — a Chladni plate figure. Nodes stay put and
           // the antinodes pump, which is what makes it read as cymatic.
           float chladni(vec2 p, float t){
             float a = sin(p.x * 1.55 + t * 0.85) * cos(p.y * 1.55 - t * 0.70);
             float b = sin(p.x * 3.10 - t * 0.55) * cos(p.y * 2.85 + t * 0.45);
             float c = sin(length(p) * 2.20 - t * 1.15) + sin(p.x * 6.5 + t * 1.9) * cos(p.y * 5.8 - t * 1.4) * 0.35;
             return a * 0.58 + b * 0.26 + c * 0.16;
           }`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vec2 sp = position.xy * uSheetSize;
           // Settle the sheet as the wordmark finishes resolving, so the boot
           // ends calm instead of thrashing under the finished logo.
           float calm = mix(1.0, 0.42, smoothstep(0.0, 1.0, uForm));
           float h = chladni(sp, uTime) * 1.75 * calm;
           // Pointer ripple: a decaying ring travelling out from the cursor.
           float d = distance(sp, uMouse);
           h += sin(d * 3.4 - uTime * 4.5) * exp(-d * 0.75) * 0.55 * uMouseStrength;
           transformed.z += h;`,
        )
        // Re-derive normals from the displaced surface, otherwise the sheet
        // displaces but lights as if it were still flat (no visible ripple).
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           {
             vec2 sp0 = position.xy * uSheetSize;
             float e = 0.06;
             float calmN = mix(1.0, 0.42, smoothstep(0.0, 1.0, uForm));
             float hC = chladni(sp0, uTime) * 1.75 * calmN;
             float hX = chladni(sp0 + vec2(e, 0.0), uTime) * 1.75 * calmN;
             float hY = chladni(sp0 + vec2(0.0, e), uTime) * 1.75 * calmN;
             float dC = distance(sp0, uMouse);
             float rC = sin(dC * 3.4 - uTime * 4.5) * exp(-dC * 0.75) * 0.55 * uMouseStrength;
             hC += rC; hX += rC; hY += rC;
             objectNormal = normalize(vec3(-(hX - hC) / e, -(hY - hC) / e, 1.0));
           }`,
        );
    };
    const goo = new THREE.Mesh(gooGeo, gooMat);
    goo.position.set(0, 0, GOO_Z);
    scene.add(goo);

    // Scale the unit plane to exactly cover the camera frustum at the sheet's
    // depth, so it fills the window edge to edge at any aspect ratio. The 1.5
    // margin absorbs the camera's lookAt tilt and its slow x drift.
    const fitGoo = () => {
      const dist = camera.position.z - GOO_Z;
      const height = 2 * Math.tan((camera.fov * Math.PI) / 360) * dist;
      goo.scale.set(height * camera.aspect * 1.5, height * 1.5, 1);
      gooUniforms.uSheetSize.value.set(goo.scale.x, goo.scale.y);
    };

    // Pointer -> sheet space. Tracked on the window so it works no matter which
    // DOM layer of the boot screen is under the cursor.
    let mouseEased = new THREE.Vector2(0, 0);
    let mouseTarget = new THREE.Vector2(0, 0);
    let mouseSeen = false;
    const onPointerMove = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -((e.clientY / window.innerHeight) * 2 - 1);
      // Map the pointer onto the sheet's real extent so the ripple lands under
      // the cursor at any window size, rather than at a fixed guessed scale.
      mouseTarget.set(nx * goo.scale.x * 0.5, ny * goo.scale.y * 0.5);
      mouseSeen = true;
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    const dawGroup = new THREE.Group();
    dawGroup.position.y = 1.05; // sits in the upper half; credits go beneath it
    dawGroup.position.z = -0.6; // a little further from camera: flatter, less lit-from-below
    dawGroup.rotation.y = DAW_BASE_ROT_Y; // face the camera
    dawGroup.visible = false;
    scene.add(dawGroup);

    // Env reflections. The chrome is a near-perfect mirror, so without an env map
    // it renders black (invisible). A synchronous RoomEnvironment is installed
    // immediately so the model is reflective the instant it loads — the formation
    // then starts on the model alone and no longer waits on the EXR download. The
    // EXR upgrades the reflections when it arrives.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    let envRT: THREE.WebGLRenderTarget | null = null;
    // Kept for the LIFETIME of the scene, not disposed when the EXR lands. A
    // black mirror in a black environment is black — the wordmark gets away with
    // it because its bevels catch the key lights edge-on, but the goo sheet is
    // broad and camera-facing, so with only the (very dark) EXR to reflect it
    // rendered as nothing at all. RoomEnvironment is a bright studio box, which
    // gives the liquid something to actually show across its whole surface.
    let roomEnvRT: THREE.WebGLRenderTarget | null = null;
    let disposed = false;
    let modelReady = false;
    // Local-space sink distance for the formation shader; corrected once the
    // model loads and its group scale is known.
    let sinkLocal = 2.6;
    try {
      const roomRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      chrome.envMap = roomRT.texture;
      gooMat.envMap = roomRT.texture;   // the sheet keeps this one permanently
      scene.environment = roomRT.texture;
      roomEnvRT = roomRT;
    } catch {
      /* fallback environment is best-effort */
    }
    new EXRLoader().load('/piz_compressed.exr', (tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.mapping = THREE.EquirectangularReflectionMapping;
      const exrRT = pmrem.fromEquirectangular(tex);
      // Only the WORDMARK upgrades to the EXR. The goo stays on the bright room
      // env — swapping it to the dark EXR is exactly what made the sheet vanish.
      chrome.envMap = exrRT.texture;
      scene.environment = exrRT.texture;
      tex.dispose();
      envRT?.dispose();
      envRT = exrRT;
    });

    new GLTFLoader().load('/theDAW.glb', (gltf) => {
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
      // for the scale.
      const cbox = new THREE.Box3().setFromObject(gltf.scene);
      const center = new THREE.Vector3();
      cbox.getCenter(center);
      gltf.scene.position.sub(center);
      dawGroup.add(gltf.scene);
      dawGroup.updateMatrixWorld(true);
      const fbox = new THREE.Box3().setFromObject(dawGroup);
      const size = new THREE.Vector3();
      fbox.getSize(size);
      // 2x size: the theDAW logo is doubled vs the prior fill (was 4.0). The
      // "by GANTASMO" text/image live outside this canvas (LoadingScreen DOM
      // siblings), so enlarging the model here does not move them.
      // Sized for a FULL-WINDOW canvas now. It used to render into a 1920x540 box
      // (aspect ~3.6), where 8.0 fit horizontally; at full-screen 16:9 the frame
      // is half as wide in world units, so the same number ran off both edges.
      const scale = 4.2 / Math.max(size.x, 0.001);
      dawGroup.scale.setScalar(scale);
      // Local-space distance that puts the dissolved vertices exactly on the goo
      // plane: the group sits at z -0.6 and the sheet at GOO_Z, and the group's
      // scale multiplies every local offset, so divide the world gap by it.
      sinkLocal = Math.abs(GOO_Z - dawGroup.position.z) / scale;
      modelReady = true;
    });

    // Post: bloom gives the chrome its hot highlights.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.85, 0.55, 0.62);
    composer.addPass(bloom);

    const clockStart = performance.now(); // elapsed seconds, no deprecated THREE.Clock
    let raf = 0;
    let startedAt = -1; // formation clock starts once the model is ready
    let completed = false;
    let formedFired = false;

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const t = (performance.now() - clockStart) / 1000;

      // Start the ~7s formation as soon as the model is ready (the env map is
      // already present via the room fallback), instead of waiting on the EXR.
      if (modelReady && startedAt < 0) startedAt = t;
      const form = startedAt < 0 ? 0 : clamp01((t - startedAt) / FORM_SECONDS);

      const dawForm = easeOutCubic(form);
      dawGroup.visible = dawGroup.children.length > 0;
      if (dawShader) {
        dawShader.uniforms.uForm.value = dawForm;
        dawShader.uniforms.uTime.value = t;
        dawShader.uniforms.uSink.value = sinkLocal;
      }
      dawGroup.rotation.y = DAW_BASE_ROT_Y + Math.sin(t * 0.28) * 0.05;

      // Drive the goo sheet. The pointer is eased rather than tracked exactly so
      // the ripple trails the cursor like liquid instead of snapping to it.
      mouseEased.lerp(mouseTarget, 0.06);
      gooUniforms.uTime.value = t;
      gooUniforms.uMouse.value.copy(mouseEased);
      gooUniforms.uForm.value = dawForm;
      gooUniforms.uMouseStrength.value +=
        ((mouseSeen ? 1 : 0) - gooUniforms.uMouseStrength.value) * 0.03;

      // Reveal the credits only once the wordmark itself has resolved, so the
      // order on screen is theDAW -> by -> GANTASMO.
      if (!formedFired && startedAt >= 0 && form >= FORMED_AT) {
        formedFired = true;
        onFormed?.();
      }

      // Report completion once the model has fully resolved, so the host can hold
      // for the real runtime instead of a blind timer.
      if (!completed && startedAt >= 0 && form >= 1) {
        completed = true;
        onComplete?.();
      }

      // Orbit the key lights and sweep the environment reflections so the chrome
      // stays lit + legible the WHOLE time (it was going dark / near-invisible by
      // the end with a static rig). environmentRotation is guarded for older three.
      // Sweep the keys through the FORWARD hemisphere only (z stays positive, in
      // front of the model). A full 360 orbit spent half its time behind the
      // slab, where a mirror shows the camera nothing — which is what made the
      // wordmark pulse in and out of visibility.
      const orbit = t * 0.45;
      key.position.set(Math.cos(orbit) * 7, 2.5 + Math.sin(orbit * 0.7) * 2.5, Math.abs(Math.sin(orbit)) * 3 + 5.5);
      key2.position.set(Math.cos(orbit + Math.PI) * 7, 2.5 + Math.cos(orbit * 0.6) * 2.5, Math.abs(Math.cos(orbit)) * 3 + 5.5);
      gooA.position.set(Math.cos(t * 0.23) * 8, Math.sin(t * 0.19) * 4.5, -0.4);
      gooB.position.set(Math.cos(t * 0.17 + 2.2) * 8, Math.sin(t * 0.27 + 1.1) * 4.5, -0.4);
      const envRot = (scene as unknown as { environmentRotation?: THREE.Euler }).environmentRotation;
      if (envRot) envRot.y = orbit * 0.6;

      camera.position.x = Math.sin(t * 0.18) * 0.14;
      // Look slightly up so the model sits LOW in its canvas box (its bottom near
      // the box bottom), keeping "by" tight beneath it.
      camera.lookAt(0, 0.55, 0);
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
      fitGoo();   // re-cover the window at the new aspect
    };
    fitGoo();
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      window.removeEventListener('pointermove', onPointerMove);
      envRT?.dispose();
      roomEnvRT?.dispose();
      pmrem.dispose();
      gooGeo.dispose();
      gooMat.dispose();
      chrome.dispose();
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

  return <canvas ref={canvasRef} className={className ?? 'block w-full h-full'} />;
};
