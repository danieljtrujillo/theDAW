// Run with: npx tsx src/state/studioStore.vstPluginName.test.ts
//
// MIX's VST stage names the plugin its entry names.
//
// A .vst3 file can hold several plugins. The live host loads the one the entry
// names (lib/vstLive/sessionRegistry passes `plugin_name`), and theDAW's render
// host loads the FIRST plugin in the file when it is given no name. So a MIX
// stage that posted no name rendered a different plugin from the one the user
// dialled in live, with that plugin's state. Replayed as a real stage posts it:
// `processVst` with the entry's fields, the form read off the stub backend.
import assert from 'node:assert/strict';
import { useStudioStore } from './studioStore.ts';

const forms: FormData[] = [];
globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
  forms.push(init?.body as FormData);
  // A failure ends the stage before it reaches the library or the player.
  return Promise.resolve(new Response(JSON.stringify({ detail: 'stub backend' }), { status: 500 }));
}) as typeof fetch;

(async () => {
  const studio = useStudioStore.getState;
  useStudioStore.setState({ sourceFile: new File(['RIFF'], 'source.wav', { type: 'audio/wav' }) });

  await studio().processVst({
    pluginPath: 'C:/Plugins/Suite.vst3',
    pluginName: 'Suite Compressor',
    params: {},
    rawState: 'c3RhdGU=',
    stateHost: 'thedaw',
    skipLibrary: true,
    quiet: true,
  });
  assert.equal(forms.length, 1, 'one post for the stage');
  assert.equal(forms[0].get('plugin_name'), 'Suite Compressor', 'the plugin inside the file that the entry names');
  assert.equal(forms[0].get('state_host'), 'thedaw');

  await studio().processVst({ pluginPath: 'C:/Plugins/P.vst3', pluginName: '', params: {}, skipLibrary: true, quiet: true });
  assert.equal(forms[1].get('plugin_name'), null, 'no name, none sent: the host picks as it always did');

  console.log('studioStore: a VST stage names its plugin');
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
