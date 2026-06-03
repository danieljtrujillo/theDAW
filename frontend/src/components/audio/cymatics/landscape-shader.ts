/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const vs = `#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
  varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

uniform float time;
uniform vec4 audioData; // x: bass, y: mids, z: highs, w: unused
uniform float scrollSpeed;
uniform float mountainHeight;
uniform float isFerrofluid; // 0.0 (smooth chrome) to 1.0 (ferrofluid spike landscape)

float getLandscapeHeight(vec3 pos) {
  // If no audio is active, return 0.0 or a perfectly flat static baseline terrain.
  float totalAudio = max(audioData.x, max(audioData.y, audioData.z));
  if (totalAudio < 0.01) {
    return 0.0;
  }

  // pos is the plane space, pos.x is across, pos.y is along/infinity
  float scroll = time * scrollSpeed;
  vec2 p = pos.xy + vec2(0.0, scroll);

  // Synthwave mountains: side peaks with central deep river/valley
  float centerX = pos.x;
  float valleyWidth = 4.5;
  // sideMask is 1.0 in outer mountains, and 0.0 in the center valley river
  float sideMask = smoothstep(1.2, valleyWidth, abs(centerX));

  // Sine/cosine octaves for nice layered range mountains on the sides
  float n1 = sin(p.x * 0.35) * cos(p.y * 0.22);
  float n2 = sin(p.x * 0.8 + 1.2) * cos(p.y * 0.5) * 0.45;
  float n3 = sin(p.x * 1.6 - 0.5) * cos(p.y * 1.1) * 0.18;
  float baseMountains = (n1 + n2 + n3) * mountainHeight;

  // Valley reactive flow (rolling mercury/liquid waves in the center)
  float valleyWave = sin(p.y * 1.4 - time * 3.0) * 0.18 * (audioData.x + audioData.y);

  // Composite standard base landscape terrain
  float baseHeight = mix(valleyWave, baseMountains, sideMask);

  // --- Physically Authentic 2D Romanesco Fibonacci Grid Spikes ---
  // Constant wavenumber density for the spikes (ensuring grid constant does NOT stretch with volume)
  float d = 4.8;
  float spX = p.x * d;
  float spY = p.y * d;

  // Hexagonal and Fibonacci cross-hatching wave vectors
  float s1 = cos(13.0 * p.x - 21.0 * p.y);
  float s2 = cos(-21.0 * p.x - 34.0 * p.y);
  float s3 = cos(8.0 * p.x + 13.0 * p.y);

  // Normalized 2D hexagonal lattice field ranging precisely from [0.0, 1.0]
  float grid = (s1 + s2 + s3 + 1.5) / 4.5;
  grid = clamp(grid, 0.0, 1.0);

  // Golden ratio and Fibonacci-based fractal row scaling (Romanesco):
  float phi_constant = 1.61803398875;
  float macroRow = cos(spX / phi_constant) * sin(spY / phi_constant);
  float mesoRow = cos(spX * phi_constant) * sin(spY * phi_constant);
  float romanescoScale = (0.5 + 0.5 * macroRow) * (0.6 + 0.4 * mesoRow);

  // Double-curvature Hershey's Kiss/witch's hat profile matching the physical model
  // Broad candle-foot flare near the base of each spike:
  float foot = pow(grid, 3.0);

  // Sharp central cusp peak driven by magnetic/vocal fields:
  float magneticStrength = isFerrofluid * (0.2 + 0.8 * totalAudio);

  float apexExp = mix(6.0, 24.0, magneticStrength);
  float apexMultiplier = mix(0.2, 5.5, magneticStrength);
  float apex = pow(grid, apexExp) * apexMultiplier;

  float spikeProfile = (foot + apex) / (1.0 + apexMultiplier);

  // Apply the same micro-cusp tip sharpener to avoid polygonal blunting
  float sharpTip = 1.0 - pow(1.5 * (1.0 - grid), 0.72);
  spikeProfile = mix(spikeProfile, spikeProfile * clamp(sharpTip, 0.0, 1.0), isFerrofluid);

  // Spikes grow taller based on input audio volume and Romanesco scaling
  float spikes = spikeProfile * mountainHeight * romanescoScale * 1.25 * totalAudio;

  // Blend in ferrofluid spikes based on current mode slider configuration
  float height = baseHeight + spikes * isFerrofluid;

  return height;
}

void main() {
  #include <uv_vertex>
  #include <color_vertex>
  #include <morphinstance_vertex>
  #include <morphcolor_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <normal_vertex>
  #include <begin_vertex>

  float inc = 0.01;

  // We displace along locally perpendicular normal (Z on a plane)
  float z = getLandscapeHeight( position );
  vec3 np = position + vec3(0.0, 0.0, z);

  // Compute central difference derivatives for exact normal recalculation
  float zDX = getLandscapeHeight( position + vec3(inc, 0.0, 0.0) );
  float zDY = getLandscapeHeight( position + vec3(0.0, inc, 0.0) );

  vec3 npDX = position + vec3(inc, 0.0, zDX);
  vec3 npDY = position + vec3(0.0, inc, zDY);

  vec3 tangent = normalize( npDX - np );
  vec3 bitangent = normalize( npDY - np );

  // Cross product defines the exact surface normal in plane space
  transformedNormal = normalMatrix * normalize( cross( tangent, bitangent ) );
  vNormal = normalize( transformedNormal );

  transformed = np;

  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <displacementmap_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  vViewPosition = - mvPosition.xyz;
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>
  #ifdef USE_TRANSMISSION
    vWorldPosition = worldPosition.xyz;
  #endif
}
`;

export { vs };
