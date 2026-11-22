(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JanSathiScanner = factory();
})(globalThis, function () {
  const DETECTOR_DEFAULTS = Object.freeze({
    width: 112, height: 144, minArea: 0.12, maxArea: 0.92,
    minBrightness: 68, minPageBrightness: 105, maxPageBrightness: 250, minSharpness: 36,
    stableFrames: 6, stableDurationMs: 850, maxCenterDrift: 0.03,
    maxSizeDrift: 0.045, sampleIntervalMs: 160,
  });

  // Adaptive luminance regions tolerate colored paper, printed texture, a
  // center gutter and mildly curved book pages. Region texture and Laplacian
  // sharpness distinguish printed pages from an empty, uniformly bright view.
  function analyzeDocumentFrame(video, canvas, settings = {}) {
    const cfg = { ...DETECTOR_DEFAULTS, ...settings };
    if (!video?.videoWidth || !video?.videoHeight || !canvas) return { status: 'Position your document inside the frame' };
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { status: 'Position your document inside the frame' };
    const scale = Math.min(cfg.width / video.videoWidth, cfg.height / video.videoHeight);
    const drawWidth = Math.max(1, Math.round(video.videoWidth * scale));
    const drawHeight = Math.max(1, Math.round(video.videoHeight * scale));
    const active = {
      left: Math.floor((cfg.width - drawWidth) / 2),
      top: Math.floor((cfg.height - drawHeight) / 2),
      width: drawWidth, height: drawHeight,
    };
    active.right = active.left + active.width;
    active.bottom = active.top + active.height;
    const activeArea = active.width * active.height;
    try {
      context.clearRect(0, 0, cfg.width, cfg.height);
      context.drawImage(video, active.left, active.top, active.width, active.height);
    }
    catch { return { status: 'Position your document inside the frame' }; }
    const { data } = context.getImageData(0, 0, cfg.width, cfg.height);
    const total = cfg.width * cfg.height;
    const histogram = new Uint32Array(256);
    const gray = new Uint8Array(total);
    let frameLight = 0;
    for (let y = active.top; y < active.bottom; y++) for (let x = active.left; x < active.right; x++) {
      const i = y * cfg.width + x, p = i * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[i] = luminance;
      frameLight += luminance;
      histogram[luminance]++;
    }
    if (frameLight / activeArea < cfg.minBrightness) return { status: 'Improve lighting' };

    let sumAll = 0, sumBackground = 0, weightBackground = 0, bestVariance = -1, otsu = 128;
    for (let i = 0; i < 256; i++) sumAll += i * histogram[i];
    for (let i = 0; i < 256; i++) {
      weightBackground += histogram[i];
      if (!weightBackground) continue;
      const weightForeground = activeArea - weightBackground;
      if (!weightForeground) break;
      sumBackground += i * histogram[i];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sumAll - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (variance > bestVariance) { bestVariance = variance; otsu = i; }
    }
    const threshold = Math.max(105, Math.min(220, otsu + 12));
    const mask = new Uint8Array(total);
    for (let y = active.top; y < active.bottom; y++) for (let x = active.left; x < active.right; x++) {
      const i = y * cfg.width + x;
      if (gray[i] >= threshold) mask[i] = 1;
    }

    const seen = new Uint8Array(total);
    const regions = [];
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
        const left = x ? index - 1 : -1, right = x + 1 < cfg.width ? index + 1 : -1;
        const up = y ? index - cfg.width : -1, down = y + 1 < cfg.height ? index + cfg.width : -1;
        if (left >= 0 && mask[left] && !seen[left]) { seen[left] = 1; stack[top++] = left; }
        if (right >= 0 && mask[right] && !seen[right]) { seen[right] = 1; stack[top++] = right; }
        if (up >= 0 && mask[up] && !seen[up]) { seen[up] = 1; stack[top++] = up; }
        if (down >= 0 && mask[down] && !seen[down]) { seen[down] = 1; stack[top++] = down; }
      }
      if (count / activeArea >= 0.035) regions.push({ minX, minY, maxX, maxY, count });
    }
    if (!regions.length) return { status: 'Looking for document...' };

    // Consider both each page and the union of adjacent page regions. The
    // union handles an open spread split by a dark gutter without requiring a
    // perfect four-corner contour.
    const candidates = [...regions];
    for (let a = 0; a < regions.length; a++) for (let b = a + 1; b < regions.length; b++) {
      const first = regions[a], second = regions[b];
      const gapX = Math.max(0, Math.max(first.minX, second.minX) - Math.min(first.maxX, second.maxX) - 1);
      const overlapY = Math.max(0, Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY) + 1);
      const sharedHeight = overlapY / Math.max(1, Math.min(first.maxY - first.minY + 1, second.maxY - second.minY + 1));
      if (gapX <= active.width * 0.1 && sharedHeight >= 0.55) candidates.push({
        minX: Math.min(first.minX, second.minX), minY: Math.min(first.minY, second.minY),
        maxX: Math.max(first.maxX, second.maxX), maxY: Math.max(first.maxY, second.maxY),
        count: first.count + second.count,
      });
    }
    candidates.sort((a, b) => b.count - a.count);
    let best = null;
    for (const region of candidates) {
      const width = region.maxX - region.minX + 1, height = region.maxY - region.minY + 1;
      const aspect = width / height, boxArea = width * height / activeArea;
      if (boxArea < cfg.minArea || boxArea > cfg.maxArea || aspect < 0.32 || aspect > 2.65) continue;
      const box = { x: (region.minX - active.left) / active.width, y: (region.minY - active.top) / active.height,
        width: width / active.width, height: height / active.height };
      if (region.minX < active.left + 2 || region.minY < active.top + 2 ||
          region.maxX >= active.right - 2 || region.maxY >= active.bottom - 2 ||
          box.x < 0.06 || box.x + box.width > 0.94 || box.y < 0.05 || box.y + box.height > 0.95) continue;
      if (!best || boxArea > best.area) best = { ...region, box, area: boxArea };
    }
    if (!best) return regions.some(region => region.count / activeArea < cfg.minArea)
      ? { status: 'Move closer' } : { status: 'Position your document inside the frame' };

    const { minX, minY, maxX, maxY, box } = best;
    const centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;
    if (centerX < 0.29 || centerX > 0.71 || centerY < 0.17 || centerY > 0.83) {
      return { status: 'Position your document inside the frame', box };
    }
    let pageLuminance = 0, edges = 0, lapMean = 0, lapSquared = 0, sampleCount = 0;
    for (let y = minY + 1; y < maxY; y++) for (let x = minX + 1; x < maxX; x++) {
      const i = y * cfg.width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - cfg.width] - gray[i + cfg.width];
      pageLuminance += gray[i];
      if (Math.abs(lap) > 28) edges++;
      lapMean += lap; lapSquared += lap * lap; sampleCount++;
    }
    const mean = lapMean / Math.max(sampleCount, 1);
    const sharpness = lapSquared / Math.max(sampleCount, 1) - mean * mean;
    const normalizedPageLight = pageLuminance / Math.max(sampleCount, 1);
    const edgeDensity = edges / Math.max(sampleCount, 1);
    if (normalizedPageLight < cfg.minPageBrightness || normalizedPageLight > cfg.maxPageBrightness) {
      return { status: 'Improve lighting', box };
    }
    if (edgeDensity < 0.004) return { status: 'Looking for document...', box };
    if (sharpness < cfg.minSharpness) return { status: 'Image is blurry', box, sharpness };
    return { status: 'Document detected', box, sharpness, edgeDensity };
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
    const onAutoUpload = options.onAutoUpload ?? null;
    const onAutoUploadComplete = options.onAutoUploadComplete ?? (() => {});
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
    let uploadController = null;
    let uploadInProgress = false;
    let uploadFailed = false;
    let autoCaptured = false;
    let uploadProgress = 0;

    function publish(phase, error = '', status = '') {
      onState({ phase, error, status, autoCapture, file: capturedFile, previewUrl,
        autoCaptured, uploadProgress });
    }

    async function uploadCapturedFile() {
      if (!capturedFile || !autoCaptured || !onAutoUpload || uploadInProgress) return false;
      uploadInProgress = true;
      uploadFailed = false;
      uploadProgress = 0;
      const requestId = generation;
      const controller = new AbortController();
      uploadController = controller;
      publish('uploading', '', 'Uploading document...');
      try {
        const document = await onAutoUpload(capturedFile, {
          signal: controller.signal,
          onProgress(percent) {
            if (requestId !== generation || controller.signal.aborted) return;
            uploadProgress = Math.max(0, Math.min(100, Math.round(percent)));
            publish('uploading', '', uploadProgress < 100 ? `Uploading document... ${uploadProgress}%` : 'Processing document...');
          },
        });
        if (requestId !== generation || controller.signal.aborted) return false;
        uploadInProgress = false;
        uploadFailed = false;
        uploadController = null;
        publish('uploaded', '', 'Document ready');
        try { onAutoUploadComplete(document, capturedFile); }
        catch (error) { publish('uploaded', `Document saved, but the overview could not open: ${error?.message || 'please open History'}`); }
        return true;
      } catch (error) {
        if (requestId !== generation || controller.signal.aborted) return false;
        uploadInProgress = false;
        uploadFailed = true;
        uploadController = null;
        publish('upload-error', error?.message || 'Upload failed. Retry or retake the image.');
        return false;
      }
    }

    function retryUpload() { return uploadFailed ? uploadCapturedFile() : false; }

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
      autoCaptured = false;
      uploadFailed = false;
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
      if (blob.size < 1200 || Math.max(canvas.width, canvas.height) < 600 || Math.min(canvas.width, canvas.height) < 300) {
        if (captureInProgress === requestId) captureInProgress = null;
        stopTracks();
        publish('error', 'The captured image is too small to read. Move closer and try again.');
        return false;
      }
      releasePreview();
      capturedFile = makeFile(blob, `JanSathi-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
      previewUrl = URLApi.createObjectURL(capturedFile);
      stopTracks();
      capturePending = false;
      if (captureInProgress === requestId) captureInProgress = null;
      autoCaptured = autoCapture && Boolean(onAutoUpload);
      publish('preview');
      if (autoCaptured) void uploadCapturedFile();
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
      autoCaptured = false;
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
      if (uploadController) uploadController.abort();
      uploadController = null; uploadInProgress = false; uploadFailed = false; uploadProgress = 0; autoCaptured = false;
      stopDetection(); capturePending = false; captureInProgress = null;
      stopTracks();
      releasePreview();
      publish('closed');
    }

    function dispose() {
      generation += 1;
      if (uploadController) uploadController.abort();
      uploadController = null; uploadInProgress = false; uploadFailed = false; uploadProgress = 0; autoCaptured = false;
      stopDetection(); capturePending = false; captureInProgress = null;
      stopTracks();
      releasePreview();
    }

    return { start, capture, usePhoto, confirm, close, dispose, setAutoCapture,
      retryUpload, analyzeDocumentFrame };
  }

  return { createScannerController, analyzeDocumentFrame, DETECTOR_DEFAULTS };
});
