'use strict';
// Video oynatıcı taşıma testleri: oynat, kare adımı ve bitiş sonrası geri sarma
// <video> öğesini gerçekten konumlandırmalı (Electron/FFmpeg gerektirmez).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sandbox = { console, document: {} };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of ['shared.js', 'ui.js', 'video.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), sandbox, { filename: file });
}
const { VideoEditor } = sandbox;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

// Kurucu DOM'a bağlandığı için yalnızca prototip yöntemleri sahte bir
// oynatıcıyla çalıştırılır.
function makeEditor({ currentTime = 0, inPoint = 0, outPoint = 10, paused = true } = {}) {
  const video = {
    currentTime,
    paused,
    playCalls: 0,
    pause() { this.paused = true; },
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
  };
  const editor = Object.create(VideoEditor.prototype);
  editor.els = { video };
  editor.state = {
    loaded: true,
    videoBroken: false,
    duration: 10,
    inPoint,
    outPoint,
    currentTime,
    meta: { fps: 25 },
  };
  editor.history = { undo: [], redo: [], lastKind: null, lastAt: 0 };
  editor.updateTimeUI = () => {};
  editor.syncPlayButton = () => {};
  return { editor, video };
}

test('kare adımı videoyu bir kare ileri/geri taşır', () => {
  const { editor, video } = makeEditor({ currentTime: 2 });
  editor.stepFrame(1);
  assert.ok(Math.abs(video.currentTime - 2.04) < 1e-9);
  assert.equal(editor.state.currentTime, video.currentTime);
  editor.stepFrame(-1);
  editor.stepFrame(-1);
  assert.ok(Math.abs(video.currentTime - 1.96) < 1e-9);
});

test('kare adımı videonun sınırlarını aşmaz', () => {
  const { editor, video } = makeEditor({ currentTime: 0 });
  editor.stepFrame(-1);
  assert.equal(video.currentTime, 0);
});

test('kesim sonunda durmuş video oynatınca başlangıca sarılır', () => {
  const { editor, video } = makeEditor({ currentTime: 6, inPoint: 2, outPoint: 6 });
  editor.togglePlay();
  assert.equal(video.currentTime, 2);
  assert.equal(editor.state.currentTime, 2);
  assert.equal(video.playCalls, 1);
});

test('kesim aralığındaki video kaldığı yerden oynar', () => {
  const { editor, video } = makeEditor({ currentTime: 3, inPoint: 2, outPoint: 6 });
  editor.togglePlay();
  assert.equal(video.currentTime, 3);
  assert.equal(video.playCalls, 1);
});

test('video sonuna gelince oynatıcı kesim başına döner', () => {
  const { editor, video } = makeEditor({ currentTime: 10, inPoint: 4, outPoint: 10 });
  editor.onEnded();
  assert.equal(video.currentTime, 4);
  assert.equal(editor.state.currentTime, 4);
});

test('oynatılamayan videoda yalnızca arayüz zamanı değişir', () => {
  const { editor, video } = makeEditor({ currentTime: 2 });
  editor.state.videoBroken = true;
  editor.stepFrame(1);
  assert.equal(video.currentTime, 2);
  assert.ok(Math.abs(editor.state.currentTime - 2.04) < 1e-9);
});

test('giriş noktası çıkışı geçince çıkış sona taşınır', () => {
  const { editor } = makeEditor({ currentTime: 6, inPoint: 1, outPoint: 3 });
  editor.renderTrim = () => {};
  editor.renderSummary = () => {};
  editor.renderOutput = () => {};
  editor.markIn();
  assert.equal(editor.state.inPoint, 6);
  assert.equal(editor.state.outPoint, 10);
  editor.state.currentTime = 8;
  editor.markOut();
  assert.equal(editor.state.inPoint, 6);
  assert.equal(editor.state.outPoint, 8);
  // Çıkış girişten önceye konursa giriş başa alınır
  editor.state.currentTime = 2;
  editor.markOut();
  assert.equal(editor.state.inPoint, 0);
  assert.equal(editor.state.outPoint, 2);
});

test('geri al / yinele kesim değişikliklerini geri getirir', () => {
  const { editor } = makeEditor({ currentTime: 6, inPoint: 1, outPoint: 3 });
  editor.state.segments = [];
  editor.renderTrim = () => {};
  editor.renderSummary = () => {};
  editor.renderOutput = () => {};
  let layers = [];
  editor.textEditor = { setLayers(value) { layers = value; }, getLayers() { return layers; } };
  editor.cancelCrop = () => {};
  editor.ensureEditsQuality = () => {};
  editor.render = () => {};
  editor.renderSubtitles = () => {};
  editor.markIn();
  editor.state.currentTime = 8;
  editor.markOut();
  assert.equal(editor.state.outPoint, 8);
  editor.undo();
  assert.equal(editor.state.inPoint, 6);
  assert.equal(editor.state.outPoint, 10);
  editor.undo();
  assert.equal(editor.state.inPoint, 1);
  assert.equal(editor.state.outPoint, 3);
  editor.undo(); // geçmiş boşken bir şey değişmez
  assert.equal(editor.state.inPoint, 1);
  editor.redo();
  editor.redo();
  assert.equal(editor.state.inPoint, 6);
  assert.equal(editor.state.outPoint, 8);
  // Yeni bir değişiklik yinelenecekleri siler
  editor.undo();
  editor.state.currentTime = 9;
  editor.markOut();
  assert.equal(editor.history.redo.length, 0);
});

test('bölümler sıralanır ve örtüşenler birleşir', () => {
  const { editor } = makeEditor();
  assert.deepEqual(
    JSON.parse(JSON.stringify(editor.normalizeSegments([{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 2, end: 4 }, { start: 8, end: 8.01 }]))),
    [{ start: 1, end: 4 }, { start: 5, end: 7 }],
  );
});

if (!process.exitCode) console.log(`VIDEO-TRANSPORT-TEST-OK (${passed} kontrol)`);
