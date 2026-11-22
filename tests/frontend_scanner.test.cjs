const test = require('node:test');
const assert = require('node:assert/strict');
const { createScannerController, analyzeDocumentFrame } = require('../frontend/scanner.js');

function setup({ getUserMedia, play = async () => {}, urlApi } = {}) {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks };
  const mediaDevices = { getUserMedia: getUserMedia || (async () => stream) };
  const events = [];
  const video = { videoWidth: 466, videoHeight: 659, srcObject: null, play };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: (...args) => events.push(['draw', ...args.slice(1)]) }),
    toBlob: callback => callback(new Blob([new Uint8Array(2200)], { type: 'image/jpeg' })),
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

function syntheticFrame({ page = true, light = 80 } = {}) {
  const width = 112, height = 144;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set([light, light, light, 255], i * 4);
  if (page) {
    for (let y = 14; y < 114; y++) for (let x = 15; x < 81; x++) {
      const color = y % 13 === 0 && x > 24 && x < 72 ? 40 : 235;
      pixels.set([color, color, color, 255], (y * width + x) * 4);
    }
  }
  return { width, height, pixels };
}

test('document detector distinguishes missing page, poor light, and a well-framed page', () => {
  const canvas = { getContext: () => ({
    clearRect() {}, drawImage() {}, getImageData() { return { data: syntheticFrame({ page: false, light: 110 }).pixels }; },
  }) };
  const video = { videoWidth: 480, videoHeight: 640 };
  assert.equal(analyzeDocumentFrame(video, canvas, { minBrightness: 95 }).status, 'Looking for document...');
  const darkCanvas = { getContext: () => ({ clearRect() {}, drawImage() {}, getImageData() { return { data: syntheticFrame({ page: false, light: 30 }).pixels }; } }) };
  assert.equal(analyzeDocumentFrame(video, darkCanvas).status, 'Improve lighting');
  const pageCanvas = { getContext: () => ({ clearRect() {}, drawImage() {}, getImageData() { return { data: syntheticFrame({ light: 40 }).pixels }; } }) };
  assert.equal(analyzeDocumentFrame(video, pageCanvas).status, 'Document detected');
  assert.equal(analyzeDocumentFrame(video, pageCanvas, { minSharpness: 1e9 }).status, 'Image is blurry');
  assert.equal(analyzeDocumentFrame(video, pageCanvas, { minArea: .55 }).status, 'Move closer');
});

test('detector finds an open textbook spread across a dark central gutter', () => {
  const width = 112, height = 144, pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set([95, 95, 95, 255], i * 4);
  for (const [left, right] of [[12, 52], [60, 100]]) {
    for (let y = 14; y < 132; y++) for (let x = left; x < right; x++) {
      const glyph = (y % 11 === 0 && x > left + 5 && x < right - 4) ||
        (x % 13 === 0 && y % 11 > 3 && y % 11 < 8);
      const shade = glyph ? 45 : 226;
      pixels.set([shade, shade - 4, shade - 10, 255], (y * width + x) * 4);
    }
  }
  const canvas = { getContext: () => ({ clearRect() {}, drawImage() {}, getImageData() { return { data: pixels }; } }) };
  const result = analyzeDocumentFrame({ videoWidth: 480, videoHeight: 640 }, canvas);
  assert.equal(result.status, 'Document detected', JSON.stringify(result));
  assert.ok(result.box.width > .7, 'the two page regions merge into a spread-sized region');
});

test('detector preserves landscape camera aspect ratio without cropping the frame', () => {
  let drawArgs;
  const pixels = new Uint8ClampedArray(112 * 144 * 4);
  for (let i = 0; i < 112 * 144; i++) pixels.set([120, 120, 120, 255], i * 4);
  const canvas = { getContext: () => ({ clearRect() {}, drawImage(...args) { drawArgs = args; }, getImageData() { return { data: pixels }; } }) };
  analyzeDocumentFrame({ videoWidth: 1280, videoHeight: 720 }, canvas);
  assert.deepEqual(drawArgs.slice(1), [0, 40, 112, 63]);
});

test('Auto Capture requires stable detections for the configured frame count and duration', async () => {
  const callbacks = new Map();
  let nextHandle = 0;
  const f = setup();
  const controller = createScannerController({
    video: f.video, canvas: f.canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices,
    URLApi: { createObjectURL: () => 'blob:auto', revokeObjectURL() {} },
    makeFile: (blob, name) => Object.assign(blob, { name }),
    detectFrame: () => ({ status: 'Document detected', box: { x: .2, y: .12, width: .6, height: .76 } }),
    onState: state => f.states.push(state),
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    detectorSettings: { sampleIntervalMs: 100, stableFrames: 6, stableDurationMs: 700 },
  });
  await controller.start();
  assert.equal(f.states.at(-1).autoCapture, true);
  for (const time of [100, 300, 500, 700, 900]) {
    const [id, cb] = [...callbacks.entries()][0]; callbacks.delete(id); cb(time);
  }
  assert.equal(f.tracks[0].stopped, false, 'five stable samples are insufficient');
  const [id, cb] = [...callbacks.entries()][0]; callbacks.delete(id); cb(1100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tracks[0].stopped, true);
  assert.equal(f.states.at(-1).phase, 'preview');
});

test('disabling Auto Capture cancels pending analysis immediately and keeps manual capture', async () => {
  const callbacks = new Map();
  let nextHandle = 0, detections = 0;
  const f = setup();
  const controller = createScannerController({
    video: f.video, canvas: f.canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices,
    URLApi: { createObjectURL: () => 'blob:manual', revokeObjectURL() {} },
    makeFile: (blob, name) => Object.assign(blob, { name }),
    detectFrame: () => { detections++; return { status: 'Document detected', box: { x: .2, y: .12, width: .6, height: .76 } }; },
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
  });
  await controller.start();
  assert.equal(controller.setAutoCapture(false), false);
  assert.equal(callbacks.size, 0);
  assert.equal(await controller.capture(), true);
  assert.equal(detections, 0);
});

test('disabling Auto Capture while image encoding is pending suppresses its automatic capture', async () => {
  const callbacks = new Map(), blobCallbacks = [];
  let nextHandle = 0;
  const f = setup();
  const canvas = {
    getContext: () => ({ drawImage() {} }),
    toBlob: callback => blobCallbacks.push(callback),
  };
  const controller = createScannerController({
    video: f.video, canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices,
    URLApi: { createObjectURL: () => 'blob:pending', revokeObjectURL() {} },
    makeFile: (blob, name) => Object.assign(blob, { name }),
    detectFrame: () => ({ status: 'Document detected', box: { x: .2, y: .12, width: .6, height: .76 } }),
    onState: state => f.states.push(state),
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    detectorSettings: { sampleIntervalMs: 0, stableFrames: 1, stableDurationMs: 0 },
  });
  await controller.start();
  const [id, frame] = [...callbacks.entries()][0]; callbacks.delete(id); frame(100);
  assert.equal(blobCallbacks.length, 1);
  controller.setAutoCapture(false);
  blobCallbacks.shift()(new Blob([new Uint8Array(2200)], { type: 'image/jpeg' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.states.some(state => state.phase === 'preview'), false);
  assert.equal(f.tracks[0].stopped, false, 'camera remains available for manual capture');
  const manualCapture = controller.capture();
  blobCallbacks.shift()(new Blob([new Uint8Array(2200)], { type: 'image/jpeg' }));
  assert.equal(await manualCapture, true);
  assert.equal(f.states.at(-1).phase, 'preview');
});

test('backgrounding the tab resets stability and resumes detection when visible', async () => {
  const callbacks = new Map(), listeners = new Map();
  let nextHandle = 0;
  const f = setup();
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const controller = createScannerController({
    video: f.video, canvas: f.canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices, document,
    detectFrame: () => ({ status: 'Document detected', box: { x: .2, y: .12, width: .6, height: .76 } }),
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
  });
  await controller.start();
  assert.equal(callbacks.size, 1);
  document.visibilityState = 'hidden'; listeners.get('visibilitychange')();
  assert.equal(callbacks.size, 0);
  document.visibilityState = 'visible'; listeners.get('visibilitychange')();
  assert.equal(callbacks.size, 1);
  controller.dispose();
  assert.equal(listeners.size, 0);
});

test('Auto Capture uploads exactly once after capture and reports upload progress', async () => {
  const callbacks = new Map();
  let nextHandle = 0, uploads = 0, completions = 0, lastFile;
  const f = setup();
  const controller = createScannerController({
    video: f.video, canvas: f.canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices,
    URLApi: { createObjectURL: () => 'blob:auto-upload', revokeObjectURL() {} },
    makeFile: (blob, name) => { lastFile = Object.assign(blob, { name }); return lastFile; },
    detectFrame: () => ({ status: 'Document detected', box: { x: .18, y: .1, width: .64, height: .8 } }),
    onState: state => f.states.push(state),
    onAutoUpload: async (file, { onProgress }) => {
      uploads++; assert.equal(file, lastFile); onProgress(42); onProgress(100);
      return { id: 'doc-1', status: 'completed' };
    },
    onAutoUploadComplete: () => { completions++; },
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    detectorSettings: { stableFrames: 6, stableDurationMs: 700, sampleIntervalMs: 100 },
  });
  await controller.start();
  for (const time of [100, 250, 400, 550, 700, 850]) {
    const [id, cb] = [...callbacks.entries()][0]; callbacks.delete(id); cb(time);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads, 1);
  assert.equal(completions, 1);
  assert.equal(f.states.at(-1).phase, 'uploaded');
  assert.equal(await controller.retryUpload(), false, 'a completed upload cannot be repeated');
  assert.equal(uploads, 1);
});

test('failed automatic upload retains its capture and retry uses the same file once', async () => {
  const callbacks = new Map();
  let nextHandle = 0, uploads = 0, uploadedFile;
  const f = setup();
  const controller = createScannerController({
    video: f.video, canvas: f.canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices,
    URLApi: { createObjectURL: () => 'blob:retry', revokeObjectURL() {} },
    makeFile: (blob, name) => Object.assign(blob, { name }),
    detectFrame: () => ({ status: 'Document detected', box: { x: .18, y: .1, width: .64, height: .8 } }),
    onState: state => f.states.push(state),
    onAutoUpload: async file => {
      uploads++; uploadedFile ||= file; assert.equal(file, uploadedFile);
      if (uploads === 1) throw new Error('Server is busy. Retry the captured photo.');
      return { id: 'doc-2', status: 'completed' };
    },
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    detectorSettings: { stableFrames: 6, stableDurationMs: 700, sampleIntervalMs: 100 },
  });
  await controller.start();
  for (const time of [100, 250, 400, 550, 700, 850]) {
    const [id, cb] = [...callbacks.entries()][0]; callbacks.delete(id); cb(time);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.states.at(-1).phase, 'upload-error');
  assert.equal(f.states.at(-1).file, uploadedFile);
  assert.equal(await controller.retryUpload(), true);
  assert.equal(uploads, 2);
  assert.equal(f.states.at(-1).phase, 'uploaded');
});

test('camera movement resets stability and prevents an automatic capture', async () => {
  const callbacks = new Map();
  let nextHandle = 0, samples = 0;
  const f = setup();
  const controller = createScannerController({
    video: f.video, canvas: f.canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices,
    URLApi: { createObjectURL: () => 'blob:moving', revokeObjectURL() {} },
    makeFile: (blob, name) => Object.assign(blob, { name }),
    detectFrame: () => ({ status: 'Document detected', box: {
      x: samples++ % 2 ? .2 : .42, y: .12, width: .6, height: .76,
    } }),
    onState: state => f.states.push(state),
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    detectorSettings: { stableFrames: 6, stableDurationMs: 700, sampleIntervalMs: 100 },
  });
  await controller.start();
  for (const time of [100, 250, 400, 550, 700, 850, 1000, 1150]) {
    const [id, cb] = [...callbacks.entries()][0]; callbacks.delete(id); cb(time);
  }
  assert.equal(samples, 8);
  assert.equal(f.tracks[0].stopped, false);
  assert.equal(f.states.at(-1).phase, 'live');
  controller.close();
});

test('closing during automatic upload aborts the request and releases camera resources', async () => {
  const callbacks = new Map();
  let nextHandle = 0, requestSignal;
  const f = setup();
  const controller = createScannerController({
    video: f.video, canvas: f.canvas, analysisCanvas: {}, mediaDevices: f.mediaDevices,
    URLApi: { createObjectURL: () => 'blob:cancel', revokeObjectURL() {} },
    makeFile: (blob, name) => Object.assign(blob, { name }),
    detectFrame: () => ({ status: 'Document detected', box: { x: .18, y: .1, width: .64, height: .8 } }),
    onState: state => f.states.push(state),
    onAutoUpload: (_file, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    },
    requestAnimationFrame: callback => { const id = ++nextHandle; callbacks.set(id, callback); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    detectorSettings: { stableFrames: 6, stableDurationMs: 700, sampleIntervalMs: 100 },
  });
  await controller.start();
  for (const time of [100, 250, 400, 550, 700, 850]) {
    const [id, cb] = [...callbacks.entries()][0]; callbacks.delete(id); cb(time);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.states.at(-1).phase, 'uploading');
  controller.close();
  assert.equal(requestSignal.aborted, true);
  assert.equal(f.tracks[0].stopped, true);
  assert.equal(f.states.at(-1).phase, 'closed');
});
