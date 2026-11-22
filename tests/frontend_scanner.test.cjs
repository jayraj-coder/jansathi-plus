const test = require('node:test');
const assert = require('node:assert/strict');
const { createScannerController } = require('../frontend/scanner.js');

function setup({ getUserMedia, play = async () => {}, urlApi } = {}) {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks };
  const mediaDevices = { getUserMedia: getUserMedia || (async () => stream) };
  const events = [];
  const video = { videoWidth: 466, videoHeight: 659, srcObject: null, play };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: (...args) => events.push(['draw', ...args.slice(1)]) }),
    toBlob: callback => callback(new Blob(['scan'], { type: 'image/jpeg' })),
  };
  let nextUrl = 0;
  const urls = urlApi || {
    createObjectURL: () => `blob:test-${++nextUrl}`,
    revokeObjectURL: url => events.push(['revoke', url]),
  };
  const states = [];
  const confirmations = [];
  const controller = createScannerController({
    video, canvas, mediaDevices, URLApi: urls,
    makeFile: (blob, name) => Object.assign(blob, { name }),
    onState: state => states.push(state),
    onConfirm: file => confirmations.push(file),
  });
  return { controller, tracks, stream, video, canvas, events, states, confirmations, mediaDevices };
}

test('requests the rear camera only when started and captures one JPEG preview', async () => {
  let constraints;
  const f = setup({ getUserMedia: async value => { constraints = value; return { getTracks: () => f.tracks }; } });
  assert.equal(constraints, undefined, 'camera is not requested at controller creation');
  assert.equal(await f.controller.start(), true);
  assert.deepEqual(constraints.video.facingMode, { ideal: 'environment' });
  assert.equal(constraints.audio, false);
  assert.equal(await f.controller.capture(), true);
  assert.equal(f.canvas.width, 466);
  assert.equal(f.canvas.height, 659);
  assert.equal(f.tracks[0].stopped, true, 'camera is stopped as soon as capture completes');
  assert.equal(f.states.at(-1).phase, 'preview');
  assert.equal(f.states.at(-1).file.type, 'image/jpeg');
  assert.match(f.states.at(-1).file.name, /^JanSathi-scan-.*\.jpg$/);
});

test('retake restarts capture; confirming hands the same image to the upload callback', async () => {
  const f = setup();
  await f.controller.start();
  await f.controller.capture();
  const firstTrack = f.tracks[0];
  await f.controller.start();
  assert.equal(firstTrack.stopped, true);
  const secondFile = await f.controller.capture().then(() => f.states.at(-1).file);
  assert.equal(f.controller.confirm(), true);
  assert.equal(f.confirmations[0], secondFile);
  assert.equal(f.states.at(-1).phase, 'closed');
});

test('camera denial is reported and a chosen image can continue through preview', async () => {
  const f = setup({ getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
  assert.equal(await f.controller.start(), false);
  assert.match(f.states.at(-1).error, /permission was denied/i);
  const photo = Object.assign(new Blob(['photo'], { type: 'image/png' }), { name: 'notice.png' });
  assert.equal(f.controller.usePhoto(photo), true);
  assert.equal(f.states.at(-1).phase, 'preview');
  assert.equal(f.states.at(-1).file, photo);
});

test('closing during a pending permission request stops the late camera stream', async () => {
  let resolveCamera;
  const f = setup({ getUserMedia: () => new Promise(resolve => { resolveCamera = resolve; }) });
  const opening = f.controller.start();
  f.controller.close();
  resolveCamera(f.stream);
  assert.equal(await opening, false);
  assert.equal(f.tracks[0].stopped, true);
  assert.equal(f.video.srcObject, null);
});

test('missing camera API enters a usable file-fallback state', async () => {
  const f = setup({ getUserMedia: async () => null });
  f.mediaDevices.getUserMedia = undefined;
  assert.equal(await f.controller.start(), false);
  assert.match(f.states.at(-1).error, /unavailable/i);
});

test('capture preparation errors stop camera tracks before offering the fallback', async () => {
  const f = setup();
  f.canvas.getContext = () => null;
  await f.controller.start();
  assert.equal(await f.controller.capture(), false);
  assert.equal(f.tracks[0].stopped, true);
  assert.equal(f.states.at(-1).phase, 'error');
});
