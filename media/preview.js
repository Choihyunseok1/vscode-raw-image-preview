const vscode = acquireVsCodeApi();

const controls = {
  fileName: document.getElementById('fileName'),
  fileMeta: document.getElementById('fileMeta'),
  width: document.getElementById('width'),
  height: document.getElementById('height'),
  channels: document.getElementById('channels'),
  pattern: document.getElementById('pattern'),
  channelOrder: document.getElementById('channelOrder'),
  bitDepth: document.getElementById('bitDepth'),
  endian: document.getElementById('endian'),
  packing: document.getElementById('packing'),
  normalize: document.getElementById('normalize'),
  black: document.getElementById('black'),
  white: document.getElementById('white'),
  gain: document.getElementById('gain'),
  render: document.getElementById('render'),
  fit: document.getElementById('fit'),
  oneToOne: document.getElementById('oneToOne'),
  zoomOut: document.getElementById('zoomOut'),
  zoomIn: document.getElementById('zoomIn'),
  zoom: document.getElementById('zoom'),
  zoomLabel: document.getElementById('zoomLabel'),
  status: document.getElementById('status'),
  stage: document.getElementById('stage'),
  canvas: document.getElementById('canvas')
};

let raw = null;
let renderToken = 0;
const ctx = controls.canvas.getContext('2d', { alpha: false, willReadFrequently: false });

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type !== 'file') {
    return;
  }

  raw = new Uint8Array(message.buffer);
  applySettings(message.settings);
  controls.fileName.textContent = message.name;
  controls.fileMeta.textContent = `${formatBytes(message.byteLength)} loaded`;
  render();
});

controls.render.addEventListener('click', render);
controls.fit.addEventListener('click', fitToStage);
controls.oneToOne.addEventListener('click', () => setZoom(100));
controls.zoom.addEventListener('input', () => setZoom(Number(controls.zoom.value)));
controls.zoomOut.addEventListener('click', () => setZoom(Math.max(5, Number(controls.zoom.value) - 10)));
controls.zoomIn.addEventListener('click', () => setZoom(Math.min(800, Number(controls.zoom.value) + 10)));

for (const id of ['width', 'height', 'channels', 'pattern', 'channelOrder', 'bitDepth', 'endian', 'packing', 'normalize', 'black', 'white', 'gain']) {
  controls[id].addEventListener('change', scheduleRender);
}

vscode.postMessage({ type: 'ready' });

function applySettings(settings) {
  controls.width.value = settings.width;
  controls.height.value = settings.height;
  controls.channels.value = settings.channels;
  controls.pattern.value = settings.pattern;
  controls.channelOrder.value = settings.channelOrder || settings.pattern;
  controls.bitDepth.value = settings.bitDepth;
  controls.endian.value = settings.endian;
  controls.packing.value = settings.packing;
  controls.normalize.checked = settings.normalize;
  controls.black.value = settings.black;
  controls.white.value = settings.white;
  controls.gain.value = settings.gain;
}

function scheduleRender() {
  clearTimeout(scheduleRender.timer);
  scheduleRender.timer = setTimeout(render, 120);
}

async function render() {
  if (!raw) {
    return;
  }

  const token = ++renderToken;
  const settings = readSettings();
  const expected = expectedBytes(settings);
  const pixelCount = settings.width * settings.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > 120000000) {
    controls.status.textContent = 'Image dimensions are too large to render safely.';
    return;
  }
  controls.status.textContent = `Rendering ${settings.width} x ${settings.height}...`;

  await nextFrame();
  if (token !== renderToken) {
    return;
  }

  const width = settings.width;
  const height = settings.height;
  controls.canvas.width = width;
  controls.canvas.height = height;

  let image;
  try {
    image = ctx.createImageData(width, height);
  } catch (error) {
    controls.status.textContent = `Canvas allocation failed: ${error.message}`;
    return;
  }
  const samples = makeSampleReader(raw, settings);
  const max = settings.bitDepth === 32 ? 1 : (1 << Math.min(settings.bitDepth, 30)) - 1;
  const range = computeRange(samples, settings, max);
  fillImageData(image.data, samples, settings, range);
  ctx.putImageData(image, 0, 0);

  const warning = expected > raw.byteLength ? `, file is smaller than expected ${formatBytes(expected)}` : '';
  controls.status.textContent = `Rendered ${formatBytes(expected)} layout${warning}`;
}

function readSettings() {
  return {
    width: Math.max(1, Number(controls.width.value) || 1),
    height: Math.max(1, Number(controls.height.value) || 1),
    channels: Number(controls.channels.value),
    pattern: controls.pattern.value,
    channelOrder: controls.channelOrder.value,
    bitDepth: Number(controls.bitDepth.value),
    endian: controls.endian.value,
    packing: controls.packing.value,
    normalize: controls.normalize.checked,
    black: Number(controls.black.value) || 0,
    white: Number(controls.white.value) || 0,
    gain: Number(controls.gain.value) || 1
  };
}

function expectedBytes(settings) {
  const samples = settings.width * settings.height * settings.channels;
  if (settings.packing === 'mipi10') {
    return Math.ceil(samples / 4) * 5;
  }
  if (settings.packing === 'mipi12') {
    return Math.ceil(samples / 2) * 3;
  }
  return samples * (settings.bitDepth === 8 ? 1 : settings.bitDepth === 32 ? 4 : 2);
}

function makeSampleReader(bytes, settings) {
  if (settings.packing === 'mipi10') {
    return makeMipi10Reader(bytes);
  }
  if (settings.packing === 'mipi12') {
    return makeMipi12Reader(bytes);
  }
  if (settings.bitDepth === 8) {
    return (index) => bytes[index] || 0;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (settings.bitDepth === 32) {
    return (index) => {
      const offset = index * 4;
      return offset + 3 < bytes.byteLength ? view.getFloat32(offset, settings.endian === 'little') : 0;
    };
  }
  return (index) => {
    const offset = index * 2;
    return offset + 1 < bytes.byteLength ? view.getUint16(offset, settings.endian === 'little') : 0;
  };
}

function makeMipi10Reader(bytes) {
  return (index) => {
    const group = Math.floor(index / 4) * 5;
    const lane = index & 3;
    if (group + 4 >= bytes.length) {
      return 0;
    }
    return (bytes[group + lane] << 2) | ((bytes[group + 4] >> (lane * 2)) & 0x03);
  };
}

function makeMipi12Reader(bytes) {
  return (index) => {
    const group = Math.floor(index / 2) * 3;
    if (group + 2 >= bytes.length) {
      return 0;
    }
    if ((index & 1) === 0) {
      return (bytes[group] << 4) | (bytes[group + 2] & 0x0f);
    }
    return (bytes[group + 1] << 4) | (bytes[group + 2] >> 4);
  };
}

function computeRange(samples, settings, max) {
  if (!settings.normalize) {
    const white = settings.white > settings.black ? settings.white : max;
    return { black: settings.black, white };
  }

  const total = settings.width * settings.height * settings.channels;
  const stride = Math.max(1, Math.floor(total / 250000));
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < total; i += stride) {
    const value = samples(i);
    if (Number.isFinite(value)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  if (!Number.isFinite(low) || high <= low) {
    low = settings.black;
    high = max;
  }
  return { black: low, white: high };
}

function fillImageData(out, samples, settings, range) {
  const { width, height, channels, pattern, channelOrder, gain } = settings;
  const scale = 255 / Math.max(1e-9, range.white - range.black);

  if (channels === 4) {
    const channelForPosition = fourChannelShuffleMap(pattern, channelOrder);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourcePixel = y * width + x;
        const position = (y & 1) * 2 + (x & 1);
        const channel = channelForPosition[position];
        const color = pattern[position] || 'G';
        const value = toByte(samples(sourcePixel * 4 + channel), range.black, scale, gain);
        const outOffset = sourcePixel * 4;
        out[outOffset] = color === 'R' ? value : 0;
        out[outOffset + 1] = color === 'G' ? value : 0;
        out[outOffset + 2] = color === 'B' ? value : 0;
        out[outOffset + 3] = 255;
      }
    }
    return;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const outOffset = pixel * 4;
      if (channels === 3) {
        out[outOffset] = toByte(samples(pixel * 3), range.black, scale, gain);
        out[outOffset + 1] = toByte(samples(pixel * 3 + 1), range.black, scale, gain);
        out[outOffset + 2] = toByte(samples(pixel * 3 + 2), range.black, scale, gain);
      } else {
        const value = toByte(samples(pixel), range.black, scale, gain);
        const color = bayerColor(pattern, x, y);
        out[outOffset] = color === 'R' ? value : 0;
        out[outOffset + 1] = color === 'G' ? value : 0;
        out[outOffset + 2] = color === 'B' ? value : 0;
      }
      out[outOffset + 3] = 255;
    }
  }
}

function fourChannelShuffleMap(pattern, channelOrder) {
  const available = [...(channelOrder || 'RGGB')];
  return [...(pattern || 'RGGB')].map((color) => {
    const index = available.indexOf(color);
    if (index === -1) {
      return color === 'R' ? 0 : color === 'B' ? 3 : 1;
    }
    available[index] = '';
    return index;
  });
}

function bayerColor(pattern, x, y) {
  const index = (y & 1) * 2 + (x & 1);
  return (pattern || 'RGGB')[index] || 'G';
}

function toByte(value, black, scale, gain) {
  const scaled = (value - black) * scale * gain;
  return Math.max(0, Math.min(255, scaled)) | 0;
}

function setZoom(value) {
  controls.zoom.value = String(value);
  controls.zoomLabel.textContent = `${value}%`;
  controls.canvas.style.transform = `scale(${value / 100})`;
  const width = controls.canvas.width * value / 100;
  const height = controls.canvas.height * value / 100;
  controls.canvas.style.marginRight = `${Math.max(16, width - controls.canvas.width + 16)}px`;
  controls.canvas.style.marginBottom = `${Math.max(16, height - controls.canvas.height + 16)}px`;
}

function fitToStage() {
  const width = controls.canvas.width || 1;
  const height = controls.canvas.height || 1;
  const zoom = Math.max(5, Math.min(800, Math.floor(Math.min(
    (controls.stage.clientWidth - 32) / width,
    (controls.stage.clientHeight - 32) / height
  ) * 100)));
  setZoom(zoom);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
