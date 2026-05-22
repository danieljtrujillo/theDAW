/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Shell } from './components/layout/Shell';
import { PlayerFooter } from './components/audio/PlayerFooter';

export default function App() {
  return (
    <>
      <Shell>
        {/* The Shell component currently handles its own internal routing for this barebones demo */}
      </Shell>
      <PlayerFooter />
    </>
  );
}
