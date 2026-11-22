(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JanSathiScanner = factory();
})(globalThis, function () {
  function createScannerController(options = {}) {
    const video = options.video;
    const canvas = options.canvas;
    const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    const URLApi = options.URLApi ?? globalThis.URL;
    const makeFile = options.makeFile ?? ((blob, name) => new File([blob], name, { type: blob.type || 'image/jpeg', lastModified: Date.now() }));
    const onState = options.onState ?? (() => {});
    const onConfirm = options.onConfirm ?? (() => {});
    let stream = null;
    let previewUrl = null;
    let capturedFile = null;
    let generation = 0;

    function publish(phase, error = '') {
      onState({ phase, error, file: capturedFile, previewUrl });
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
      if (!stream || !video?.videoWidth || !video?.videoHeight) return false;
      const requestId = generation;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        stopTracks();
        publish('error', 'This browser could not prepare the captured image.');
        return false;
      }
      try { context.drawImage(video, 0, 0, canvas.width, canvas.height); }
      catch {
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
        stopTracks();
        publish('error', 'The camera image could not be prepared. Choose a photo instead.');
        return false;
      }
      if (requestId !== generation) return false;
      if (!blob) {
        stopTracks();
        publish('error', 'The camera did not return an image. Please try again.');
        return false;
      }
      releasePreview();
      capturedFile = makeFile(blob, `JanSathi-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
      previewUrl = URLApi.createObjectURL(capturedFile);
      stopTracks();
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
      stopTracks();
      releasePreview();
      publish('closed');
    }

    function dispose() {
      generation += 1;
      stopTracks();
      releasePreview();
    }

    return { start, capture, usePhoto, confirm, close, dispose };
  }

  return { createScannerController };
});
