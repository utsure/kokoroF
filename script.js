// script.js（統合版）
// ココロカメラ：F値→明暗(1/f²)・BPM→SS(1/BPM秒)・軽量プレビュー/保存
// + アルバム（localStorage永続）+ ギャラリーモーダル + ライトボックス見返し
document.addEventListener('DOMContentLoaded', () => {
  // ====== 画面管理 ======
  const screens = {
    initial: document.getElementById('screen-initial'),
    introduction: document.getElementById('screen-introduction'),
    fvalue: document.getElementById('screen-fvalue-input'),
    bpm: document.getElementById('screen-bpm'),
    camera: document.getElementById('screen-camera'),
  };
  function showScreen(key) {
    Object.values(screens).forEach(s => s?.classList.remove('active'));
    Object.values(screens).forEach(s => s?.setAttribute('aria-hidden','true'));
    screens[key]?.classList.add('active');
    screens[key]?.setAttribute('aria-hidden','false');
  }

  // ====== 文言 ======
  const T = {
    appTitle: "ココロカメラ",
    splashTagline: "あなたの心のシャッターを切る",
    start: "はじめる",
    fInputTitle: "今の心の状態に合わせて<br>円を広げたり縮めたりしてください",
    fHint1: "F値が小さい=開放的",
    fHint2: "F値が大きい＝閉鎖的",
    decide: "決定",
    bpmTitle: "ココロシャッタースピード",
    bpmPrep_html: 'カメラに<strong>指先を軽く当てて</strong>ください<br>赤みの変化から心拍数を測定します',
    bpmReady: "準備ができたら計測開始を押してください",
    bpmStart: "計測開始",
    skip: "スキップ",
    switchCam: "切り替え",
    shoot: "撮影",
    info: "ギャラリー",
    bpmMeasuring: (remain) => `計測中… 残り ${remain} 秒`,
    bpmResult: (bpm) => `推定BPM: ${bpm}`,
    cameraError: "カメラを起動できません。端末の設定からカメラ権限を許可してください。"
  };
  function applyTexts(dict) {
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.dataset.i18n;
      const val = dict[key];
      if (typeof val === "string") el.textContent = val;
    });
    document.querySelectorAll("[data-i18n-html]").forEach(el => {
      const key = el.dataset.i18nHtml;
      const val = dict[key];
      if (typeof val === "string") el.innerHTML = val;
    });
  }
  applyTexts(T);

  // Canvas2D の filter サポート検出
  const CANVAS_FILTER_SUPPORTED = (() => {
    try {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      return ctx && ('filter' in ctx);
    } catch { return false; }
  })();

  // ====== 要素参照 ======
  const video = document.getElementById('video');
  const rawCanvas = document.getElementById('canvas');

const previewCanvas = document.createElement('canvas');
previewCanvas.id = 'preview-canvas';           // ★これを追加
const previewCtx = previewCanvas.getContext('2d');
if (screens.camera) {
  // CSSに任せるので style は最小限（z-indexはCSSに合わせ1でもOK）
  previewCanvas.style.zIndex = '1';
  screens.camera.insertBefore(previewCanvas, screens.camera.firstChild);
}

  // ====== カメラ/プレビュー制御 ======
  const PREVIEW_FPS = 15;
  let lastPreviewTs = 0;
  let currentStream = null;
  let isFrontCamera = false;
  let rafId = null;
  let currentFacing = 'environment';   // 'user' or 'environment'
  const FORCE_UNMIRROR_FRONT = TRUE_BOOL_FIX(); // 小文字 true/false を安全に固定

  function TRUE_BOOL_FIX(){ return true; }

  // --- BPM→プレビューの blur(px) 非線形マッピング（60で強・100でゼロ） ---
function bpmToBlurPx(bpm, min=60, max=100) {
  const b = Math.max(min, Math.min(max, bpm || min));
  const t = (max - b) / (max - min);           // 60→1, 100→0
  return Math.round( t * 10 + (t*t) * 12 );    // 最大 ~22px
}

let currentPreviewBlurPx = 0;
function applyPreviewBlur(bpm) {
  currentPreviewBlurPx = bpmToBlurPx(bpm);
  updatePreviewFilter();
}

  function startPreviewLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    const render = (ts) => {
      if (video.videoWidth && video.videoHeight) {
        if (previewCanvas.width !== video.videoWidth || previewCanvas.height !== video.videoHeight) {
          previewCanvas.width  = video.videoWidth;
          previewCanvas.height = video.videoHeight;
        }
        const interval = 1000 / PREVIEW_FPS;
        if ((ts - lastPreviewTs) >= interval) {
          lastPreviewTs = ts;

          previewCtx.save();
          previewCtx.imageSmoothingEnabled = true;

          // クリア
          previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

          // フロント自動ミラーを打ち消す
          if (currentFacing === 'user' && FORCE_UNMIRROR_FRONT) {
            previewCtx.translate(previewCanvas.width, 0);
            previewCtx.scale(-1, 1);
          }
          // 素の絵
          previewCtx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);

          // filter未対応端末→明暗は手動合成へ任せる
          if (!CANVAS_FILTER_SUPPORTED) {
            applyBrightnessComposite(
              previewCtx,
              currentBrightness,
              previewCanvas.width,
              previewCanvas.height,
              CONTRAST_GAIN
            );
          }
          previewCtx.restore();
        }
      }
      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);
  }
  function stopPreviewLoop(){ if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  async function startCamera(facingMode = 'environment') {
    try {
      if (currentStream) currentStream.getTracks().forEach(t => t.stop());
      const constraints = {
        video: {
          facingMode: facingMode === 'environment' ? { ideal: 'environment' } : 'user',
          width: { ideal: 1280 }, height: { ideal: 720 }
        },
        audio: false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      currentStream = stream;
      isFrontCamera = (facingMode === 'user');
      currentFacing = facingMode;
      video.style.display = 'none'; // videoは非表示、プレビューCanvasに描く
      startPreviewLoop();
      updatePreviewFilter();
    } catch (err) {
      console.error('カメラエラー:', err);
      alert(T.cameraError);
    }
  }

  // ====== F値→明暗 (強化版 1/f² + 共通フィルタ) ======
let selectedFValue = 22.0;          // お好みで。初期Fはレンジ内ならOK
const MIN_F = 2.0, MAX_F = 22.0;   // ★ここを 2–22 に

  const BRIGHT_MIN = 0.12;      // 暗側の下限
  const BRIGHT_MAX = 3.6;       // 明側の上限
  const BRIGHT_STRENGTH = 1.35; // カーブ強調
  const CONTRAST_GAIN = 1.10;   // 少しだけコントラスト

  let currentBrightness = 1.0;
  const clamp = (x,a,b)=>Math.min(Math.max(x,a),b);

  function brightnessFromF(f){
    const t = Math.max(0, Math.min(1, (f - MIN_F) / (MAX_F - MIN_F)));
    const t2 = Math.pow(t, BRIGHT_STRENGTH);
    const lnMin = Math.log(BRIGHT_MIN), lnMax = Math.log(BRIGHT_MAX);
    return Math.exp( lnMax + (lnMin - lnMax) * t2 );
  }
  function buildFilterString(){
    return `brightness(${currentBrightness}) contrast(${CONTRAST_GAIN})`;
  }
  
  // ②-A: プレビュー用スタイルフィルタ（明るさ/コントラスト + BPMブラー）
function updatePreviewFilter(){
  if (!previewCanvas) return;
  if (CANVAS_FILTER_SUPPORTED) {
    previewCanvas.style.filter =
      `${buildFilterString()} blur(${currentPreviewBlurPx || 0}px)`;
  } else {
    // 手動合成モード時はCSSフィルタを使わない
    previewCanvas.style.filter = 'none';
  }
}

  function applyFnumberLight(f){
   currentBrightness = brightnessFromF(f);
   updatePreviewFilter(); // ← ここだけに集約
  }

  // ====== 画面遷移 ======
  document.getElementById('initial-next-btn')?.addEventListener('click', () => showScreen('fvalue'));

  // ====== F値（ピンチ操作） ======
  const apertureControl = document.querySelector('.aperture-control');
  const fValueDisplay   = document.getElementById('f-value-display');
  const apertureInput   = document.getElementById('aperture');

  const MIN_SIZE = 100, MAX_SIZE = 250;
  const fToSize = f => MIN_SIZE + ((MAX_F - f) / (MAX_F - MIN_F)) * (MAX_SIZE - MIN_SIZE);
  const sizeToF = size => MAX_F - ((size - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)) * (MAX_F - MIN_F);

// ---- F値UIの一括更新（表示は整数、サイズは滑らかに追従）----
function updateApertureUI(f) {
  const clamped = clamp(Number(f), MIN_F, MAX_F);
  // サイズは実数の displayFValue で“にゅるっ”と変化
  const size = fToSize(clamped);
  apertureControl.style.width = apertureControl.style.height = `${size}px`;

  // 表示は整数で統一
  const intF = Math.round(clamped);
  fValueDisplay.textContent = String(intF);
  apertureInput.value = String(intF);

  // 明るさも追従（内部は連続値でもOK）
  applyFnumberLight(clamped);
}

// ---- スムージング（余韻ナシ版）---------------------------------
let displayFValue = selectedFValue;   // 表示に使う連続値
let targetFValue  = selectedFValue;   // 目標（整数）
let smoothRafId   = null;
let lastTs        = 0;
let isPinching    = false;            // ピンチ中フラグ（タッチリスナから参照）

const PINCH_FOLLOW = 0.5;   // ピンチ中の追従率（0.35〜0.6で調整）
const EASE_SPEED   = 12;    // 指を離した後の短い収束速度（大きいほど速い）

function smoothLoop(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.032, (ts - lastTs) / 1000);
  lastTs = ts;

  // 余韻を残さない：指数平滑で一気に寄せる（ばね物理は使わない）
  const delta = targetFValue - displayFValue;
  displayFValue += delta * Math.min(1, EASE_SPEED * dt);

  // 収束したら完全停止
  if (Math.abs(delta) < 0.02) {
    displayFValue = targetFValue;
    smoothRafId = null;
  } else {
    smoothRafId = requestAnimationFrame(smoothLoop);
  }
  updateApertureUI(displayFValue);
}

function setTargetFValue(nextF, opts = {}) {
  const intF = Math.round(clamp(Number(nextF), MIN_F, MAX_F));
  targetFValue = intF;

  if (isPinching) {
    // ピンチ中はその場追従（余韻なし）
    displayFValue += (targetFValue - displayFValue) * PINCH_FOLLOW;
    updateApertureUI(displayFValue);
    return;
  }

  if (opts.immediate) {
    // 即時反映が欲しい場面用
    displayFValue = targetFValue;
    updateApertureUI(displayFValue);
    return;
  }

  // 指を離した直後：短いイーズだけかける（延々は回さない）
  if (!smoothRafId) { lastTs = 0; smoothRafId = requestAnimationFrame(smoothLoop); }
}

if (apertureControl && fValueDisplay && apertureInput) {
  updateApertureUI(selectedFValue);
}

let lastPinchDistance = 0;

document.addEventListener('touchstart', e => {
  if (!screens.fvalue?.classList.contains('active')) return;
  if (e.touches.length === 2) {
    e.preventDefault();
    isPinching = true;                           // ← 追加
    if (smoothRafId) { cancelAnimationFrame(smoothRafId); smoothRafId = null; }
    lastPinchDistance = Math.hypot(
      e.touches[0].pageX - e.touches[1].pageX,
      e.touches[0].pageY - e.touches[1].pageY
    );
    document.documentElement.style.touchAction = 'none';
  }
}, { passive: false });

document.addEventListener('touchmove', e => {
  if (!screens.fvalue?.classList.contains('active')) return;
  if (e.touches.length === 2 && lastPinchDistance > 0) {
    e.preventDefault();

    const dist = Math.hypot(
      e.touches[0].pageX - e.touches[1].pageX,
      e.touches[0].pageY - e.touches[1].pageY
    );
    const scale = dist / lastPinchDistance;   // >1: アウト, <1: イン
    const pinchPower = Math.log2(scale);

    // ★感度を控えめに（以前より小さめ）
    const SENS = 10;                          // 9〜12がおすすめ
    const nextTarget = targetFValue - pinchPower * SENS;

    setTargetFValue(nextTarget);              // ← ピンチ中は即追従で余韻ナシ
    lastPinchDistance = dist;
  }
}, { passive: false });

document.addEventListener('touchend', e => {
  if (!screens.fvalue?.classList.contains('active')) return;
  if (e.touches.length < 2) {
    lastPinchDistance = 0;
    isPinching = false;                       // ← 指を離した
    document.documentElement.style.touchAction = '';

    // ★スナップして完全停止（余韻なし）
    targetFValue  = Math.round(displayFValue);
    displayFValue = targetFValue;
    updateApertureUI(displayFValue);
    if (smoothRafId) { cancelAnimationFrame(smoothRafId); smoothRafId = null; }
  }
}, { passive: false });

document.getElementById('f-value-decide-btn')?.addEventListener('click', async () => {
  const raw = parseFloat(apertureInput.value);
  const f = Math.round(clamp(raw, MIN_F, MAX_F));   // ← 整数に丸めて決定
  selectedFValue = f;
  document.querySelector('.aperture-control')?.setAttribute('aria-valuenow', String(f));
  applyFnumberLight(f);
  updateCameraHudF();
  showScreen('bpm');
  await startBpmCamera();
});

  // ====== BPM 計測 ======
  const bpmVideo = document.getElementById('bpm-video');
  const bpmCanvas = document.getElementById('bpm-canvas');
  const bpmCtx = bpmCanvas.getContext('2d');
  const bpmStatus = document.getElementById('bpm-status');
  let bpmStream = null;
  let bpmLoopId = null;
  const defaultBpm = 60;

  // 制限
  const BPM_MIN = 60;
  const BPM_MAX = 100;
  let lastMeasuredBpm = 0;

  async function startBpmCamera() {
    try {
      if (bpmStream) bpmStream.getTracks().forEach(t => t.stop());
      bpmStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width:{ideal:640}, height:{ideal:480} },
        audio: false
      });
      bpmVideo.srcObject = bpmStream;
      await bpmVideo.play();
      bpmStatus.textContent = T.bpmReady;
    } catch (e) {
      console.error(e);
      bpmStatus.textContent = 'カメラ起動に失敗しました。スキップも可能です。';
    }
  }
  function stopBpmCamera() {
    if (bpmLoopId) cancelAnimationFrame(bpmLoopId);
    bpmLoopId = null;
    if (bpmStream) {
      bpmStream.getTracks().forEach(t => t.stop());
      bpmStream = null;
    }
  }

  function estimateBpmFromSeries(values, durationSec) {
    const k = 4;
    const smooth = values.map((_, i, arr) => {
      let s = 0, c = 0;
      for (let j = -k; j <= k; j++) {
        const idx = i + j;
        if (arr[idx] != null) { s += arr[idx]; c++; }
      }
      return s / c;
    });
    const diffs = smooth.map((v, i) => i ? v - smooth[i - 1] : 0);
    const peaks = [];
    for (let i = 1; i < diffs.length - 1; i++) {
      if (diffs[i - 1] > 0 && diffs[i] <= 0) peaks.push(i);
    }
    if (peaks.length < 2) return null;
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i] - peaks[i - 1]);
    const avgInterval = intervals.reduce((a,b)=>a+b,0) / intervals.length;
    const fps = values.length / durationSec;
    const bpm = Math.round((60 * fps) / avgInterval);
    if (!isFinite(bpm) || bpm <= 20 || bpm >= 220) return null;
    return bpm;
  }

  async function measureBpm(durationSec = 15) {
    if (!bpmVideo) return;
    const vals = [];
    const start = performance.now();
    const loop = () => {
      if (!bpmVideo.videoWidth || !bpmVideo.videoHeight) {
        bpmLoopId = requestAnimationFrame(loop); return;
      }
      const w = 160, h = 120;
      bpmCanvas.width = w; bpmCanvas.height = h;
      bpmCtx.drawImage(
        bpmVideo,
        (bpmVideo.videoWidth - w) / 2, (bpmVideo.videoHeight - h) / 2, w, h,
        0, 0, w, h
      );
      const frame = bpmCtx.getImageData(0, 0, w, h).data;
      let sumR = 0;
      for (let i = 0; i < frame.length; i += 4) sumR += frame[i];
      vals.push(sumR / (frame.length / 4));

      const t = (performance.now() - start) / 1000;
      if (t < durationSec) {
        const remain = Math.max(0, durationSec - t);
        bpmStatus.textContent = T.bpmMeasuring(Math.ceil(remain));
        bpmLoopId = requestAnimationFrame(loop);
      } else {
        const estimated = estimateBpmFromSeries(vals, durationSec) ?? defaultBpm;
        const clamped = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(estimated)));
        lastMeasuredBpm = clamped;
        bpmStatus.textContent = T.bpmResult(clamped);
        setTimeout(async () => {
          showScreen('camera');
          updateCameraHudF();           // ★これで統一
          updateCameraHudBpm();
          applyPreviewBlur(lastMeasuredBpm);  

          
          await startCamera('environment');
        }, 800);

        stopBpmCamera();
      }
    };
    loop();
  }
  document.getElementById('bpm-start-btn')?.addEventListener('click', () => {
    bpmStatus.textContent = '計測中…';
    measureBpm(15);
  });
  document.getElementById('bpm-skip-btn')?.addEventListener('click', async () => {
    lastMeasuredBpm = defaultBpm;
    stopBpmCamera();
    showScreen('camera');
    updateCameraHudF();
    updateCameraHudBpm();
    applyPreviewBlur(lastMeasuredBpm); 
    await startCamera('environment');
  });

  // ====== SS と HUD ======
  const shutterBtn = document.getElementById('camera-shutter-btn');
  const bpmHud = document.getElementById('bpm-display-camera');

  function updateCameraHudF() {
  const fHud = document.getElementById('fvalue-display-camera');
  if (fHud) fHud.textContent = `F: ${Math.round(Number(selectedFValue))}`;
  }
  
  function updateCameraHudBpm() {
    const bpm = lastMeasuredBpm || defaultBpm;
    if (bpmHud) bpmHud.textContent = `BPM: ${bpm || '--'}`;
  }
  updateCameraHudF();
  updateCameraHudBpm();

  // 残像フェード（低BPM→長／高BPM→短）
  function trailFadeFromBpm(bpm) {
    const B = Math.max(1, bpm || 60);
    const t = clamp((B - 60) / (200 - 60), 0, 1);
    return clamp(0.06 + (0.20 - 0.06) * t, 0.04, 0.24);
  }
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  
 // ⑤ 保存画像向け：方向性モーションブラー（少ないパスで派手＆軽量）
function applyMotionBlurAfterCapture(ctx, video, w, h, bpm, facing, brightnessFilterCSS) {
  const B = Math.max(60, Math.min(100, bpm || 60));
  const t = (100 - B) / 40;              
  // t: 60BPM→1、100BPM→0

  // 📸 パス数：低BPMで最大7枚、高BPMで1枚
  const passes = 1 + Math.round(t * 6);  
  // 📸 オフセット量も低BPMで大きく
  const maxOffset = Math.round((w + h) * 0.006 * (0.5 + t));

  // 📸 ブラー強さ：60BPM→5px、100BPM→0px
  const blurRadius = Math.round(5 * t);

  const angle = Math.random() * Math.PI * 2;
  const dxUnit = Math.cos(angle);
  const dyUnit = Math.sin(angle);

  const useCanvasFilter = CANVAS_FILTER_SUPPORTED && brightnessFilterCSS;
  const prevFilter = ctx.filter;

  // 🎨 フィルター設定
  if (blurRadius > 0) {
    ctx.filter = `blur(${blurRadius}px)` + (useCanvasFilter ? ` ${brightnessFilterCSS}` : '');
  } else if (useCanvasFilter) {
    ctx.filter = brightnessFilterCSS;
  }

  ctx.globalAlpha = 1 / passes;

  // 📷 実際の重ね描画（高BPMなら1枚だけ）
  for (let i = 0; i < passes; i++) {
    const k = passes === 1 ? 0 : i / (passes - 1);
    const offset = Math.round(maxOffset * (k * k));
    const dx = Math.round(dxUnit * offset);
    const dy = Math.round(dyUnit * offset);

    if (facing === 'user' && FORCE_UNMIRROR_FRONT) {
      ctx.save();
      ctx.translate(w, 0); ctx.scale(-1, 1);
      ctx.drawImage(video, dx, dy, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(video, dx, dy, w, h);
    }
  }

  ctx.globalAlpha = 1;
  ctx.filter = prevFilter || 'none';
}

  // ====== ファイル名 ======
  function safeNum(n) { return String(n).replace('.', '-'); }
  function buildFilename({ fValue, bpm, when = new Date(), who = 'anon', room = 'room' }) {
    const pad = (x) => x.toString().padStart(2, '0');
    const y = when.getFullYear(), m = pad(when.getMonth()+1), d = pad(when.getDate());
    const hh = pad(when.getHours()), mm = pad(when.getMinutes()), ss = pad(when.getSeconds());
    const fStr = String(Math.round(Number(fValue)));
    const bpmStr = (bpm == null || isNaN(bpm)) ? '--' : Math.round(bpm);
    return `cocoro_${y}-${m}-${d}_${hh}-${mm}-${ss}_${room}_${who}_F${fStr}_BPM${bpmStr}.png`;
  }

  // カメラ切替
  document.getElementById('camera-switch-btn')?.addEventListener('click', async () => {
    const next = (currentFacing === 'user') ? 'environment' : 'user';
    await startCamera(next);
  });

  // ====== ここから：アルバム（localStorage永続） ======
  const infoBtn = document.getElementById('camera-info-btn');
  const galleryModal = document.getElementById('gallery-modal');
  const galleryBackdrop = galleryModal?.querySelector('.cc-modal-backdrop');
  const galleryCloseBtn = document.getElementById('gallery-close-btn');
  const galleryGrid = document.getElementById('gallery-grid');

  // ライトボックス（存在しない場合は縮小版でフォールバック）
  const viewer = document.getElementById('viewer-overlay');
  const viewerImg = document.getElementById('viewer-img');
  const viewerMeta = document.getElementById('viewer-meta');
  const viewerPrev = document.getElementById('viewer-prev');
  const viewerNext = document.getElementById('viewer-next');
  const viewerClose = document.getElementById('viewer-close');
  const viewerShare = document.getElementById('viewer-share');
  const viewerDelete = document.getElementById('viewer-delete');
  const viewerWrap = document.getElementById('viewer-img-wrap');
  
// === メモUI（なければ自動生成） ===
let viewerNote = document.getElementById('viewer-note');
let viewerNoteSave = document.getElementById('viewer-note-save');

(function ensureNoteUI(){
  if (!viewer || !viewerMeta) return; // ビューア未設置なら何もしない

  // textarea
  if (!viewerNote) {
    viewerNote = document.createElement('textarea');
    viewerNote.id = 'viewer-note';
    viewerNote.placeholder = 'この写真のメモ…';
    viewerNote.autocomplete = 'off';
    viewerNote.spellcheck = false;
    viewerMeta.insertAdjacentElement('afterend', viewerNote);
  }

  // 保存ボタン（右下固定・拡大時だけ表示）
  if (!viewerNoteSave) {
    viewerNoteSave = document.createElement('button');
    viewerNoteSave.id = 'viewer-note-save';
    viewerNoteSave.textContent = '保存';
    viewerNoteSave.type = 'button';
    viewerNoteSave.className = 'floating-save-btn'; // ここに is-visible は付けない
    document.body.appendChild(viewerNoteSave);


    // クリックでメモ保存
    viewerNoteSave.addEventListener('click', () => {
      try {
        if (!Album || !Album.list || typeof Album.list[AlbumIdx.current] === 'undefined') return;
        const it = Album.list[AlbumIdx.current];
        it.note = (viewerNote?.value ?? '').trim();

        if (typeof Album.save === 'function') {
          Album.save(); // localStorage へ反映
        } else {
          // フォールバック保存
          const out = Album.list.map(row => ({
            src: row.src, f: row.f, bpm: row.bpm, ts: row.ts,
            lat: row.lat ?? null, lon: row.lon ?? null,
            facing: row.facing ?? 'environment',
            note: (typeof row.note === 'string' ? row.note : '')
          }));
          try { localStorage.setItem('kokoro_album', JSON.stringify(out)); } catch(e){}
        }

        viewerNoteSave.textContent = '保存済み';
        setTimeout(()=> viewerNoteSave.textContent = '保存', 900);
      } catch {}
    });
  }
})(); // ← IIFEはここで閉じます

function showSaveBtn() { viewerNoteSave?.classList.add('is-visible'); }
function hideSaveBtn() { viewerNoteSave?.classList.remove('is-visible'); }

  
  const AlbumIdx = { current: -1 };

  const Album = (() => {
    let list = [];   // 新しい順
    let idx = -1;
    const KEY_NEW = 'kokoro_album';
    const KEY_OLD = 'fshutter_album'; // 旧形式互換

function buildMetaText(it, i, total){
  // 撮影順番号：古いほど小さい番号 → oldest=1, newest=total
  const order = total - i;
  const bpmStr = (typeof it.bpm === 'number' && it.bpm >= 0) ? `${it.bpm} BPM` : `--- BPM`;
  return `#${order}　F${Math.round(it.f)}　${bpmStr}`;
}

function thumb(item, i){
  const d = document.createElement('div'); d.className='cc-thumb'; d.dataset.index=String(i);
  const im = document.createElement('img'); im.src=item.src; im.alt = item.filename||'photo';
  const m = document.createElement('div'); m.className='meta'; 
  m.textContent = buildMetaText(item, i, list.length); // ← ここ変更
  d.appendChild(im); d.appendChild(m);
  d.addEventListener('click', () => openViewer(i));
  return d;
}
    
    function renderGrid(){
      if (!galleryGrid) return;
      galleryGrid.innerHTML = '';
      list.forEach((it,i) => galleryGrid.appendChild(thumb(it,i)));
    }
function save(){
  const out = list.map(it => ({
    src: it.src,
    f: it.f,
    bpm: it.bpm,
    ts: it.ts,
    lat: it.lat ?? null,
    lon: it.lon ?? null,
    facing: it.facing ?? 'environment',
    note: (typeof it.note === 'string' ? it.note : '') // ← 追加
  }));
  try { localStorage.setItem(KEY_NEW, JSON.stringify(out)); } catch(e){ console.warn('保存失敗', e); }
}

    function parseOldMeta(meta){
      const it={};
      const f = meta?.match(/F\s*([0-9.]+)/i);
      const b = meta?.match(/([0-9]{2,3})\s*BPM/i);
      const la= meta?.match(/Lat:([\-0-9.]+)/i);
      const lo= meta?.match(/Lon:([\-0-9.]+)/i);
      it.f = f ? Number(f[1]) : 22;
      it.bpm = b ? Number(b[1]) : null;
      it.lat = la ? Number(la[1]) : null;
      it.lon = lo ? Number(lo[1]) : null;
      it.ts = Date.now();
      return it;
    }
    function load(){
      list = [];
      // 新形式
      const savedNew = localStorage.getItem(KEY_NEW);
      if (savedNew){
        try { list = JSON.parse(savedNew) || []; } catch(e){ console.warn(e); }
      }
      // 旧形式 {src, meta}
      if (!list.length){
        const savedOld = localStorage.getItem(KEY_OLD);
        if (savedOld){
          try {
            const arr = JSON.parse(savedOld) || [];
            list = arr.map(row => {
              const p = parseOldMeta(row.meta||'');
              return { src: row.src, f: p.f, bpm: p.bpm, ts: p.ts, lat:p.lat, lon:p.lon, facing:'environment', note: '' };
            });
          } catch(e){ console.warn(e); }
        }
      }
      list.sort((a,b)=>(b.ts||0)-(a.ts||0));
      list = list.map(it => ({
       ...it,
       f: clamp(Number(it.f ?? MAX_F), MIN_F, MAX_F),
       note: typeof it.note === 'string' ? it.note : '' 
      }));
      renderGrid();
    }
    function add(item){
  list.unshift({ ...item, note: item.note ?? '' }); // ← noteを補完
  renderGrid();
  save();
}
function openModal(){
  if (!galleryModal) return;
  galleryModal.classList.remove('hidden');
  galleryModal.setAttribute('aria-hidden','false');
  hideSaveBtn();                 // ← ここだけに統一
}

function closeModal(){
  if (!galleryModal) return;
  galleryModal.classList.add('hidden');
  galleryModal.setAttribute('aria-hidden','true');
  hideSaveBtn();                 // ← ここだけに統一
  AlbumIdx.current = -1;
}

// ===== ライトボックス =====
// 変形・パン
let vScale=1, vX=0, vY=0, vLastPinch=0, vPan=false, vLX=0, vLY=0, vTapTime=0;
function applyViewerTransform(){ if (viewerImg) viewerImg.style.transform = `translate(${vX}px, ${vY}px) scale(${vScale})`; }
function resetViewerTransform(){ vScale=1; vX=0; vY=0; applyViewerTransform(); }

function openViewer(i){
  if (!list.length) return;
  if (!viewer || !viewerImg || !viewerMeta) { window.open(list[i].src, '_blank'); return; }
  idx = Math.max(0, Math.min(i, list.length-1));
  AlbumIdx.current = idx;                        // 共有インデックス更新
  const it = list[idx];
  viewerImg.src = it.src;

  viewerMeta.textContent = buildMetaText(it, idx, list.length);
  resetViewerTransform();
  viewer.setAttribute('aria-hidden', 'false');   // 開く

  if (viewerNote) viewerNote.value = it.note || '';
  showSaveBtn();                                  // 拡大時だけ表示
}

function closeViewer(){
  if (viewer){
    viewer.setAttribute('aria-hidden', 'true');  // 閉じる
  }
  AlbumIdx.current = -1;
  hideSaveBtn();                                  // 必ず隠す
}

// UI結線
infoBtn?.addEventListener('click', openModal);
galleryBackdrop?.addEventListener('click', closeModal);
galleryCloseBtn?.addEventListener('click', closeModal);

viewerClose && (viewerClose.onclick = () => closeViewer());
viewerPrev && (viewerPrev.onclick  = () => { if (idx>0) openViewer(idx-1); });
viewerNext && (viewerNext.onclick  = () => { if (idx<list.length-1) openViewer(idx+1); });

window.addEventListener('keydown', (e) => {
  if (!viewer || viewer.getAttribute('aria-hidden')==='true') return;
  if (e.key==='Escape') closeViewer();
  if (e.key==='ArrowLeft') viewerPrev?.click();
  if (e.key==='ArrowRight') viewerNext?.click();
});

viewerShare && (viewerShare.onclick = async () => {
  try {
    const it = list[idx]; const blob = await fetch(it.src).then(r=>r.blob());
    const file = new File([blob], `Kokoro_${it.ts||Date.now()}.jpg`, {type:'image/jpeg'});
    if (navigator.share && navigator.canShare?.({files:[file]})) await navigator.share({ files:[file], title: 'アルバム写真' });
    else { const a=document.createElement('a'); a.href=it.src; a.download=file.name; a.click(); }
  } catch { alert('共有に失敗しました'); }
});

viewerDelete && (viewerDelete.onclick = () => {
  if (!confirm('この写真を削除しますか？')) return;
  if (idx<0) return;
  list.splice(idx,1); save(); renderGrid();
  if (!list.length) closeViewer(); else openViewer(Math.min(idx, list.length-1));
});

viewerWrap && viewerWrap.addEventListener('touchstart', e => {
  if (e.touches.length===2){ const [a,b]=e.touches; vLastPinch=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); }
  else if (e.touches.length===1){ vPan=true; vLX=e.touches[0].clientX; vLY=e.touches[0].clientY; }
}, {passive:true});

viewerWrap && viewerWrap.addEventListener('touchmove', e => {
  if (e.touches.length===2 && vLastPinch){
    const [a,b]=e.touches; const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    vScale=Math.min(4, Math.max(1, vScale+(d-vLastPinch)*0.005)); vLastPinch=d; applyViewerTransform();
  } else if (e.touches.length===1 && vPan){
    const x=e.touches[0].clientX, y=e.touches[0].clientY; vX+=x-vLX; vY+=y-vLY; vLX=x; vLY=y; applyViewerTransform();
  }
}, {passive:true});

viewerWrap && viewerWrap.addEventListener('touchend', e => {
  if (e.touches.length===0){
    if (vScale===1 && Math.abs(vX)>60){ if (vX<0) viewerNext?.click(); else viewerPrev?.click(); }
    vLastPinch=0; vPan=false; vX=0; vY=0; applyViewerTransform();
  }
}, {passive:true});

viewerWrap && viewerWrap.addEventListener('touchstart', e => {
  const now=performance.now();
  if (now - vTapTime < 250 && e.touches.length===1){
    if (vScale===1) { vScale=2; } else { resetViewerTransform(); return; }
    applyViewerTransform(); vTapTime=0;
  } else vTapTime=now;
}, {passive:true});

    return {
  add,
  load,
  openModal,
  closeModal,
  openViewer,
  save,
  get list() { return list; }   // ← これ！
};
  })();

  // ====== ここまで：アルバム ======

  // ====== シャッター処理（1/BPMの擬似露光 + 1/f²の明暗を焼き込み） ======
  shutterBtn?.addEventListener('click', async () => {
    try {
      if (!video.videoWidth) return;

      const maxW = 1280;
      const scale = Math.min(1, maxW / video.videoWidth);

      const captureCanvas = rawCanvas || document.createElement('canvas');
      captureCanvas.width  = Math.round(video.videoWidth  * scale);
      captureCanvas.height = Math.round(video.videoHeight * scale);
      const ctx = captureCanvas.getContext('2d', { willReadFrequently: false });

      const sec = (1 / Math.max(1, (lastMeasuredBpm || defaultBpm)));  // 1/BPM 秒
      const frameRate = 40;
      const frameCount = Math.max(1, Math.round(sec * frameRate));
      const fade = trailFadeFromBpm(lastMeasuredBpm || defaultBpm);

      ctx.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
      for (let i = 0; i < frameCount; i++) {
        // 残像フェード
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(0,0,0,${fade})`;
        ctx.fillRect(0, 0, captureCanvas.width, captureCanvas.height);

        if (CANVAS_FILTER_SUPPORTED) {
          ctx.filter = buildFilterString(); // brightness/contrast
          ctx.globalAlpha = 1;
          if (currentFacing === 'user' && FORCE_UNMIRROR_FRONT) {
            ctx.save();
            ctx.translate(captureCanvas.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
            ctx.restore();
          } else {
            ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
          }
          ctx.filter = 'none';
        } else {
          ctx.globalAlpha = 1;
          if (currentFacing === 'user' && FORCE_UNMIRROR_FRONT) {
            ctx.save();
            ctx.translate(captureCanvas.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
            ctx.restore();
          } else {
            ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
          }
          applyBrightnessComposite(
            ctx,
            currentBrightness,
            captureCanvas.width,
            captureCanvas.height,
            CONTRAST_GAIN
          );
        }
        await sleep(1000 / frameRate);
      }
      ctx.globalAlpha = 1;
      
      // ⑤ 仕上げ：BPMに応じた方向性モーションブラーを軽く追加
applyMotionBlurAfterCapture(
  ctx,
  video,
  captureCanvas.width,
  captureCanvas.height,
  (lastMeasuredBpm || defaultBpm),
  currentFacing,
  (CANVAS_FILTER_SUPPORTED ? buildFilterString() : '')
);

// 位置（任意）— ポップアップ回避のため自動リクエストは行わない
let lat = null, lon = null;
// ※ どうしても付けたい場合は別ボタンなど“ユーザー操作時”にだけ取得する

// データURL（アルバム保存用）
const JPEG_QUALITY = 0.85;               // 0.8〜0.9くらいが実用
const dataUrl = captureCanvas.toDataURL('image/jpeg', JPEG_QUALITY);

// アルバムへ即追加（永続化）
const item = {
  src: dataUrl,
  f: Number(selectedFValue),
  bpm: lastMeasuredBpm || defaultBpm,
  ts: Date.now(),
  facing: currentFacing
};
Album.add(item);

    } catch (err) {
      console.error('Capture error:', err);
      alert('撮影に失敗しました。ページを再読み込みしてもう一度お試しください。');
    }
  });

  // ====== 手動合成（filter非対応端末向け）：明るさ＆コントラスト近似 ======
  function applyBrightnessComposite(ctx, brightness, w, h, contrastGain = 1.0){
    // 明るさ：b<1 は黒で multiply、b>1 は白で screen
    if (brightness < 1) {
      const a = Math.max(0, Math.min(1, 1 - brightness));
      if (a > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = a;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    } else if (brightness > 1) {
      const a = Math.max(0, Math.min(1, 1 - (1/brightness)));
      if (a > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = a;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
    // コントラスト：overlay を薄く
    if (Math.abs(contrastGain - 1.0) > 1e-3) {
      const a = Math.min(0.5, (contrastGain - 1.0) * 0.6);
      if (a > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgb(127,127,127)';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
    // 後始末
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ====== 初期表示 ======
  Album.load();                 // ← 過去の写真を復元（新旧フォーマット対応）
  // ギャラリーを開くボタンは Album 側で結線済み
  showScreen('initial');
});







