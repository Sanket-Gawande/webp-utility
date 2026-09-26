'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../src/renderer/js/helpers.js');

test('formatBytes', () => {
  assert.equal(helpers.formatBytes(0), '0 B');
  assert.equal(helpers.formatBytes(NaN), '0 B');
  assert.equal(helpers.formatBytes(512), '512 B');
  assert.equal(helpers.formatBytes(1536), '1.5 KB');
  assert.equal(helpers.formatBytes(5 * 1024 ** 2), '5 MB');
  assert.equal(helpers.formatBytes(3 * 1024 ** 5), '3072 TB');
});

test('splitFileName handles missing and unusual extensions', () => {
  assert.deepEqual(helpers.splitFileName('photo.JPG'), { base: 'photo', extension: 'jpg' });
  assert.deepEqual(helpers.splitFileName('my.holiday.png'), { base: 'my.holiday', extension: 'png' });
  assert.deepEqual(helpers.splitFileName('README'), { base: 'README', extension: '' });
  assert.deepEqual(helpers.splitFileName('.hidden'), { base: '.hidden', extension: '' });
  assert.deepEqual(helpers.splitFileName('photo.'), { base: 'photo', extension: '' });
});

test('isSupportedImage accepts decodable formats only', () => {
  assert.ok(helpers.isSupportedImage({ name: 'a.jpg', type: 'image/jpeg' }));
  assert.ok(helpers.isSupportedImage({ name: 'a.webp', type: '' }), 'empty MIME falls back to extension');
  assert.ok(helpers.isSupportedImage({ name: 'a.avif', type: 'application/octet-stream' }));
  assert.ok(!helpers.isSupportedImage({ name: 'a.tiff', type: 'image/tiff' }));
  assert.ok(!helpers.isSupportedImage({ name: 'a.heic', type: 'image/heic' }));
  assert.ok(!helpers.isSupportedImage({ name: 'notes.txt', type: 'text/plain' }));
  assert.ok(!helpers.isSupportedImage({ name: 'fake.png', type: 'text/plain' }));
});

test('buildOutputName produces portable file names', () => {
  assert.equal(helpers.buildOutputName('photo', '-opt', 'webp'), 'photo-opt.webp');
  assert.equal(helpers.buildOutputName('a/b\\c:d*e?"f<g>h|', '', 'png'), 'a_b_c_d_e__f_g_h_.png');
  assert.equal(helpers.buildOutputName('../../etc/passwd', '', 'jpg'), '.._.._etc_passwd.jpg');
  assert.equal(helpers.buildOutputName('trailing. . ', '', 'jpg'), 'trailing.jpg');
  assert.equal(helpers.buildOutputName('   ', '', 'webp'), 'image.webp');
  assert.equal(helpers.buildOutputName('CON', '', 'webp'), 'CON_.webp');
  assert.equal(helpers.buildOutputName('lpt1', '.backup', 'png'), 'lpt1_.backup.png');
  assert.equal(helpers.buildOutputName('console', '', 'png'), 'console.png');
  assert.ok(helpers.buildOutputName('x'.repeat(400), '-opt', 'webp').length <= 255);
  assert.ok(!/[\uD800-\uDBFF]\.webp$/.test(helpers.buildOutputName('a' + '😀'.repeat(150), '', 'webp')));
});

test('dedupeFileNames avoids collisions case-insensitively', () => {
  assert.deepEqual(helpers.dedupeFileNames(['a.webp', 'A.webp', 'a.webp']), ['a.webp', 'A (2).webp', 'a (3).webp']);
  assert.deepEqual(helpers.dedupeFileNames(['a.webp', 'a (2).webp', 'a.webp']), ['a.webp', 'a (2).webp', 'a (3).webp']);
  assert.deepEqual(helpers.dedupeFileNames(['a.webp', 'b.webp'], ['A.WEBP']), ['a (2).webp', 'b.webp']);
});

test('computeTargetSize scales, fits and never upscales', () => {
  const base = { scale: 100, maxWidth: null, maxHeight: null };
  assert.deepEqual(helpers.computeTargetSize(4000, 3000, base), { width: 4000, height: 3000, limited: false });
  assert.deepEqual(helpers.computeTargetSize(4000, 3000, { ...base, scale: 50 }), { width: 2000, height: 1500, limited: false });
  assert.deepEqual(helpers.computeTargetSize(4000, 3000, { ...base, maxWidth: 1000 }), { width: 1000, height: 750, limited: false });
  assert.deepEqual(helpers.computeTargetSize(3000, 4000, { ...base, maxWidth: 2000, maxHeight: 1000 }), { width: 750, height: 1000, limited: false });
  assert.deepEqual(helpers.computeTargetSize(800, 600, { ...base, maxWidth: 1920 }), { width: 800, height: 600, limited: false });
  assert.deepEqual(helpers.computeTargetSize(5, 1, { ...base, scale: 10 }), { width: 1, height: 1, limited: false });
});

test('computeTargetSize respects canvas limits', () => {
  const huge = helpers.computeTargetSize(40000, 1000, { scale: 100 });
  assert.equal(huge.width, helpers.MAX_CANVAS_SIDE);
  assert.ok(huge.limited);
  const area = helpers.computeTargetSize(16000, 16000, { scale: 100 });
  assert.ok(area.width * area.height <= helpers.MAX_CANVAS_AREA);
});

test('normalizeSettings rejects invalid persisted values', () => {
  const settings = helpers.normalizeSettings({
    format: 'image/avif', quality: 500, scale: 'abc', maxWidth: -20, maxHeight: '1080.7', suffix: 42, remember: 'yes',
  });
  assert.equal(settings.format, 'image/webp');
  assert.equal(settings.quality, 100);
  assert.equal(settings.scale, 100);
  assert.equal(settings.maxWidth, null);
  assert.equal(settings.maxHeight, 1080);
  assert.equal(settings.suffix, '-opt');
  assert.equal(settings.remember, true);
  assert.deepEqual(helpers.normalizeSettings(null), { ...helpers.DEFAULT_SETTINGS });
  assert.equal(helpers.normalizeSettings({ quality: null }).quality, 80);
});

test('describeSizeChange reports savings and growth honestly', () => {
  assert.deepEqual(helpers.describeSizeChange(1000, 380), { text: '−62%', tone: 'good', percent: -62 });
  assert.deepEqual(helpers.describeSizeChange(1000, 1080), { text: '+8%', tone: 'bad', percent: 8 });
  assert.deepEqual(helpers.describeSizeChange(1000, 1002), { text: '0%', tone: 'neutral', percent: 0 });
  assert.deepEqual(helpers.describeSizeChange(0, 10), { text: '0%', tone: 'neutral', percent: 0 });
});

test('timestampedName', () => {
  assert.equal(
    helpers.timestampedName('webp-utility', 'zip', new Date(2026, 8, 6, 4, 5, 9)),
    'webp-utility-2026-09-06_04-05-09.zip',
  );
});
