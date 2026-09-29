// One plugin hop of an offline print (lib/vstClient processFileThroughVst):
// the request POST /api/vst/process-file is sent, and what comes back.
//
// Every print of a VST3 insert (an export, a mixdown, a track freeze or stem,
// the frozen master) posts through here, once per plugin. What each post has
// to carry is the entry's own captured state and the host that captured it,
// and what it has to hand back is the plugin's audio, the backend's own words
// on a failure, and the warnings the backend puts in `X-Vst-Warnings` about a
// state or parameter the plugin did not take.
//
// Run: npx tsx src/lib/vstClient.processFile.test.ts
import assert from 'node:assert/strict';

import { processFileThroughVst } from './vstClient.ts';

interface Sent {
  url: string;
  method: string | undefined;
  form: FormData;
}

const recorder = (answer: () => Response) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, form: init?.body as FormData });
    return answer();
  }) as typeof fetch;
  return { sent, fetchImpl };
};

const wav = new Blob(['RIFF-in'], { type: 'audio/wav' });

async function aThedawStateGoesBackToTheHostThatWroteIt(): Promise<void> {
  const r = recorder(() => new Response(new Blob(['RIFF-out']), { status: 200 }));
  const out = await processFileThroughVst(
    wav,
    { plugin_path: 'C:/Plugins/Verb.vst3', raw_state: 'c3RhdGU=', state_host: 'thedaw' },
    'insert-print.wav',
    { fetchImpl: r.fetchImpl },
  );
  assert.equal(r.sent.length, 1, 'one post per plugin');
  const [{ url, method, form }] = r.sent;
  assert.equal(url, '/api/vst/process-file');
  assert.equal(method, 'POST');
  assert.equal(form.get('plugin_path'), 'C:/Plugins/Verb.vst3');
  assert.equal(form.get('raw_state'), 'c3RhdGU=', "the entry's captured state rides along");
  assert.equal(form.get('state_host'), 'thedaw', 'a state the live host wrote renders back through it');
  assert.equal(form.get('params'), '{}');
  const audio = form.get('audio') as File;
  assert.equal(await audio.text(), 'RIFF-in', 'the audio posted is the audio handed in');
  assert.equal(audio.name, 'insert-print.wav');
  assert.equal(await out.text(), 'RIFF-out', "the plugin's audio comes back");
  assert.equal(out.name, 'insert-print.wav');
  assert.equal(out.type, 'audio/wav');
}

async function aPedalboardStateSendsNoHost(): Promise<void> {
  const r = recorder(() => new Response(new Blob(['x']), { status: 200 }));
  await processFileThroughVst(wav, { plugin_path: 'C:/P.vst3', raw_state: 'b2xk', state_host: 'pedalboard' }, 'a.wav', {
    fetchImpl: r.fetchImpl,
  });
  await processFileThroughVst(wav, { plugin_path: 'C:/P.vst3' }, 'b.wav', { fetchImpl: r.fetchImpl });
  assert.equal(r.sent[0].form.get('raw_state'), 'b2xk');
  assert.equal(r.sent[0].form.get('state_host'), null, 'absent means the pedalboard path the backend always took');
  assert.equal(r.sent[1].form.get('raw_state'), null, 'no state captured, none sent');
  assert.equal(r.sent[1].form.get('state_host'), null);
}

// A .vst3 file can hold several plugins. The live host loads the one the entry
// names (sessionRegistry passes `plugin_name`), and theDAW's render host loads
// the FIRST one in the file when it is given no name. So a print that sent no
// name ran a different plugin from the one the user heard, with that plugin's
// state. The hop names the plugin the entry names.
async function theHopNamesThePluginTheLiveHostLoaded(): Promise<void> {
  const r = recorder(() => new Response(new Blob(['x']), { status: 200 }));
  await processFileThroughVst(
    wav,
    { plugin_path: 'C:/Plugins/Suite.vst3', plugin_name: 'Suite Compressor', raw_state: 'c3RhdGU=', state_host: 'thedaw' },
    'a.wav',
    { fetchImpl: r.fetchImpl },
  );
  assert.equal(r.sent[0].form.get('plugin_name'), 'Suite Compressor', 'the plugin inside the file that the entry names');
  await processFileThroughVst(wav, { plugin_path: 'C:/P.vst3', plugin_name: '' }, 'b.wav', { fetchImpl: r.fetchImpl });
  assert.equal(r.sent[1].form.get('plugin_name'), null, 'no name, none sent: the host picks as it always did');
}

async function aFailureIsTheBackendsOwnWords(): Promise<void> {
  const detailed = recorder(() => new Response(JSON.stringify({ detail: 'the plugin failed to load' }), { status: 502 }));
  await assert.rejects(
    processFileThroughVst(wav, { plugin_path: 'C:/P.vst3' }, 'a.wav', { fetchImpl: detailed.fetchImpl }),
    /^Error: the plugin failed to load$/,
  );
  const bare = recorder(() => new Response('<html>', { status: 500 }));
  await assert.rejects(
    processFileThroughVst(wav, { plugin_path: 'C:/P.vst3' }, 'a.wav', { fetchImpl: bare.fetchImpl }),
    /^Error: HTTP 500$/,
  );
}

async function whatThePluginDidNotTakeIsHeard(): Promise<void> {
  const r = recorder(() => new Response(new Blob(['x']), {
    status: 200,
    headers: { 'X-Vst-Warnings': JSON.stringify(['saved editor state could not be restored: bad', "parameter 'mix' not applied"]) },
  }));
  const heard: string[] = [];
  await processFileThroughVst(wav, { plugin_path: 'C:/P.vst3' }, 'a.wav', {
    fetchImpl: r.fetchImpl, onWarning: (w) => heard.push(w),
  });
  assert.deepEqual(heard, ['saved editor state could not be restored: bad', "parameter 'mix' not applied"]);

  const clean = recorder(() => new Response(new Blob(['x']), { status: 200 }));
  const none: string[] = [];
  await processFileThroughVst(wav, { plugin_path: 'C:/P.vst3' }, 'a.wav', {
    fetchImpl: clean.fetchImpl, onWarning: (w) => none.push(w),
  });
  assert.deepEqual(none, [], 'a clean print warns nothing');
}

async function main(): Promise<void> {
  await aThedawStateGoesBackToTheHostThatWroteIt();
  await aPedalboardStateSendsNoHost();
  await theHopNamesThePluginTheLiveHostLoaded();
  await aFailureIsTheBackendsOwnWords();
  await whatThePluginDidNotTakeIsHeard();
  console.log('vstClient.processFile: ok');
}

await main();
