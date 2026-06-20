const { spawn } = require('child_process');
const fs = require('fs');

const CAMERA_RAW_SCRIPT = `
import json
import sys

try:
    import numpy as np
    import rawpy
except Exception as exc:
    print("RAW_BAYER_PREVIEW_ERROR import: " + str(exc), file=sys.stderr)
    sys.exit(2)

path = sys.argv[1]

try:
    with rawpy.imread(path) as raw:
        image = raw.raw_image_visible.copy()
        color_desc = raw.color_desc.decode("ascii", errors="ignore") if isinstance(raw.color_desc, bytes) else str(raw.color_desc)

        def color_at(index):
            try:
                value = color_desc[int(index)][:1].upper()
                return value if value in ("R", "G", "B") else "G"
            except Exception:
                return "G"

        pattern = "".join(color_at(raw.raw_pattern[y, x]) for y in range(2) for x in range(2))
        if pattern not in ("RGGB", "BGGR", "GRBG", "GBRG"):
            pattern = "RGGB"

        black_levels = [float(value) for value in raw.black_level_per_channel]
        white = int(raw.white_level) if raw.white_level is not None else int(image.max())
        bit_depth = max(1, min(16, int(white).bit_length()))
        metadata = {
            "width": int(image.shape[1]),
            "height": int(image.shape[0]),
            "pattern": pattern,
            "black": min(black_levels) if black_levels else 0,
            "white": float(white),
            "bitDepth": int(bit_depth)
        }

    image = np.ascontiguousarray(image.astype("<u2", copy=False))
    sys.stdout.buffer.write(image.tobytes(order="C"))
    print("RAW_BAYER_PREVIEW_META " + json.dumps(metadata), file=sys.stderr)
except Exception as exc:
    print("RAW_BAYER_PREVIEW_ERROR decode: " + str(exc), file=sys.stderr)
    sys.exit(3)
`;

async function convertCameraRawToBuffer(filePath, options = {}) {
  const candidates = getPythonCandidates(options.pythonPath);
  const errors = [];

  for (const candidate of candidates) {
    try {
      return await decodeWithPython(candidate, filePath, options);
    } catch (error) {
      errors.push(error);
      if (options.pythonPath) {
        break;
      }
    }
  }

  throw aggregatePythonErrors(errors, options.pythonPath);
}

function decodeWithPython(candidate, filePath, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, [...candidate.args, '-c', CAMERA_RAW_SCRIPT, filePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    let stdoutLength = 0;
    let stderrText = '';
    let settled = false;

    const fail = (error) => {
      if (!settled) {
        settled = true;
        error.pythonCommand = formatPythonCandidate(candidate);
        reject(error);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      fail(new Error(`Cannot start Python command "${formatPythonCandidate(candidate)}": ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail(new Error(cameraRawErrorMessage(stderrText, candidate)));
        return;
      }

      const metadata = parseCameraRawMetadata(stderrText);
      if (!isValidCameraRawMetadata(metadata)) {
        fail(new Error(`Python command "${formatPythonCandidate(candidate)}" did not return valid camera RAW metadata.`));
        return;
      }

      settled = true;
      const bitDepth = metadata.bitDepth || 16;
      const black = Number.isFinite(metadata.black) ? metadata.black : 0;
      const white = Number.isFinite(metadata.white) && metadata.white > black
        ? metadata.white
        : Math.pow(2, bitDepth) - 1;

      resolve({
        bytes: Buffer.concat(stdout, stdoutLength),
        sourceByteLength: options.sourceByteLength || fs.statSync(filePath).size,
        settings: {
          width: metadata.width,
          height: metadata.height,
          channels: 1,
          pattern: sanitizeBayerPattern(metadata.pattern),
          bitDepth,
          sampleFormat: 'uint',
          endian: 'little',
          packing: 'unpacked',
          black,
          white
        },
        lockedFields: {
          width: true,
          height: true,
          channels: true,
          pattern: true,
          bitDepth: true,
          sampleFormat: true,
          endian: true,
          packing: true
        },
        format: 'camera-raw',
        label: `${cameraRawExtension(options.sourceName || filePath)} ${metadata.width}x${metadata.height} ${bitDepth}-bit`
      });
    });
  });
}

function getPythonCandidates(configuredPath, platform = process.platform) {
  const configured = String(configuredPath || '').trim();
  if (configured) {
    return [{ command: configured, args: [] }];
  }
  if (platform === 'win32') {
    return [
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] }
    ];
  }
  return [
    { command: 'python3', args: [] },
    { command: 'python', args: [] }
  ];
}

function formatPythonCandidate(candidate) {
  return [candidate.command, ...candidate.args].join(' ');
}

function aggregatePythonErrors(errors, configuredPath) {
  if (!errors.length) {
    return new Error('No Python command available for camera RAW decoding.');
  }
  if (configuredPath || errors.length === 1) {
    return errors[0];
  }
  const tried = errors
    .map((error) => `${error.pythonCommand || 'python'}: ${error.message}`)
    .join(' | ');
  return new Error(`Failed to decode camera RAW. Tried Python commands automatically. Install rawpy/numpy or set rawBayerPreview.pythonPath. ${tried}`);
}

function parseCameraRawMetadata(stderrText) {
  const line = String(stderrText || '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('RAW_BAYER_PREVIEW_META '));
  if (!line) {
    return null;
  }
  try {
    return JSON.parse(line.slice('RAW_BAYER_PREVIEW_META '.length));
  } catch {
    return null;
  }
}

function cameraRawErrorMessage(stderrText, candidate) {
  const line = String(stderrText || '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('RAW_BAYER_PREVIEW_ERROR '));
  const detail = line ? line.slice('RAW_BAYER_PREVIEW_ERROR '.length) : String(stderrText || '').trim();
  const command = candidate ? ` using "${formatPythonCandidate(candidate)}"` : '';
  return `Failed to decode camera RAW${command}. Install Python rawpy/numpy for camera RAW support. ${detail}`.trim();
}

function isValidCameraRawMetadata(metadata) {
  return Boolean(metadata) &&
    Number.isSafeInteger(metadata.width) &&
    metadata.width > 0 &&
    Number.isSafeInteger(metadata.height) &&
    metadata.height > 0;
}

function sanitizeBayerPattern(value) {
  const pattern = String(value || '').toUpperCase();
  return ['RGGB', 'BGGR', 'GRBG', 'GBRG'].includes(pattern) ? pattern : 'RGGB';
}

function cameraRawExtension(filePath) {
  const match = String(filePath || '').match(/\.([^.]+)$/);
  return match ? match[1].toUpperCase() : 'Camera RAW';
}

module.exports = {
  convertCameraRawToBuffer,
  getPythonCandidates,
  formatPythonCandidate,
  parseCameraRawMetadata,
  cameraRawErrorMessage,
  sanitizeBayerPattern,
  cameraRawExtension
};
