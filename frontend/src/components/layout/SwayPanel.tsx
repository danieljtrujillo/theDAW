/**
 * Moved to components/sway/SwayLinkPanel.tsx, which the SWAY tab renders beside
 * the embedded SwayCommand cockpit. This re-export keeps the bottom multi-tab
 * dock working unchanged while the tab is stood up; it goes away with the dock
 * entry once the embed lands.
 */
export { SwayLinkPanel as SwayPanel } from '../sway/SwayLinkPanel';
