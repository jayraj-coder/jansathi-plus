(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JanSathiScanner = factory();
})(globalThis, function () {
  const DETECTOR_DEFAULTS = Object.freeze({
    width: 96, height: 128, minArea: 0.14, maxArea: 0.86,
    minBrightness: 95, maxBrightness: 242, minSharpness: 45,
    stableFrames: 6, stableDurationMs: 700, maxCenterDrift: 0.035,
    maxSizeDrift: 0.045, sampleIntervalMs: 160,
  });

  // Finds a bright, low-saturation connected region that resembles a page.
  // Small sampling keeps this inexpensive on mobile; frames touching the
  // border, extreme shapes, poor lighting, and low edge sharpness are rejected.
  function analyzeDocumentFrame(video, canvas, settings = {}) {
    const cfg = { ...DETECTOR_DEFAULTS, ...settings };
    if (!video?.videoWidth || !video?.videoHeight || !canvas) return { status: 'Position your document inside the frame' };
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { status: 'Position your document inside the frame' };
    try { context.drawImage(video, 0, 0, cfg.width, cfg.height); }
    catch { return { status: 'Position your document inside the frame' }; }
    const { data } = context.getImageData(0, 0, cfg.width, cfg.height);
    const total = cfg.width * cfg.height;
    const mask = new Uint8Array(total);
    const gray = new Uint8Array(total);
    let frameLight = 0;
    for (let i = 0; i < total; i++) {
      const p = i * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[i] = y;
      frameLight += y;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      if (y >= 150 && saturation <= 90) mask[i] = 1;
    }
    if (frameLight / total < cfg.minBrightness) return { status: 'Improve lighting' };

    const seen = new Uint8Array(total);
    let best = null;
    const stack = new Int32Array(total);
    for (let seed = 0; seed < total; seed++) {
      if (!mask[seed] || seen[seed]) continue;
      let top = 0, minX = cfg.width, minY = cfg.height, maxX = -1, maxY = -1, count = 0;
      stack[top++] = seed;
      seen[seed] = 1;
      while (top) {
        const index = stack[--top], x = index % cfg.width, y = (index / cfg.width) | 0;
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const neighbors = [x ? index - 1 : -1, x + 1 < cfg.width ? index + 1 : -1,
          y ? index - cfg.width : -1, y + 1 < cfg.height ? index + cfg.width : -1];
        for (const next of neighbors) if (next >= 0 && mask[next] && !seen[next]) {
          seen[next] = 1; stack[top++] = next;
        }
      }
      if (count > (best?.count || 0)) best = { minX, minY, maxX, maxY, count };
    }
    if (!best || best.count / total < cfg.minArea) return { status: 'Move closer' };
    const { minX, minY, maxX, maxY } = best;
    const width = maxX - minX + 1, height = maxY - minY + 1;
    const area = best.count / total, aspect = width / height;
    const box = { x: minX / cfg.width, y: minY / cfg.height,
      width: width / cfg.width, height: height / cfg.height };
    if (area > cfg.maxArea || minX < 3 || minY < 3 || maxX >= cfg.width - 3 || maxY >= cfg.height - 3 ||
        aspect < 0.35 || aspect > 1.8 || box.x < 0.12 || box.x + box.width > 0.88 ||
        box.y < 0.08 || box.y + box.height > 0.92) {
      return { status: 'Position your document inside the frame', box };
    }
    if (frameLight / total > cfg.maxBrightness) return { status: 'Improve lighting', box };
    const values = [];
    for (let y = minY + 1; y < maxY; y++) for (let x = minX + 1; x < maxX; x++) {
      const i = y * cfg.width + x;
      values.push(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - cfg.width] - gray[i + cfg.width]);
    }
    const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
    const sharpness = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(values.length, 1);
    if (sharpness < cfg.minSharpness) return { status: 'Hold steady', box, sharpness };
    return { status: 'Document detected', box, sharpness };
  }

  function boxesStable(previous, current, cfg = DETECTOR_DEFAULTS) {
    if (!previous || !current) return false;
    return ['x', 'y'].every(key => Math.abs(previous[key] - current[key]) <= cfg.maxCenterDrift) &&
      ['width', 'height'].every(key => Math.abs(previous[key] - current[key]) <= cfg.maxSizeDrift);
  }

  function createScannerController(options = {}) {
    const video = options.video;
    const canvas = options.canvas;
    const analysisCanvas = options.analysisCanvas;
    const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    const URLApi = options.URLApi ?? globalThis.URL;
    const makeFile = options.makeFile ?? ((blob, name) => new File([blob], name, { type: blob.type || 'image/jpeg', lastModified: Date.now() }));
    const onState = options.onState ?? (() => {});
    const onConfirm = options.onConfirm ?? (() => {});
    const detectFrame = options.detectFrame ?? analyzeDocumentFrame;
    const requestFrame = options.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
    const cancelFrame = options.cancelAnimationFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);
    const now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
    const detectorSettings = { ...DETECTOR_DEFAULTS, ...(options.detectorSettings || {}) };
    let stream = null;
    let previewUrl = null;
    let capturedFile = null;
    let generation = 0;
    let autoCapture = true;
    let frameHandle = null;
    let lastSample = 0;
    let stableSince = 0;
    let stableFrames = 0;
    let previousBox = null;
    let capturePending = false;
    let captureInProgress = null;

    function publish(phase, error = '', status = '') {
      onState({ phase, error, status, autoCapture, file: capturedFile, previewUrl });
    }

    function stopDetection() {
      if (frameHandle !== null && cancelFrame) cancelFrame(frameHandle);
      frameHandle = null;
      lastSample = 0; stableSince = 0; stableFrames = 0; previousBox = null;
    }

    function detectionLoop(requestId) {
      if (requestId !== generation || !stream || !autoCapture || capturePending || !requestFrame) return;
      frameHandle = requestFrame(timestamp => {
        if (requestId !== generation || !stream || !autoCapture || capturePending) return;
        const time = Number.isFinite(timestamp) ? timestamp : now();
        if (!lastSample || time - lastSample >= detectorSettings.sampleIntervalMs) {
          lastSample = time;
          let result;
          try { result = detectFrame(video, analysisCanvas, detectorSettings); }
          catch { result = { status: 'Position your document inside the frame' }; }
          let status = result?.status || 'Position your document inside the frame';
          if (status === 'Document detected' && result.box) {
            if (!boxesStable(previousBox, result.box, detectorSettings)) {
              stableSince = time; stableFrames = 1;
            } else stableFrames++;
            previousBox = result.box;
            status = stableFrames >= detectorSettings.stableFrames &&
              time - stableSince >= detectorSettings.stableDurationMs ? 'Capturing automatically...'
              : stableFrames === 1 ? 'Document detected' : 'Hold steady';
            publish('live', '', status);
            if (status === 'Capturing automatically...') {
              capturePending = true;
              stopDetection();
              void capture();
              return;
            }
          } else {
            stableSince = 0; stableFrames = 0; previousBox = null;
            publish('live', '', status);
          }
        }
        detectionLoop(requestId);
      });
    }

    function setAutoCapture(enabled) {
      autoCapture = Boolean(enabled);
      capturePending = false;
      stopDetection();
      publish(stream ? 'live' : capturedFile ? 'preview' : 'closed', '', autoCapture ? 'Position your document inside the frame' : 'Manual capture');
      if (stream && autoCapture) detectionLoop(generation);
      return autoCapture;
    }

    function releasePreview() {
      if (previewUrl) URLApi.revokeObjectURL(previewUrl);
      previewUrl = null;
      capturedFile = null;
    }

    function stopTracks() {
      if (!stream) return;
      stream.getTracks().forEach(track => track.stop());
      stream = null;
      if (video) video.srcObject = null;
    }

    async function waitForVideoFrame(requestId) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (requestId !== generation) return false;
        if (video?.videoWidth && video?.videoHeight) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    }

    async function start() {
      stopDetection();
      capturePending = false;
      stopTracks();
      releasePreview();
      const requestId = ++generation;
      if (!mediaDevices?.getUserMedia) {
        publish('error', 'Camera access is unavailable in this browser. Choose a photo instead.');
        return false;
      }
      publish('requesting');
      try {
        const nextStream = await mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1600 } },
        });
        if (requestId !== generation) {
          nextStream.getTracks().forEach(track => track.stop());
          return false;
        }
        stream = nextStream;
        video.srcObject = stream;
        await video.play();
        if (!await waitForVideoFrame(requestId)) {
          if (requestId === generation) {
            stopTracks();
            publish('error', 'The camera preview did not become ready. Choose a photo instead.');
          }
          return false;
        }
        if (requestId !== generation) {
          stopTracks();
          return false;
        }
        publish('live');
        if (autoCapture) detectionLoop(requestId);
        return true;
      } catch (error) {
        if (requestId !== generation) return false;
        stopTracks();
        const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
        publish('error', denied
          ? 'Camera permission was denied. You can choose a document photo instead.'
          : 'Could not start the camera. Check camera availability or choose a photo instead.');
        return false;
      }
    }

    async function capture() {
      if (captureInProgress === generation || !stream || !video?.videoWidth || !video?.videoHeight) return false;
      const requestId = generation;
      captureInProgress = requestId;
      stopDetection();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        if (captureInProgress === requestId) captureInProgress = null;
        stopTracks();
        publish('error', 'This browser could not prepare the captured image.');
        return false;
      }
      try { context.drawImage(video, 0, 0, canvas.width, canvas.height); }
      catch {
        if (captureInProgress === requestId) captureInProgress = null;
        stopTracks();
        publish('error', 'The camera frame could not be captured. Choose a photo instead.');
        return false;
      }
      let blob;
      try {
        blob = await new Promise((resolve, reject) => {
          try { canvas.toBlob(resolve, 'image/jpeg', 0.92); }
          catch (error) { reject(error); }
        });
      } catch {
        if (captureInProgress === requestId) captureInProgress = null;
        stopTracks();
        publish('error', 'The camera image could not be prepared. Choose a photo instead.');
        return false;
      }
      if (requestId !== generation) { if (captureInProgress === requestId) captureInProgress = null; return false; }
      if (!blob) {
        if (captureInProgress === requestId) captureInProgress = null;
        stopTracks();
        publish('error', 'The camera did not return an image. Please try again.');
        return false;
      }
      releasePreview();
      capturedFile = makeFile(blob, `JanSathi-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
      previewUrl = URLApi.createObjectURL(capturedFile);
      stopTracks();
      capturePending = false;
      if (captureInProgress === requestId) captureInProgress = null;
      publish('preview');
      return true;
    }

    function usePhoto(file) {
      if (!file || !file.type?.startsWith('image/')) {
        publish('error', 'Choose a JPG, PNG or other supported image.');
        return false;
      }
      stopTracks();
      releasePreview();
      capturedFile = file;
      previewUrl = URLApi.createObjectURL(file);
      publish('preview');
      return true;
    }

    function confirm() {
      if (!capturedFile) return false;
      const file = capturedFile;
      onConfirm(file);
      close();
      return true;
    }

    function close() {
      generation += 1;
      stopDetection(); capturePending = false; captureInProgress = null;
      stopTracks();
      releasePreview();
      publish('closed');
    }

    function dispose() {
      generation += 1;
      stopDetection(); capturePending = false; captureInProgress = null;
      stopTracks();
      releasePreview();
    }

    return { start, capture, usePhoto, confirm, close, dispose, setAutoCapture, analyzeDocumentFrame };
  }

  return { createScannerController, analyzeDocumentFrame, DETECTOR_DEFAULTS };
});
