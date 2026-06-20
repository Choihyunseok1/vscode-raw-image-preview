const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPythonCandidates,
  formatPythonCandidate,
  parseCameraRawMetadata,
  cameraRawErrorMessage,
  sanitizeBayerPattern,
  cameraRawExtension
} = require('../src/camera-raw');

test('camera RAW decoder tries platform-appropriate Python commands', () => {
  assert.deepEqual(getPythonCandidates('', 'win32'), [
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] }
  ]);
  assert.deepEqual(getPythonCandidates('', 'linux'), [
    { command: 'python3', args: [] },
    { command: 'python', args: [] }
  ]);
});

test('camera RAW decoder honors configured Python executable', () => {
  assert.deepEqual(getPythonCandidates('C:\\Python312\\python.exe', 'win32'), [
    { command: 'C:\\Python312\\python.exe', args: [] }
  ]);
});

test('camera RAW metadata parser ignores unrelated stderr lines', () => {
  const metadata = parseCameraRawMetadata([
    'warning: libraw message',
    'RAW_BAYER_PREVIEW_META {"width":6048,"height":4024,"pattern":"RGGB","black":512,"white":16383,"bitDepth":14}'
  ].join('\n'));

  assert.equal(metadata.width, 6048);
  assert.equal(metadata.height, 4024);
  assert.equal(metadata.pattern, 'RGGB');
  assert.equal(metadata.bitDepth, 14);
});

test('camera RAW metadata parser rejects invalid JSON', () => {
  assert.equal(parseCameraRawMetadata('RAW_BAYER_PREVIEW_META {bad'), null);
  assert.equal(parseCameraRawMetadata('no metadata'), null);
});

test('camera RAW error message includes selected Python command', () => {
  const message = cameraRawErrorMessage(
    'RAW_BAYER_PREVIEW_ERROR import: No module named rawpy',
    { command: 'python3', args: [] }
  );

  assert.match(message, /python3/);
  assert.match(message, /rawpy/);
  assert.match(message, /numpy/);
});

test('camera RAW helpers normalize pattern and extension labels', () => {
  assert.equal(sanitizeBayerPattern('grbg'), 'GRBG');
  assert.equal(sanitizeBayerPattern('CYGM'), 'RGGB');
  assert.equal(cameraRawExtension('sample.NEF'), 'NEF');
  assert.equal(formatPythonCandidate({ command: 'py', args: ['-3'] }), 'py -3');
});
