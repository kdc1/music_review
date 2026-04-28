const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "m4a", "ogg", "aiff", "aif"]);
const MODEL_SR = 16000;
const STATE_VERSION = 1;

const state = {
  audioRoot: null,
  txtRoot: null,
  exportRoot: null,
  audioLabel: "",
  txtLabel: "",
  exportLabel: "",
  tracks: [],
  filtered: [],
  currentIndex: -1,
  analysisCache: {},
  reviews: {},
  queue: [],
  sortScores: new Map(),
  seeking: false,
  analyzingId: "",
};

let audioCtx = null;
let wasmModule = null;
let essentiaCore = null;
let inputExtractor = null;
let musicnnModel = null;
let tagList = [];

const $ = (selector) => document.querySelector(selector);
const els = {
  mountAudio: $("#mountAudio"),
  mountTxt: $("#mountTxt"),
  mountExport: $("#mountExport"),
  audioMountLabel: $("#audioMountLabel"),
  txtMountLabel: $("#txtMountLabel"),
  exportMountLabel: $("#exportMountLabel"),
  downloadJson: $("#downloadJson"),
  uploadJson: $("#uploadJson"),
  loadEssentia: $("#loadEssentia"),
  analyzeMissing: $("#analyzeMissing"),
  useTags: $("#useTags"),
  analysisStatus: $("#analysisStatus"),
  analysisCount: $("#analysisCount"),
  analysisProgress: $("#analysisProgress"),
  analysisCurrent: $("#analysisCurrent"),
  search: $("#searchInput"),
  verdictFilter: $("#verdictFilter"),
  minBpm: $("#minBpm"),
  maxBpm: $("#maxBpm"),
  tagFilter: $("#tagFilter"),
  selectedFile: $("#selectedFile"),
  selectedTitle: $("#selectedTitle"),
  selectedMeta: $("#selectedMeta"),
  sortMode: $("#sortMode"),
  sortSimilar: $("#sortSimilar"),
  trackCount: $("#trackCount"),
  trackList: $("#trackList"),
  audio: $("#audio"),
  seek: $("#seekBar"),
  currentTime: $("#currentTime"),
  duration: $("#duration"),
  prev: $("#prevTrack"),
  next: $("#nextTrack"),
  autoNext: $("#autoNext"),
  addQueue: $("#addQueue"),
  ratingButtons: [...document.querySelectorAll("#ratingButtons button")],
  verdictButtons: [...document.querySelectorAll("#verdictButtons button")],
  userTags: $("#userTags"),
  memo: $("#memo"),
  tabs: [...document.querySelectorAll(".tab")],
  lyricsView: $("#lyricsView"),
  metadataView: $("#metadataView"),
  analysisView: $("#analysisView"),
  queueCount: $("#queueCount"),
  queueList: $("#queueList"),
  playQueue: $("#playQueue"),
  clearQueue: $("#clearQueue"),
  copyPrefix: $("#copyPrefix"),
  copyStart: $("#copyStart"),
  copyPad: $("#copyPad"),
  copyQueue: $("#copyQueue"),
};

init();

function init() {
  bindEvents();
  loadSessionDraft();
  renderMountLabels();
  applyFilters();
  setAnalysisProgress("대기 중", 0, 0, "");
}

function bindEvents() {
  els.mountAudio.addEventListener("click", mountAudioFolder);
  els.mountTxt.addEventListener("click", mountTxtFolder);
  els.mountExport.addEventListener("click", mountExportFolder);
  els.downloadJson.addEventListener("click", downloadJsonState);
  els.uploadJson.addEventListener("change", uploadJsonState);
  els.loadEssentia.addEventListener("click", () => ensureEssentia({ includeTags: els.useTags.checked }));
  els.analyzeMissing.addEventListener("click", analyzeMissingTracks);
  [els.search, els.verdictFilter, els.minBpm, els.maxBpm, els.tagFilter, els.sortMode].forEach((el) => {
    el.addEventListener("input", applyFilters);
    el.addEventListener("change", applyFilters);
  });
  els.sortSimilar.addEventListener("click", sortByCurrentSimilarity);
  els.prev.addEventListener("click", () => selectRelative(-1, false));
  els.next.addEventListener("click", () => selectRelative(1, false));
  els.audio.addEventListener("timeupdate", updateSeek);
  els.audio.addEventListener("loadedmetadata", updateSeek);
  els.audio.addEventListener("ended", () => {
    if (els.autoNext.checked) selectRelative(1, true);
  });
  els.seek.addEventListener("input", () => {
    state.seeking = true;
    const t = seekValueToTime();
    if (Number.isFinite(t)) els.audio.currentTime = t;
    els.currentTime.textContent = formatTime(t);
  });
  els.seek.addEventListener("change", () => {
    const t = seekValueToTime();
    if (Number.isFinite(t)) els.audio.currentTime = t;
    state.seeking = false;
    updateSeek();
  });
  els.ratingButtons.forEach((button) => {
    button.addEventListener("click", () => saveCurrentReview({ rating: Number(button.dataset.rating) }));
  });
  els.verdictButtons.forEach((button) => {
    button.addEventListener("click", () => saveCurrentReview({ verdict: button.dataset.verdict }));
  });
  els.memo.addEventListener("input", () => saveCurrentReview({ memo: els.memo.value }));
  els.userTags.addEventListener("input", () => saveCurrentReview({ userTags: splitTags(els.userTags.value) }));
  els.addQueue.addEventListener("click", addCurrentToQueue);
  els.playQueue.addEventListener("click", () => playQueueAt(0));
  els.clearQueue.addEventListener("click", () => {
    state.queue = [];
    saveSessionDraft();
    renderQueue();
  });
  els.copyQueue.addEventListener("click", copyQueueToMountedFolder);
  els.tabs.forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
}

async function mountAudioFolder() {
  const dir = await chooseDirectory("read");
  if (!dir) return;
  state.audioRoot = dir;
  state.audioLabel = dir.name || "마운트됨";
  await scanAudioFolder();
}

async function mountTxtFolder() {
  const dir = await chooseDirectory("read");
  if (!dir) return;
  state.txtRoot = dir;
  state.txtLabel = dir.name || "마운트됨";
  await mergeTxtFolder();
}

async function mountExportFolder() {
  const dir = await chooseDirectory("readwrite");
  if (!dir) return;
  state.exportRoot = dir;
  state.exportLabel = dir.name || "마운트됨";
  renderMountLabels();
}

async function chooseDirectory(mode) {
  if (!window.showDirectoryPicker) {
    alert("이 브라우저는 폴더 마운트를 지원하지 않습니다. Chrome 또는 Edge에서 HTTPS/localhost로 열어주세요.");
    return null;
  }
  try {
    return await window.showDirectoryPicker({ mode });
  } catch (error) {
    if (error?.name !== "AbortError") alert(`폴더 선택 실패: ${error.message || error}`);
    return null;
  }
}

async function scanAudioFolder() {
  setAnalysisProgress("음원 스캔 중", 0, 0, "폴더의 오디오 파일을 읽고 있습니다.");
  const entries = [];
  for await (const item of walkDir(state.audioRoot)) {
    if (!isAudioName(item.name)) continue;
    const file = await item.handle.getFile();
    const id = await trackIdFor(file, item.rel);
    entries.push({
      id,
      fileName: file.name,
      relPath: item.rel,
      size: file.size,
      modified: file.lastModified,
      handle: item.handle,
      file,
      title: titleFromFile(file.name),
      lyrics: "",
      metadata: { suno: {}, selectionCues: {}, sections: [] },
      hasTxt: false,
    });
  }
  entries.sort((a, b) => a.title.localeCompare(b.title, "ko"));
  state.tracks = entries;
  state.currentIndex = -1;
  if (state.txtRoot) await mergeTxtFolder();
  applyFilters();
  renderMountLabels();
  saveSessionDraft();
  setAnalysisProgress("스캔 완료", entries.length, entries.length, `${entries.length}곡을 불러왔습니다.`);
}

async function mergeTxtFolder() {
  if (!state.txtRoot) return;
  setAnalysisProgress("Suno txt 매칭 중", 0, 0, "txt 메타데이터를 읽고 있습니다.");
  const txtMap = new Map();
  for await (const item of walkDir(state.txtRoot)) {
    if (!item.name.toLowerCase().endsWith(".txt")) continue;
    const file = await item.handle.getFile();
    const text = await file.text();
    txtMap.set(item.name, parseSunoTxt(text));
    txtMap.set(normalizeName(item.name.replace(/\.txt$/i, "")), parseSunoTxt(text));
  }
  state.tracks.forEach((track) => {
    const parsed = txtMap.get(`${track.fileName}.txt`) || txtMap.get(normalizeName(track.fileName));
    if (!parsed) return;
    track.hasTxt = true;
    track.lyrics = parsed.lyrics;
    track.metadata = parsed.metadata;
    track.rawText = parsed.raw;
    track.sunoId = parsed.metadata?.suno?.id || "";
    track.title = parsed.metadata?.suno?.title || frontTitle(parsed.metadata) || titleFromFile(track.fileName);
  });
  applyFilters();
  renderMountLabels();
  saveSessionDraft();
  setAnalysisProgress("txt 매칭 완료", state.tracks.length, state.tracks.length, "Suno 메타데이터를 반영했습니다.");
}

async function* walkDir(dirHandle, prefix = "") {
  for await (const [name, handle] of dirHandle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") yield* walkDir(handle, rel);
    else yield { name, rel, handle };
  }
}

function parseSunoTxt(raw) {
  const [visible, rawApiText = ""] = raw.split("--- Raw API Response ---");
  const lyricsMatch = visible.match(/--- Lyrics ---\s*([\s\S]*)$/);
  const lyrics = lyricsMatch ? lyricsMatch[1].trim() : "";
  const front = lyricsMatch ? visible.slice(0, lyricsMatch.index).trim() : visible.trim();
  const metadata = parseFrontMetadata(front);
  const api = parseRawApi(rawApiText);
  enrichFromRawApi(metadata, api, rawApiText);
  metadata.selectionCues = selectionCues(api, metadata);
  return { lyrics, metadata, raw };
}

function parseFrontMetadata(text) {
  const result = { sections: [] };
  let section = "File";
  text.split(/\r?\n/).forEach((line) => {
    const stripped = line.trim();
    if (!stripped) return;
    const sectionMatch = stripped.match(/^--- (.+?) ---$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      return;
    }
    const pair = stripped.match(/^([^:]+):\s*(.*)$/);
    if (pair) result.sections.push({ section, key: pair[1], value: pair[2] || "-" });
    else if (result.sections.length) result.sections[result.sections.length - 1].value += `\n${stripped}`;
  });
  return result;
}

function parseRawApi(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { return {}; }
}

function rawString(text, key) {
  const match = String(text || "").match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]*)"`, "i"));
  return match ? match[1] : "";
}

function rawNumber(text, key) {
  const match = String(text || "").match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*([0-9.]+)`, "i"));
  return match ? Number(match[1]) : null;
}

function enrichFromRawApi(meta, api, rawApiText) {
  const metadata = typeof api.metadata === "object" && api.metadata ? api.metadata : {};
  const suno = {
    id: api.id || rawString(rawApiText, "id"),
    title: api.title || rawString(rawApiText, "title"),
    displayTags: api.display_tags || rawString(rawApiText, "display_tags"),
    duration: metadata.duration || rawNumber(rawApiText, "duration"),
    model: api.model_name || rawString(rawApiText, "model_name"),
    modelVersion: api.major_model_version || rawString(rawApiText, "major_model_version"),
    createdAt: api.created_at || rawString(rawApiText, "created_at"),
    audioUrl: api.audio_url || rawString(rawApiText, "audio_url"),
    imageUrl: api.image_url || rawString(rawApiText, "image_url"),
    prompt: metadata.tags || "",
    lyricsPrompt: metadata.prompt || "",
    playCount: api.reaction?.play_count || api.play_count,
    skipCount: api.reaction?.skip_count,
    batchIndex: api.batch_index,
  };
  meta.suno = Object.fromEntries(Object.entries(suno).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function selectionCues(api, meta) {
  const suno = meta.suno || {};
  const prompt = suno.prompt || "";
  const bpm = prompt.match(/\b(?:around\s*)?(\d{2,3}\s*[-~]\s*\d{2,3}\s*bpm|\d{2,3}\s*bpm)\b/i);
  return {
    tags: suno.displayTags || "",
    bpm: bpm ? bpm[1] : "",
    vocal: firstSentence(prompt, /\bvocal\b/i),
    groove: firstSentence(prompt, /four-on-the-floor|groove|funky bass|bassline|roller disco/i),
    mood: firstSentence(prompt, /nostalgic|uplifting|playful|cold|detached|sensual|warm|bright|sleek|catchy/i),
    mix: firstSentence(prompt, /mix|wide stereo|saturated|soft highs|low-end|transients|reverb|dry/i),
  };
}

function firstSentence(text, pattern) {
  return String(text || "").split(/\n+|(?<=[.!?])\s+/).find((sentence) => pattern.test(sentence))?.trim() || "";
}

async function ensureEssentia({ includeTags = false } = {}) {
  if (essentiaCore && (!includeTags || musicnnModel)) return;
  if (typeof EssentiaWASM === "undefined" || typeof Essentia === "undefined") {
    throw new Error("Essentia 스크립트가 로드되지 않았습니다.");
  }
  setAnalysisProgress("Essentia 로딩 중", 0, 0, "wasm 파일을 초기화하고 있습니다.");
  if (!wasmModule) {
    const wasmUrl = window.APP_CONFIG?.essentiaWasmPath || "./vendor/essentia-wasm.web.wasm";
    wasmModule = await EssentiaWASM({ locateFile: (path) => path.endsWith(".wasm") ? wasmUrl : path });
    essentiaCore = new Essentia(wasmModule);
  }
  if (includeTags && !musicnnModel) {
    if (typeof tf === "undefined" || typeof EssentiaModel === "undefined") throw new Error("TFJS 또는 EssentiaModel을 로드하지 못했습니다.");
    if (!inputExtractor) inputExtractor = new EssentiaModel.EssentiaTFInputExtractor(wasmModule, "musicnn", false);
    await loadTags();
    setAnalysisProgress("MusicNN 로딩 중", 0, 0, "태그 분석 모델을 초기화하고 있습니다.");
    musicnnModel = new EssentiaModel.TensorflowMusiCNN(tf, window.APP_CONFIG.modelPath);
    await musicnnModel.initialize();
  }
  setAnalysisProgress("Essentia 준비 완료", 0, 0, includeTags ? "BPM/Key와 MusicNN 태그를 분석할 수 있습니다." : "BPM/Key를 분석할 수 있습니다.");
}

async function loadTags() {
  if (tagList.length) return;
  try {
    const response = await fetch(window.APP_CONFIG.metadataPath);
    const data = await response.json();
    tagList = data.classes || data.tags || [];
  } catch {
    tagList = [];
  }
}

async function analyzeMissingTracks() {
  const targets = state.filtered.filter((track) => !state.analysisCache[track.id]?.ok);
  if (!targets.length) {
    alert("현재 필터 안에 미분석 곡이 없습니다.");
    return;
  }
  els.analyzeMissing.disabled = true;
  const includeTags = els.useTags.checked;
  let ok = 0;
  let fail = 0;
  try {
    await ensureEssentia({ includeTags });
    for (let i = 0; i < targets.length; i += 1) {
      const track = targets[i];
      state.analyzingId = track.id;
      setAnalysisProgress("분석 중", i, targets.length, track.fileName);
      renderTracks();
      try {
        const result = await analyzeTrack(track, { includeTags, segmentMode: "middle", segmentSeconds: 30, topTags: 8 });
        state.analysisCache[track.id] = result;
        ok += 1;
      } catch (error) {
        state.analysisCache[track.id] = {
          ok: false,
          analyzedAt: new Date().toISOString(),
          error: error.message || String(error),
          signature: trackSignature(track),
        };
        fail += 1;
      }
      saveSessionDraft();
      applyFilters();
      await yieldToBrowser();
    }
    state.analyzingId = "";
    setAnalysisProgress("분석 완료", targets.length, targets.length, `성공 ${ok}곡, 실패 ${fail}곡`);
  } finally {
    els.analyzeMissing.disabled = false;
    state.analyzingId = "";
    renderTracks();
  }
}

async function analyzeTrack(track, opts) {
  const file = await track.handle.getFile();
  const audioBuffer = await decodeAudio(file);
  const duration = audioBuffer.duration;
  const signal = await downsampleSegment(audioBuffer, opts.segmentMode, opts.segmentSeconds);
  if (!signal || !signal.length) throw new Error("오디오 신호를 만들지 못했습니다.");
  const bpmKey = extractBpmKey(signal);
  const output = {
    ok: true,
    analyzedAt: new Date().toISOString(),
    signature: trackSignature(track),
    duration,
    sampleRate: MODEL_SR,
    bpm: bpmKey.bpm,
    key: bpmKey.key,
    scale: bpmKey.scale,
    camelot: toCamelot(bpmKey.key, bpmKey.scale),
    keyStrength: bpmKey.keyStrength,
    topTags: [],
  };
  if (opts.includeTags && musicnnModel && inputExtractor) {
    const inputFeat = inputExtractor.computeFrameWise(signal, 256);
    let rawPreds = null;
    tf.engine().startScope();
    try { rawPreds = await musicnnModel.predict(inputFeat, true); }
    finally { tf.engine().endScope(); }
    output.topTags = topTagsFromScores(vectorToScores(rawPreds), opts.topTags);
  }
  return output;
}

async function decodeAudio(file) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const buf = await file.arrayBuffer();
  return await new Promise((resolve, reject) => {
    const p = audioCtx.decodeAudioData(buf, resolve, reject);
    if (p && typeof p.then === "function") p.then(resolve).catch(reject);
  });
}

async function downsampleSegment(audioBuffer, mode, segmentSeconds) {
  const windowInfo = computeSegmentWindow(audioBuffer.duration, mode, segmentSeconds);
  const frameCount = Math.max(1, Math.floor(windowInfo.duration * MODEL_SR));
  const ctx = new OfflineAudioContext(1, frameCount, MODEL_SR);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  source.start(0, windowInfo.start, windowInfo.duration);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

function computeSegmentWindow(totalSeconds, mode, segmentSeconds) {
  const seg = Math.max(1, Number(segmentSeconds) || 30);
  const duration = Math.min(Number(totalSeconds) || seg, seg);
  let start = 0;
  if (totalSeconds > duration) {
    if (mode === "end") start = Math.max(0, totalSeconds - duration);
    else if (mode === "middle") start = Math.max(0, (totalSeconds - duration) / 2);
  }
  return { start, duration };
}

function extractBpmKey(signal) {
  let vec = null;
  try {
    vec = essentiaCore.arrayToVector(signal);
    const bpmRes = essentiaCore.PercivalBpmEstimator(vec, undefined, undefined, undefined, undefined, undefined, undefined, MODEL_SR);
    const keyRes = essentiaCore.KeyExtractor(vec, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, MODEL_SR);
    return {
      bpm: typeof bpmRes?.bpm === "number" ? bpmRes.bpm : null,
      key: keyRes?.key || "",
      scale: keyRes?.scale || "",
      keyStrength: typeof keyRes?.strength === "number" ? keyRes.strength : null,
    };
  } finally {
    if (vec && typeof vec.delete === "function") vec.delete();
  }
}

function vectorToScores(preds) {
  let arr = preds instanceof Float32Array ? Array.from(preds) : preds;
  if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) {
    const mean = new Array(arr[0].length).fill(0);
    arr.forEach((row) => row.forEach((v, i) => { mean[i] += Number(v || 0); }));
    return mean.map((v) => v / arr.length);
  }
  return Array.isArray(arr) ? arr.map((x) => Number(x || 0)) : [];
}

function topTagsFromScores(scores, topN) {
  return scores.map((score, index) => ({ tag: tagList[index] || `tag_${index}`, score: Number(score || 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

function applyFilters() {
  const q = els.search.value.trim().toLowerCase();
  const tagQ = els.tagFilter.value.trim().toLowerCase();
  const minBpm = Number(els.minBpm.value || -Infinity);
  const maxBpm = Number(els.maxBpm.value || Infinity);
  const verdict = els.verdictFilter.value;
  state.filtered = state.tracks.filter((track) => {
    const review = state.reviews[track.id] || {};
    const analysis = state.analysisCache[track.id] || {};
    const suno = track.metadata?.suno || {};
    const cues = track.metadata?.selectionCues || {};
    const bpm = Number(analysis.bpm || NaN);
    const text = [track.title, track.fileName, track.relPath, review.memo, (review.userTags || []).join(" "), suno.displayTags, cues.tags].join(" ").toLowerCase();
    const tagText = [suno.displayTags, cues.tags, (analysis.topTags || []).map((t) => t.tag).join(" ")].join(" ").toLowerCase();
    if (q && !text.includes(q)) return false;
    if (tagQ && !tagText.includes(tagQ)) return false;
    if (verdict !== "all" && (review.verdict || "unset") !== verdict) return false;
    if (Number.isFinite(minBpm) && Number.isFinite(bpm) && bpm < minBpm) return false;
    if (Number.isFinite(maxBpm) && Number.isFinite(bpm) && bpm > maxBpm) return false;
    return true;
  });
  sortFiltered();
  renderTracks();
  renderQueue();
}

function sortFiltered() {
  const mode = els.sortMode.value;
  const value = (track) => {
    const review = state.reviews[track.id] || {};
    const analysis = state.analysisCache[track.id] || {};
    if (mode === "rating") return -(Number(review.rating || 0));
    if (mode === "bpm") return Number(analysis.bpm || 9999);
    if (mode === "key") return String(analysis.camelot || "");
    if (mode === "modified") return -(track.modified || 0);
    if (mode === "similarity") return -(state.sortScores.get(track.id) || 0);
    return String(track.title || track.fileName || "");
  };
  state.filtered.sort((a, b) => {
    const va = value(a), vb = value(b);
    return typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "ko");
  });
}

function renderTracks() {
  els.trackCount.textContent = `${state.filtered.length} / ${state.tracks.length}곡`;
  const current = currentTrack();
  els.trackList.innerHTML = "";
  state.filtered.forEach((track, index) => {
    const review = state.reviews[track.id] || {};
    const analysis = state.analysisCache[track.id] || {};
    const suno = track.metadata?.suno || {};
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-item";
    button.classList.toggle("active", current?.id === track.id);
    button.innerHTML = `
      <div class="track-title">${escapeHtml(track.title || track.fileName)}</div>
      <div class="track-meta">${escapeHtml(track.relPath || track.fileName)} - ${formatMb(track.size)}</div>
      <div class="badges">
        <span class="badge ${review.verdict || ""}">${labelVerdict(review.verdict)}</span>
        ${analysisBadge(track)}
        ${review.rating ? `<span class="badge">${review.rating}/5</span>` : ""}
        ${analysis.bpm ? `<span class="badge">${Number(analysis.bpm).toFixed(1)} BPM</span>` : ""}
        ${analysis.camelot ? `<span class="badge">${escapeHtml(analysis.camelot)}</span>` : ""}
        ${suno.displayTags ? `<span class="badge">${escapeHtml(suno.displayTags)}</span>` : ""}
      </div>`;
    button.addEventListener("click", () => selectTrack(index, true));
    els.trackList.appendChild(button);
  });
}

function analysisBadge(track) {
  const analysis = state.analysisCache[track.id] || {};
  if (state.analyzingId === track.id) return '<span class="badge analyzing">분석중</span>';
  if (analysis.ok) return '<span class="badge analyzed">분석완료</span>';
  if (analysis.error) return '<span class="badge failed">분석실패</span>';
  return '<span class="badge pending">미분석</span>';
}

async function selectTrack(index, autoplay = false) {
  if (index < 0 || index >= state.filtered.length) return;
  state.currentIndex = index;
  const track = currentTrack();
  const file = await track.handle.getFile();
  if (track.objectUrl) URL.revokeObjectURL(track.objectUrl);
  track.objectUrl = URL.createObjectURL(file);
  els.audio.src = track.objectUrl;
  resetSeek();
  if (autoplay) {
    try { await els.audio.play(); } catch {}
  }
  renderCurrent();
  renderTracks();
}

function currentTrack() {
  return state.filtered[state.currentIndex] || null;
}

function renderCurrent() {
  const track = currentTrack();
  if (!track) return;
  const review = state.reviews[track.id] || {};
  const analysis = state.analysisCache[track.id] || {};
  els.selectedTitle.textContent = track.title || track.fileName;
  els.selectedFile.textContent = track.relPath || track.fileName;
  els.selectedMeta.textContent = [
    formatMb(track.size),
    analysis.bpm ? `${Number(analysis.bpm).toFixed(1)} BPM` : "",
    analysis.key && analysis.scale ? `${analysis.key} ${analysis.scale}` : analysis.key || "",
    analysis.camelot || "",
  ].filter(Boolean).join(" - ");
  els.memo.value = review.memo || "";
  els.userTags.value = (review.userTags || []).join(", ");
  els.ratingButtons.forEach((button) => button.classList.toggle("active", Number(button.dataset.rating) <= Number(review.rating || 0)));
  els.verdictButtons.forEach((button) => button.classList.toggle("active", button.dataset.verdict === (review.verdict || "")));
  els.lyricsView.textContent = track.lyrics || "가사 정보가 없습니다.";
  renderMetadata(track);
  renderAnalysis(track);
}

function renderMetadata(track) {
  const metadata = track.metadata || {};
  const suno = metadata.suno || {};
  const cues = metadata.selectionCues || {};
  const rows = [
    ["선곡 힌트", "태그", cues.tags || suno.displayTags],
    ["선곡 힌트", "BPM", cues.bpm],
    ["선곡 힌트", "보컬", cues.vocal],
    ["선곡 힌트", "그루브", cues.groove],
    ["선곡 힌트", "무드", cues.mood],
    ["선곡 힌트", "믹스", cues.mix],
  ];
  Object.entries(suno).forEach(([key, value]) => rows.push(["Suno 메타데이터", key, value]));
  (metadata.sections || []).forEach((row) => rows.push([row.section, row.key, row.value]));
  els.metadataView.innerHTML = renderRows(rows);
}

function renderAnalysis(track) {
  const analysis = state.analysisCache[track.id] || {};
  const rows = [
    ["Essentia", "상태", analysis.ok ? "분석 완료" : (analysis.error || "미분석")],
    ["Essentia", "BPM", analysis.bpm],
    ["Essentia", "Key", analysis.key && analysis.scale ? `${analysis.key} ${analysis.scale}` : analysis.key],
    ["Essentia", "Camelot", analysis.camelot],
    ["Essentia", "Key Strength", analysis.keyStrength],
    ["Essentia", "Duration", analysis.duration ? `${Number(analysis.duration).toFixed(1)} sec` : ""],
    ["Essentia", "Analyzed At", analysis.analyzedAt],
    ["MusicNN", "Top Tags", (analysis.topTags || []).map((t) => `${t.tag} ${Number(t.score).toFixed(3)}`).join(", ")],
  ];
  els.analysisView.innerHTML = renderRows(rows);
}

function renderRows(rows) {
  let section = "";
  return rows.filter(([, , value]) => value !== undefined && value !== null && value !== "").map(([sec, key, value]) => {
    const head = sec !== section ? `<div class="meta-section">${escapeHtml(sec)}</div>` : "";
    section = sec;
    return `${head}<div class="meta-row"><strong>${escapeHtml(key)}</strong><span>${escapeHtml(String(value))}</span></div>`;
  }).join("") || '<div class="meta-row"><span>표시할 정보가 없습니다.</span></div>';
}

function saveCurrentReview(patch) {
  const track = currentTrack();
  if (!track) return;
  state.reviews[track.id] = { ...(state.reviews[track.id] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveSessionDraft();
  renderCurrent();
  renderTracks();
}

function addCurrentToQueue() {
  const track = currentTrack();
  if (!track || state.queue.includes(track.id)) return;
  state.queue.push(track.id);
  saveSessionDraft();
  renderQueue();
}

function renderQueue() {
  els.queueCount.textContent = `${state.queue.length}곡`;
  els.queueList.innerHTML = "";
  state.queue.forEach((id, index) => {
    const track = state.tracks.find((item) => item.id === id);
    if (!track) return;
    const row = document.createElement("div");
    row.className = "queue-item";
    row.innerHTML = `<div class="track-title">${index + 1}. ${escapeHtml(track.title || track.fileName)}</div><div class="track-meta">${escapeHtml(track.fileName)}</div>`;
    const actions = document.createElement("div");
    actions.className = "queue-actions";
    actions.innerHTML = `<button data-act="play">재생</button><button data-act="up">위로</button><button data-act="down">아래로</button><button data-act="remove">삭제</button>`;
    actions.addEventListener("click", (event) => {
      const act = event.target.dataset.act;
      if (!act) return;
      if (act === "play") playQueueAt(index);
      if (act === "up" && index > 0) [state.queue[index - 1], state.queue[index]] = [state.queue[index], state.queue[index - 1]];
      if (act === "down" && index < state.queue.length - 1) [state.queue[index + 1], state.queue[index]] = [state.queue[index], state.queue[index + 1]];
      if (act === "remove") state.queue.splice(index, 1);
      saveSessionDraft();
      renderQueue();
    });
    row.appendChild(actions);
    els.queueList.appendChild(row);
  });
}

async function playQueueAt(index) {
  const id = state.queue[index];
  const filteredIndex = state.filtered.findIndex((track) => track.id === id);
  if (filteredIndex >= 0) await selectTrack(filteredIndex, true);
}

async function copyQueueToMountedFolder() {
  if (!state.queue.length) {
    alert("복사할 대기열이 비어 있습니다.");
    return;
  }
  if (!state.exportRoot) await mountExportFolder();
  if (!state.exportRoot) return;
  for (let i = 0; i < state.queue.length; i += 1) {
    const track = state.tracks.find((item) => item.id === state.queue[i]);
    if (!track) continue;
    const file = await track.handle.getFile();
    const outName = sanitizeFileName(`${els.copyPrefix.value || ""}${String(Number(els.copyStart.value || 1) + i).padStart(Number(els.copyPad.value || 3), "0")} - ${file.name}`);
    const outHandle = await state.exportRoot.getFileHandle(outName, { create: true });
    const writable = await outHandle.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
  }
  alert("마운트한 내보내기 폴더로 복사했습니다.");
}

function downloadJsonState() {
  const payload = {
    version: STATE_VERSION,
    exportedAt: new Date().toISOString(),
    analysisCache: state.analysisCache,
    reviews: state.reviews,
    queue: state.queue,
    trackSnapshots: state.tracks.map(snapshotTrack),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `music-review-selector-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function uploadJsonState(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const payload = JSON.parse(await file.text());
  state.analysisCache = payload.analysisCache || {};
  state.reviews = payload.reviews || {};
  state.queue = Array.isArray(payload.queue) ? payload.queue : [];
  saveSessionDraft();
  applyFilters();
  renderCurrent();
  alert("JSON 데이터를 불러왔습니다. 폴더를 다시 마운트하면 같은 ID의 곡에 분석/검수/대기열이 연결됩니다.");
  event.target.value = "";
}

function saveSessionDraft() {
  try {
    localStorage.setItem("musicReviewSelectorStaticDraft", JSON.stringify({
      analysisCache: state.analysisCache,
      reviews: state.reviews,
      queue: state.queue,
    }));
  } catch {}
}

function loadSessionDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem("musicReviewSelectorStaticDraft") || "{}");
    state.analysisCache = draft.analysisCache || {};
    state.reviews = draft.reviews || {};
    state.queue = Array.isArray(draft.queue) ? draft.queue : [];
  } catch {}
}

function snapshotTrack(track) {
  return {
    id: track.id,
    fileName: track.fileName,
    relPath: track.relPath,
    size: track.size,
    modified: track.modified,
    title: track.title,
    sunoId: track.sunoId || "",
    hasTxt: track.hasTxt,
    metadata: track.metadata,
  };
}

function sortByCurrentSimilarity() {
  const anchor = currentTrack();
  if (!anchor) return;
  state.sortScores.clear();
  state.tracks.forEach((track) => state.sortScores.set(track.id, similarity(anchor, track)));
  els.sortMode.value = "similarity";
  applyFilters();
}

function similarity(a, b) {
  if (a.id === b.id) return 1;
  const aa = state.analysisCache[a.id] || {};
  const bb = state.analysisCache[b.id] || {};
  const bpmA = Number(aa.bpm || 0);
  const bpmB = Number(bb.bpm || 0);
  const bpmScore = bpmA && bpmB ? Math.max(0, 1 - Math.abs(bpmA - bpmB) / 30) : 0;
  const camScore = camelotScore(aa.camelot, bb.camelot);
  const tagScore = sharedTagScore(aa.topTags, bb.topTags);
  return bpmScore * .35 + camScore * .4 + tagScore * .25;
}

function sharedTagScore(a = [], b = []) {
  const set = new Set(a.slice(0, 8).map((t) => t.tag));
  if (!set.size) return 0;
  return b.slice(0, 8).filter((t) => set.has(t.tag)).length / set.size;
}

function camelotScore(a, b) {
  const ca = parseCamelot(a), cb = parseCamelot(b);
  if (!ca || !cb) return 0;
  if (ca.n === cb.n && ca.ab === cb.ab) return 1;
  if (ca.n === cb.n) return .9;
  const d = Math.min(Math.abs(ca.n - cb.n), 12 - Math.abs(ca.n - cb.n));
  if (d === 1 && ca.ab === cb.ab) return .85;
  if (d === 1) return .75;
  if (d === 2 && ca.ab === cb.ab) return .6;
  return .3;
}

function toCamelot(key, scale) {
  const normalizedKey = String(key || "").replace("♯", "#").replace("♭", "b");
  const normalizedScale = String(scale || "").toLowerCase();
  const minor = { Ab: "1A", Eb: "2A", Bb: "3A", F: "4A", C: "5A", G: "6A", D: "7A", A: "8A", E: "9A", B: "10A", "F#": "11A", Db: "12A" };
  const major = { B: "1B", "F#": "2B", Db: "3B", Ab: "4B", Eb: "5B", Bb: "6B", F: "7B", C: "8B", G: "9B", D: "10B", A: "11B", E: "12B" };
  return normalizedScale.startsWith("min") ? minor[normalizedKey] || "" : major[normalizedKey] || "";
}

function parseCamelot(value) {
  const match = String(value || "").toUpperCase().match(/^(1[0-2]|[1-9])\s*([AB])/);
  return match ? { n: Number(match[1]), ab: match[2] } : null;
}

function selectRelative(delta, autoplay) {
  selectTrack(Math.max(0, Math.min(state.filtered.length - 1, state.currentIndex + delta)), autoplay);
}

function showTab(name) {
  els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  [els.lyricsView, els.metadataView, els.analysisView].forEach((view) => view.classList.add("hidden"));
  if (name === "lyrics") els.lyricsView.classList.remove("hidden");
  if (name === "metadata") els.metadataView.classList.remove("hidden");
  if (name === "analysis") els.analysisView.classList.remove("hidden");
}

function updateSeek() {
  const duration = els.audio.duration;
  const current = els.audio.currentTime;
  els.duration.textContent = formatTime(duration);
  if (!state.seeking) {
    els.currentTime.textContent = formatTime(current);
    els.seek.value = Number.isFinite(duration) && duration > 0 ? Math.round((current / duration) * Number(els.seek.max)) : 0;
  }
}

function seekValueToTime() {
  const duration = els.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Number(els.seek.value) / Number(els.seek.max) * duration;
}

function resetSeek() {
  els.seek.value = 0;
  els.currentTime.textContent = "0:00";
  els.duration.textContent = "0:00";
}

function setAnalysisProgress(status, done, total, current) {
  els.analysisStatus.textContent = status;
  els.analysisCount.textContent = `${done || 0} / ${total || 0}`;
  els.analysisProgress.value = total ? Math.round((done / total) * 100) : 0;
  els.analysisCurrent.textContent = current || "대기 중";
}

function renderMountLabels() {
  els.audioMountLabel.textContent = state.audioLabel || "미선택";
  els.txtMountLabel.textContent = state.txtLabel || "미선택";
  els.exportMountLabel.textContent = state.exportLabel || "미선택";
}

async function trackIdFor(file, relPath) {
  const text = `${relPath}|${file.name}|${file.size}|${file.lastModified}`;
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function trackSignature(track) {
  return `${track.relPath}|${track.size}|${track.modified}`;
}

function isAudioName(name) {
  return AUDIO_EXTS.has(String(name).split(".").pop().toLowerCase());
}

function titleFromFile(name) {
  return String(name || "").replace(/\.[^.]+$/, "").replace(/^[0-9]{6}_[^-]+-/, "").replace(/-[0-9a-f]{8}-.+$/i, "").replaceAll("_", " ");
}

function frontTitle(metadata) {
  const row = (metadata.sections || []).find((item) => item.key === "Title" || item.key === "제목");
  return row?.value || "";
}

function normalizeName(name) {
  return String(name || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "").toLowerCase().replace(/[\s_\-()[\]{}]+/g, "");
}

function sanitizeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+$/g, "");
}

function splitTags(text) { return text.split(",").map((tag) => tag.trim()).filter(Boolean); }
function formatMb(bytes) { return bytes ? `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB` : ""; }
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
function labelVerdict(v) { return ({ pass: "통과", hold: "보류", reject: "탈락" }[v] || "미정"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function yieldToBrowser() { return new Promise((resolve) => setTimeout(resolve, 0)); }
