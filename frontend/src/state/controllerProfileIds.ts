/**
 * Controller profile ID constants — split out of controllerProfiles.ts
 * (FE-025 / P-20260919-batch12) so a module that only needs to REFER to a
 * profile by id (never read the profile table itself) does not pull the
 * 400+ line CONTROLLER_PROFILES table into its chunk.
 *
 * slideStore.ts is the reason this file exists: it is reachable eagerly
 * (App -> Shell -> BottomMultiTabPanel -> slideStore, none of those lazy),
 * and only ever needed `DEFAULT_PROFILE_ID` as its initial SLIDE device
 * selection — not the table. Importing that one constant from
 * controllerProfiles.ts used to drag the whole table into the first-paint
 * bundle regardless of how many OTHER consumers of controllerProfiles were
 * lazy.
 *
 * controllerProfiles.ts re-exports these, so every other consumer
 * (SlidePanel, ControllerVisionModal, App's dynamic Sway-detect effect)
 * keeps importing them from controllerProfiles.ts unchanged.
 */

/** The on-screen GANTASMO XR twin surface (see WorldsCollidePanel). */
export const GANTASMO_WORLDS_COLLIDE_ID = 'gantasmo-worlds-collide';

/** The Audima Sway expressive-motion controller — pinned second in the SLIDE
 *  picker (right below the GANTASMO twin) so the 6-dimension surface is one
 *  click away. Its dims bind by learn via swayBus. */
export const AUDIMA_SWAY_ID = 'audima-sway';

// Default to the on-screen GANTASMO surface so it is front-and-centre with no
// hardware connected. Auto-detect still switches to a real controller when one
// is connected.
export const DEFAULT_PROFILE_ID = GANTASMO_WORLDS_COLLIDE_ID;
