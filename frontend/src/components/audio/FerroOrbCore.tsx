/**
 * FerroOrbCore — the assistant orb's ferrofluid body.
 *
 * A minimal Three.js scene that reuses the EXACT orb recipe from
 * CymaticsVisualizer's 'orb' mode: the same sphere-shader Rosensweig
 * displacement, the same wet-obsidian PBR material, the same EXR environment
 * reflections, the same lighting rig, and the same bloom chain — at orb-core
 * size, so the assistant orb and the MAKE Visualize panels read as the same
 * material. Audio-reactivity taps the shared player master gain
 * non-destructively (HybridSource), easing to gentle synthetic idle motion
 * when nothing is audible, exactly like the panels.
 *
 * Lazy-loaded (three.js must stay out of the first-paint bundle) and mounted
 * into GantasmoOrb via its coreOverlay prop, beneath the face SVG.
 */
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { vs as sphereVS } from './cymatics/sphere-shader';
import { HybridSource, IdleSource, type FreqSource } from './cymatics/hybrid-source';
import { getMasterGain } from '../../state/playerStore';
import { effectiveZoom } from '../../lib/canvasScale';

const EXR_URL = '/piz_compressed.exr';
const FOV = 65;

const FerroOrbCore: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      // WebGL unavailable / context exhausted — the CSS gradient core beneath
      // this overlay stays visible, so the orb still renders.
      return;
    }
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
    container.appendChild(canvas);

    // Same tunables as CymaticsVisualizer's orb.
    const spikeDensity = 5.0;
    const spikeAmplitude = 0.45;
    const noiseViscosity = 1.2;
    const isFerrofluid = 1.0;

    const scene = new THREE.Scene();
    // The panels' backdrop dome resolves to this deep violet-black; a flat
    // color here keeps bloom simple at 48px (the dome would be invisible).
    scene.background = new THREE.Color(0x0e0912);

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);

    const capturedDpr = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(capturedDpr * effectiveZoom(container));

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

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
    // Subdiv 32 (panels use 64): visually identical at 48px and the shader
    // runs calc() three times per vertex for normals, so this is the main
    // per-frame cost lever.
    const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 32), sphereMaterial);
    sphere.visible = false;
    scene.add(sphere);

    // Same lighting rig as the panels.
    const keyLight = new THREE.DirectionalLight(0xfff5ea, 1.4);
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

    let isEnvMapLoaded = false;
    let envRenderTarget: THREE.WebGLRenderTarget | null = null;
    let disposed = false;
    let pmremDisposed = false;
    const exrLoader = new EXRLoader();
    exrLoader.load(EXR_URL, (texture: THREE.Texture) => {
      if (disposed) {
        texture.dispose();
        return;
      }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const rt = pmremGenerator.fromEquirectangular(texture);
      envRenderTarget = rt;
      sphereMaterial.envMap = rt.texture;
      texture.dispose();
      pmremGenerator.dispose();
      pmremDisposed = true;
      isEnvMapLoaded = true;
    });

    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.65, 0.4, 0.6);
    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    const applySize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(capturedDpr * effectiveZoom(container));
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
    };
    applySize();
    const ro = new ResizeObserver(() => applySize());
    ro.observe(container);

    // Audio: tap the master gain when the engine exists; retry quietly until
    // it does (the orb mounts before the player engine on a cold boot).
    let source: FreqSource & { dispose?: () => void } = new IdleSource(7);
    let audioRetry = 0;
    const tryAttachAudio = () => {
      try {
        const h = new HybridSource(getMasterGain(), 7);
        if (disposed) {
          h.dispose();
          return;
        }
        source = h;
      } catch {
        audioRetry = window.setTimeout(tryAttachAudio, 3000);
      }
    };
    tryAttachAudio();

    // Animation state — orb-branch constants from CymaticsVisualizer, with the
    // per-frame Euler/Quaternion/Vector3 allocations hoisted.
    let prevTime = performance.now();
    const rotation = new THREE.Vector3(0, 0, 0);
    let envB = 0, envM = 0, envH = 0;
    let rafId = 0;
    const euler = new THREE.Euler();
    const quaternion = new THREE.Quaternion();
    const camVec = new THREE.Vector3();

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      if (typeof document !== 'undefined' && document.hidden) return;
      if (renderer.getContext().isContextLost()) return;

      source.update();
      const data = source.data;

      const t = performance.now();
      const dt = (t - prevTime) / (1000 / 60);
      prevTime = t;

      let rawB = 0, rawM = 0, rawH = 0;
      for (let i = 0; i < 4; i++) rawB += data[i] || 0;
      for (let i = 4; i < 11; i++) rawM += data[i] || 0;
      for (let i = 11; i < 16; i++) rawH += data[i] || 0;
      const envK = Math.min(1, 0.035 * dt);
      envB += (rawB / 1020 - envB) * envK;
      envM += (rawM / 1785 - envM) * envK;
      envH += (rawH / 1275 - envH) * envK;

      sphere.visible = isEnvMapLoaded;
      const shader = sphereMaterial.userData.shader;
      if (shader) {
        const amp = (envB + envM + envH) / 3.0;
        sphere.scale.setScalar(1.0 + 0.04 * envB);

        const f = 0.001;
        rotation.x += dt * f * 0.45;
        rotation.y += dt * f * 0.18 + envM * 0.005;
        rotation.z += dt * f * 0.15;

        euler.set(rotation.x, rotation.y, rotation.z);
        quaternion.setFromEuler(euler);
        // Panels frame at 3.3; much tighter here so the blob fills its circle
        // and the glow can nestle it. Peak spikes (~1.45r) just fit at 2.4.
        camVec.set(0, 0, 2.4).applyQuaternion(quaternion);
        camera.position.copy(camVec);
        camera.up.set(0, 1, 0);
        camera.lookAt(sphere.position);

        const speedScale = 0.015 * (1.0 + 0.6 * envB);
        shader.uniforms.time.value += dt * speedScale;
        shader.uniforms.inputData.value.set(envB, envM, envH, amp);
        shader.uniforms.outputData.value.set(0, 0, 0, 0);
      }

      composer.render();
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(audioRetry);
      source.dispose?.();
      ro.disconnect();
      if (!pmremDisposed) pmremGenerator.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
      });
      envRenderTarget?.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden' }}
    />
  );
};

export default FerroOrbCore;
