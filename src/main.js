import './style.css';
import { Engine } from './engine.js';
import { h, drag, download, toast, fmt, pickFile } from './ui.js';
import { ENVS, ENV_ORDER, CHARS, CHAR_ORDER, PROPS, ACTIONS, SEATABLE, TIMES, CAM_PRESETS, MAX_CHARS, VOICE_TYPES, LANGS, DEFAULT_VOICES } from './data.js';
import { newProject, newScene, newChar, newProp, newDialog, dialogDur, charState, presetCamera, cameraAt, speedFor, uid, migrateProject, fitSceneToDialogs, speechState } from './model.js';
import { putBlob, getBlob, getBuffer, startRecording, Player, audioDuration, saveProjectDb, loadProjectDb, blobToDataUrl, dataUrlToBlob, actx } from './audio.js';
import { voiceTypeFor, browserProfile, speakBrowser, cancelBrowser, measureBrowser, browserTtsAvailable, getBrowserVoices, voicesForLang } from './tts.js';
import { exportVideo } from './exporter.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;

const engine = new Engine($('#gl')); window.__engine = engine;
const player = new Player();
let project, si = 0, sel = null, selDialog = null, t = 0, playing = false, playAll = false, previewCam = false;
let tab = 'chars', camKey = 'start', pathMode = false, gizmoMode = 'translate', lastTs = 0, binds = [], recorder = null, recordingFor = null;
const scene = () => project.scenes[si];

/* ======================= bootstrap ======================= */
function starter() {
  const p = newProject(); const sc = p.scenes[0]; sc.name = 'Rural Village';
  const w = newChar('woman', sc); w.x = -3; w.z = 7; w.facing = 90; w.path = [[0, 7], [4, 5.5]]; w.pathStart = 1; w.actions = [{ t: 0, action: 'idle', seat: '' }, { t: 5, action: 'talk', seat: '' }];
  const m = newChar('oldman', sc); m.x = 5.5; m.z = 5.5; m.facing = 270; m.actions = [{ t: 0, action: 'idle', seat: '' }, { t: 7, action: 'talk', seat: '' }];
  const g = newChar('goat', sc); g.x = -6; g.z = 3; g.facing = 120; g.actions = [{ t: 0, action: 'eat', seat: '' }];
  sc.chars.push(w, m, g);
  const d1 = newDialog(sc); d1.charId = w.id; d1.t = 5; d1.text = 'नमस्ते बाजे! आज खेतमा काम कस्तो छ?'; d1.dur = 3.5;
  const d2 = newDialog(sc); d2.charId = m.id; d2.t = 9; d2.text = 'ठीक छ नानी, धान रोप्ने बेला भयो।'; d2.dur = 3.5;
  sc.dialogs.push(d1, d2); return p;
}
(async function boot() {
  try { const q = localStorage.getItem('nss-quality'); if (q) { $('#quality').value = q; engine.setQuality(q); } } catch { }
  project = (await loadProjectDb()) || starter();
  if (!project.scenes?.length) project = starter();
  migrateProject(project);
  project.voices ||= structuredClone(DEFAULT_VOICES);
  $('#projName').value = project.name || '';
  new ResizeObserver(() => { engine.resize(); if (!playing) engine.render(); redrawTimeline(); }).observe($('#view'));
  engine.controls.addEventListener('change', () => { if (!playing) engine.render(); });
  engine.onCameraChange = () => { if (playing || previewCam) return; scene().camera[camKey] = engine.getCamera(); touch(false); syncBinds(); };
  engine.onPick = (ent) => selectEntity(ent);
  engine.onTransform = (s, proxy) => transformEntity(s, proxy);
  engine.onGroundClick = (x, z) => { const ch = selChar(); if (!ch) return; ch.path.push([x, z]); touch(); engine.updateHelpers(scene()); frame(); renderRight(); };
  goScene(0); $('#loading').hidden = true;
})().catch(e => { console.error(e); $('#loading').textContent = 'Failed to start: ' + e.message; });

/* ======================= core helpers ======================= */
let saveTimer;
function touch(redraw = true) { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveProjectDb(JSON.parse(JSON.stringify(project))), 700); if (redraw) redrawTimeline(); }
function frame(useKeys = playing || previewCam) { const sc = scene(); engine.setTime(sc, t, useKeys); engine.render(); }
function selChar() { return sel?.kind === 'char' ? scene().chars.find(c => c.id === sel.id) : null; }
function selProp() { return sel?.kind === 'prop' ? scene().props.find(c => c.id === sel.id) : null; }
function applyKeyCamera() { const k = scene().camera[camKey] || scene().camera.start; engine.setCamera(k.pos, k.target, k.fov); }
async function applyGlbs() {
  const sc = scene();
  for (const ch of sc.chars) { const o = engine.chars.get(ch.id); if (o && ch.glb && o.glbKey !== ch.glb) { const b = await getBlob(ch.glb); if (b) { try { await engine.applyGlb('char', ch.id, b, ch.glb); o.glbKey = ch.glb; } catch (e) { toast('Could not load .glb model: ' + e.message); } } } }
  for (const p of sc.props) { const o = engine.props.get(p.id); if (o && p.glb && o.glbKey !== p.glb) { const b = await getBlob(p.glb); if (b) { try { await engine.applyGlb('prop', p.id, b, p.glb); o.glbKey = p.glb; } catch (e) { toast('Could not load .glb model: ' + e.message); } } } }
  frame();
}
function removeGlb(kind, id) { // rebuild procedural model
  if (kind === 'char') { const o = engine.chars.get(id); if (o) { engine.charGroup.remove(o.rig.root); engine.chars.delete(id); } } else { const o = engine.props.get(id); if (o) { engine.propGroup.remove(o.obj); engine.props.delete(id); } }
  engine.syncEntities(scene()); frame();
}

function goScene(i) {
  stopPlay(); si = clamp(i, 0, project.scenes.length - 1); sel = null; selDialog = null; pathMode = false; engine.pathMode = false; t = 0; camKey = 'start';
  const sc = scene(); engine.loadScene(sc); applyKeyCamera(); engine.select(null, sc); engine.setEditing(true); frame(false); applyGlbs();
  renderAll();
}
function renderAll() { renderLeft(); renderRight(); renderTransport(); redrawTimeline(); renderHud(); }

/* ---------- bindings ---------- */
function syncBinds() { for (const b of binds) { if (document.activeElement !== b.el) { const v = b.obj[b.key]; b.el.value = v === null || v === undefined ? '' : v; } } }
function num(obj, key, { min, max, step = 0.1, after, w } = {}) {
  const el = h('input', { type: 'number', step, min, max, style: w ? { width: w } : null });
  el.value = obj[key] ?? ''; el.addEventListener('input', () => { if (el.value === '') return; obj[key] = parseFloat(el.value); after?.(); touch(); frame(); engine.updateHelpers(scene()); });
  binds.push({ el, obj, key }); return el;
}
function txt(obj, key, after) { const el = h('input', { type: 'text' }); el.value = obj[key] ?? ''; el.addEventListener('input', () => { obj[key] = el.value; after?.(); touch(); }); binds.push({ el, obj, key }); return el; }
function select(opts, value, onchange) { const el = h('select', {}, opts.map(([v, l]) => h('option', { value: v }, l))); el.value = value; el.addEventListener('change', () => onchange(el.value)); return el; }
const row = (label, ...kids) => h('div', { class: 'row' }, label ? h('label', {}, label) : null, ...kids);

/* ======================= LEFT: scenes ======================= */
function renderLeft() {
  const L = $('#left'); L.innerHTML = ''; const sc = scene();
  L.append(h('h3', {}, 'Scenes'));
  project.scenes.forEach((s, i) => L.append(h('div', { class: 'item' + (i === si ? ' sel' : ''), onclick: () => goScene(i) },
    h('span', { class: 'muted' }, i + 1), h('span', { class: 'grow' }, s.name), h('span', { class: 'muted small' }, s.duration + 's'),
    h('button', { class: 'sm', title: 'Move up', disabled: i === 0, onclick: e => { e.stopPropagation(); move(i, -1); } }, '▲'),
    h('button', { class: 'sm', title: 'Move down', disabled: i === project.scenes.length - 1, onclick: e => { e.stopPropagation(); move(i, 1); } }, '▼'),
    h('button', { class: 'sm danger', title: 'Remove scene', disabled: project.scenes.length < 2, onclick: e => { e.stopPropagation(); if (confirm(`Remove scene "${s.name}"?`)) { project.scenes.splice(i, 1); touch(); goScene(Math.min(si, project.scenes.length - 1)); } } }, '✕'))));
  const envSel = select(ENV_ORDER.map(k => [k, ENVS[k].name]), 'village', () => { });
  L.append(row('', envSel, h('button', { class: 'primary sm', onclick: () => { const s = newScene(envSel.value); project.scenes.splice(si + 1, 0, s); touch(); goScene(si + 1); } }, '+ Add scene')));

  L.append(h('h3', {}, 'This scene'));
  L.append(row('Name', txt(sc, 'name', () => renderLeftList())));
  L.append(row('Duration', num(sc, 'duration', { min: 3, max: 600, step: 1, after: () => { sc.duration = Math.max(3, sc.duration || 3); t = Math.min(t, sc.duration); renderTransport(); }, w: '70px' }), h('span', { class: 'muted' }, 'seconds')));
  L.append(row('Environment', select(ENV_ORDER.map(k => [k, ENVS[k].name]), sc.env, v => { sc.env = v; sc.camera = newScene(v).camera; if (!sc.name || Object.values(ENVS).some(e => e.name === sc.name)) sc.name = ENVS[v].name; touch(); goScene(si); })));
  L.append(row('Time of day', select(Object.entries(TIMES).map(([k, v]) => [k, v.label]), sc.tod, v => { sc.tod = v; engine.loadScene(sc); frame(); touch(false); })));
  const fog = h('input', { type: 'range', min: 0, max: 3, step: 0.1, value: sc.fog ?? 1 }); fog.oninput = () => { sc.fog = +fog.value; engine.applyTod(sc.tod, engine.env.interior, sc.fog); frame(); touch(false); };
  L.append(row('Fog / haze', fog));

  L.append(h('h3', {}, 'Narration (one file)'));
  L.append(audioSlot(sc, 'narration', 1));
  L.append(h('h3', {}, 'Background music (one file)'));
  L.append(audioSlot(sc, 'music', 0.35));
  L.append(h('p', { class: 'muted small' }, 'Tip: click characters in the 3D view to select them. Use the timeline below to set when actions and dialog start.'));
}
function renderLeftList() { const items = $('#left').querySelectorAll('.item .grow'); project.scenes.forEach((s, i) => { if (items[i]) items[i].textContent = s.name; }); }
function move(i, d) { const a = project.scenes; [a[i], a[i + d]] = [a[i + d], a[i]]; touch(); si = i + d; goScene(si); }

function audioSlot(sc, field, defVol) {
  const cur = sc[field]; const box = h('div', { class: 'card' });
  if (cur?.key) {
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cur.vol ?? defVol }); vol.oninput = () => { cur.vol = +vol.value; touch(false); };
    box.append(h('div', { class: 'row' }, h('span', { class: 'grow badge ok' }, '✔ ' + (cur.name || 'audio')), h('button', { class: 'sm danger', onclick: () => { sc[field] = null; touch(); renderLeft(); } }, 'Remove')), row('Volume', vol));
    if (field === 'music') { const fd = h('input', { type: 'range', min: 0, max: 5, step: 0.5, value: cur.fade ?? 1.5 }); fd.oninput = () => { cur.fade = +fd.value; touch(false); }; box.append(row('Fade in/out', fd), h('div', { class: 'muted small' }, 'Loops automatically for the scene length.')); }
  } else {
    const up = h('button', { class: 'sm', onclick: async () => { const f = await pickFile('audio/*'); if (!f) return; const key = await putBlob(f, f.name); sc[field] = { key, name: f.name, vol: defVol, fade: 1.5 }; touch(); renderLeft(); } }, '⬆ Upload');
    box.append(h('div', { class: 'row' }, up));
    if (field === 'narration') { const rec = h('button', { class: 'sm', onclick: async () => { await toggleRecord('narr', async (blob) => { const key = await putBlob(blob, 'Recorded narration'); sc.narration = { key, name: 'Recorded narration', vol: 1 }; touch(); renderLeft(); }); } }, recordingFor === 'narr' ? '⏹ Stop' : '⏺ Record'); rec.id = 'recNarr'; if (recordingFor === 'narr') rec.classList.add('on'); box.firstChild.append(rec); }
  }
  return box;
}
async function toggleRecord(who, onDone) {
  try {
    if (recorder) { const r = recorder; recorder = null; const was = recordingFor; recordingFor = null; const blob = await r.stop(); await onDone(blob); toast('Recording saved'); renderRight(); renderLeft(); return; }
    recorder = await startRecording(); recordingFor = who; toast('Recording… click again to stop'); renderRight(); renderLeft();
  } catch (e) { recorder = null; recordingFor = null; toast('Microphone unavailable: ' + e.message); renderRight(); renderLeft(); }
}

/* ======================= RIGHT: tabs ======================= */
function renderRight() {
  const R = $('#right'); R.innerHTML = ''; binds = [];
  const tabs = [['chars', '🧑 Characters'], ['props', '🪑 Props'], ['dialog', '💬 Dialog'], ['camera', '🎥 Camera']];
  R.append(h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; if (k === 'camera') { engine.setEditing(true); } renderRight(); } }, l))));
  ({ chars: tabChars, props: tabProps, dialog: tabDialog, camera: tabCamera })[tab](R);
}

function tabChars(R) {
  const sc = scene(); R.append(h('h3', {}, `Characters in scene (${sc.chars.length}/${MAX_CHARS})`));
  const add = select(CHAR_ORDER.map(k => [k, CHARS[k].name]), 'woman', () => { });
  R.append(row('', add, h('button', { class: 'primary sm', disabled: sc.chars.length >= MAX_CHARS, onclick: () => { const ch = newChar(add.value, sc); sc.chars.push(ch); engine.syncEntities(sc); selectEntity({ kind: 'char', id: ch.id }); touch(); } }, '+ Add')));
  if (sc.chars.length >= MAX_CHARS) R.append(h('div', { class: 'muted small' }, 'Maximum 5 characters per scene.'));
  sc.chars.forEach(ch => R.append(h('div', { class: 'item' + (sel?.id === ch.id ? ' sel' : ''), onclick: () => selectEntity({ kind: 'char', id: ch.id }) }, h('span', { class: 'grow' }, ch.name),
    h('button', { class: 'sm danger', onclick: e => { e.stopPropagation(); sc.dialogs = sc.dialogs.filter(d => d.charId !== ch.id); sc.chars = sc.chars.filter(c => c.id !== ch.id); if (sel?.id === ch.id) sel = null; engine.syncEntities(sc); engine.select(sel, sc, gizmoMode); frame(); touch(); renderAll(); } }, '✕'))));
  const ch = selChar(); if (!ch) { R.append(h('p', { class: 'muted' }, 'Add a character, then click it to edit position, path, facing and actions.')); return; }
  const kind = CHARS[ch.type].kind === 'animal' ? 'animal' : 'human';
  R.append(h('h3', {}, 'Selected: ' + ch.name));
  R.append(row('Name', txt(ch, 'name', () => { })));
  R.append(row('Position', h('span', {}, 'X '), num(ch, 'x', { after: () => engine.select(sel, sc, gizmoMode), w: '64px' }), h('span', {}, 'Z '), num(ch, 'z', { after: () => engine.select(sel, sc, gizmoMode), w: '64px' })));
  R.append(row('Facing °', num(ch, 'facing', { step: 5, after: () => engine.select(sel, sc, gizmoMode), w: '70px' }), h('span', { class: 'muted small' }, '0 = toward the default camera, 180 = away')));
  R.append(row('Scale', num(ch, 'scale', { min: 0.3, max: 3, step: 0.05, w: '70px' }), h('span', {}, 'Speed'), num(ch, 'speed', { min: 0.1, max: 8, step: 0.1, w: '64px' }), h('span', { class: 'muted' }, 'm/s')));
  R.append(h('div', { class: 'row' }, h('button', { class: gizmoMode === 'translate' ? 'on sm' : 'sm', onclick: () => setGizmo('translate') }, '✥ Move'), h('button', { class: gizmoMode === 'rotate' ? 'on sm' : 'sm', onclick: () => setGizmo('rotate') }, '⟳ Turn')));

  R.append(h('h3', {}, 'Walking path'));
  R.append(h('div', { class: 'row' },
    h('button', { class: pathMode ? 'on sm' : 'sm', onclick: () => { setPathMode(!pathMode); renderRight(); } }, pathMode ? '✔ Click ground to add points…' : '✎ Draw path'),
    h('button', { class: 'sm', disabled: !ch.path.length, onclick: () => { ch.path.pop(); touch(); engine.updateHelpers(sc); frame(); renderRight(); } }, '↶ Undo'),
    h('button', { class: 'sm danger', disabled: !ch.path.length, onclick: () => { ch.path = []; touch(); engine.updateHelpers(sc); frame(); renderRight(); } }, 'Clear')));
  R.append(row('Start walking at', num(ch, 'pathStart', { min: 0, step: 0.5, w: '64px' }), h('span', { class: 'muted' }, 's · points: ' + ch.path.length)));
  const ef = h('input', { type: 'number', step: 5, placeholder: 'keep', style: { width: '72px' } }); ef.value = ch.endFacing ?? ''; ef.oninput = () => { ch.endFacing = ef.value === '' ? null : +ef.value; touch(); frame(); };
  R.append(row('Face after', ef, h('span', { class: 'muted small' }, '° (blank = keep walking direction)')));

  R.append(h('h3', {}, 'Actions timeline'));
  const defs = ACTIONS[kind];
  [...ch.actions].sort((a, b) => a.t - b.t).forEach(a => {
    const def = defs.find(d => d.id === a.action);
    const seat = (kind === 'human' && SEATABLE.has(a.action)) ? select([['', 'standing'], ['chair', 'on chair'], ['floor', 'on floor']], a.seat || '', v => { a.seat = v; touch(); frame(); }) : null;
    R.append(h('div', { class: 'card' }, h('div', { class: 'row' }, num(a, 't', { min: 0, step: 0.5, w: '58px', after: () => { } }), h('span', { class: 'muted' }, 's'),
      select(defs.map(d => [d.id, d.label]), a.action, v => { a.action = v; if (defs.find(d => d.id === v)?.seat) a.seat = ''; touch(); frame(); renderRight(); }), seat,
      h('button', { class: 'sm danger', disabled: ch.actions.length < 2, onclick: () => { ch.actions.splice(ch.actions.indexOf(a), 1); touch(); frame(); renderRight(); } }, '✕'))));
  });
  R.append(h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => { ch.actions.push({ t: r1(t), action: defs[1 + (ch.actions.length % (defs.length - 1))].id, seat: '' }); touch(); frame(); renderRight(); } }, '+ Add action at playhead (' + r1(t) + 's)')));
  R.append(h('p', { class: 'muted small' }, kind === 'human' ? 'Walking is automatic while on a path. Actions like “Carry doko” keep their pose while walking.' : 'Animals walk automatically along their path.'));
  R.append(h('h3', {}, 'Custom 3D model (.glb)'));
  R.append(h('div', { class: 'row' }, h('button', { class: 'sm', onclick: async () => { const f = await pickFile('.glb,.gltf,model/gltf-binary'); if (!f) return; ch.glb = await putBlob(f, f.name); touch(); await applyGlbs(); renderRight(); } }, ch.glb ? 'Replace .glb' : '⬆ Upload .glb'), ch.glb ? h('button', { class: 'sm danger', onclick: () => { ch.glb = null; removeGlb('char', ch.id); touch(); renderRight(); } }, 'Use built-in model') : null));
  glbControls(R, ch, 'char');
}

function glbControls(R, obj, kind) {
  const info = obj.glb ? engine.glbInfo(kind, obj.id) : null; if (!info) return;
  if (kind === 'char') R.append(row('Turn model', select([['0', '0° (as exported)'], ['90', '90°'], ['180', '180° (face the other way)'], ['270', '270°']], String(obj.glbYaw || 0), v => { obj.glbYaw = +v; touch(); frame(); })));
  if (!info.clips.length) {
    R.append(h('p', { class: 'muted small' }, kind === 'char' ? 'This model has no built-in animations, so it glides along the path with a small walking bounce and a gentle sway while talking. For real walking/talking, upload a rigged model with animation clips (e.g. from Mixamo or Ready Player Me).' : 'This model has no built-in animations.'));
  } else if (kind === 'char') {
    R.append(h('p', { class: 'muted small' }, `Built-in animations found: ${info.clips.join(', ')}. Pick which one plays for each state (Auto guesses by name).`));
    for (const [st, label] of [['idle', 'Standing'], ['walk', 'Walking'], ['run', 'Running'], ['talk', 'Talking']]) {
      R.append(row(label, select([['auto', 'Auto' + (info.auto[st] ? ' (' + info.auto[st] + ')' : ' (none found)')], ['none', 'None'], ...info.clips.map(n => [n, n])], obj.glbAnim?.[st] || 'auto', v => { obj.glbAnim ||= {}; if (v === 'auto') delete obj.glbAnim[st]; else obj.glbAnim[st] = v; touch(); frame(); })));
    }
    R.append(h('p', { class: 'muted small' }, 'Press Play to see the animation (the clip changes automatically between standing, walking and talking).'));
  } else {
    R.append(row('Animation', select([['auto', 'Auto (' + info.clips[0] + ')'], ['none', 'None (still)'], ...info.clips.map(n => [n, n])], obj.glbAnim || 'auto', v => { if (v === 'auto') delete obj.glbAnim; else obj.glbAnim = v; touch(); frame(); }), 'Speed', num(obj, 'glbSpeed', { min: 0.1, max: 5, step: 0.1, w: '60px' })));
  }
  if (info.mouth) R.append(h('p', { class: 'muted small' }, '✔ Mouth shape found in this model: its mouth moves with the speech (lip-sync).'));
}

function tabProps(R) {
  const sc = scene(); R.append(h('h3', {}, 'Objects in scene'));
  const add = select(Object.entries(PROPS), 'money_notes', () => { });
  R.append(row('', add, h('button', { class: 'primary sm', onclick: () => { const p = newProp(add.value, sc); sc.props.push(p); engine.syncEntities(sc); selectEntity({ kind: 'prop', id: p.id }); touch(); } }, '+ Add')));
  sc.props.forEach(p => R.append(h('div', { class: 'item' + (sel?.id === p.id ? ' sel' : ''), onclick: () => selectEntity({ kind: 'prop', id: p.id }) }, h('span', { class: 'grow' }, PROPS[p.type]),
    h('button', { class: 'sm danger', onclick: e => { e.stopPropagation(); sc.props = sc.props.filter(q => q.id !== p.id); if (sel?.id === p.id) sel = null; engine.syncEntities(sc); engine.select(sel, sc, gizmoMode); frame(); touch(); renderRight(); } }, '✕'))));
  const p = selProp(); if (!p) { R.append(h('p', { class: 'muted' }, 'Add objects such as chair, table, gundro, galaicha, doko, money… then drag them in the 3D view.')); return; }
  const upd = () => { engine.syncEntities(sc); engine.select(sel, sc, gizmoMode); frame(); };
  R.append(h('h3', {}, 'Selected: ' + PROPS[p.type]));
  R.append(row('X / Z', num(p, 'x', { after: upd, w: '64px' }), num(p, 'z', { after: upd, w: '64px' })));
  R.append(row('Height Y', num(p, 'y', { after: upd, w: '64px' }), h('span', {}, 'Rotate °'), num(p, 'ry', { step: 5, after: upd, w: '64px' })));
  R.append(row('Scale', num(p, 'scale', { min: 0.1, max: 8, step: 0.1, after: upd, w: '64px' })));
  R.append(h('div', { class: 'row' }, ['translate', 'rotate', 'scale'].map(m => h('button', { class: gizmoMode === m ? 'on sm' : 'sm', onclick: () => setGizmo(m) }, { translate: '✥ Move', rotate: '⟳ Turn', scale: '⤢ Scale' }[m]))));
  R.append(h('div', { class: 'row' }, h('button', { class: 'sm', onclick: async () => { const f = await pickFile('.glb,.gltf'); if (!f) return; p.glb = await putBlob(f, f.name); touch(); await applyGlbs(); renderRight(); } }, p.glb ? 'Replace .glb' : '⬆ Upload .glb'), p.glb ? h('button', { class: 'sm danger', onclick: () => { p.glb = null; removeGlb('prop', p.id); touch(); renderRight(); } }, 'Use built-in model') : null));
  glbControls(R, p, 'prop');
}

/* ---------- dialog ---------- */
/* ---- keep the scene long enough for its dialog + tidy overlapping lines ---- */
function fitAndRefresh(sc, quiet = false) {
  if (!fitSceneToDialogs(sc)) return false;
  t = Math.min(t, sc.duration); renderLeft(); renderTransport(); redrawTimeline(); touch(false);
  if (!quiet) toast(`Scene extended to ${sc.duration}s so the dialog fits`); return true;
}
// shift later lines forward so speech never overlaps the previous line
function spaceDialogs(sc, gap = 0.5) {
  let end = 0; for (const d of [...sc.dialogs].sort((a, b) => a.t - b.t)) { if (!d.text.trim() && !d.audioKey) continue; if (end > 0 && d.t < end + 0.01) d.t = Math.round((end + gap) * 10) / 10; end = d.t + dialogDur(d); }
}
const autoGrow = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.max(48, ta.scrollHeight + 2) + 'px'; };
function tabDialog(R) {
  const sc = scene();
  R.append(h('h3', {}, 'Dialog lines'));
  const bulk = select([['auto', 'Auto (by character)'], ['male', 'Male voice'], ['female', 'Female voice'], ['narrator', 'Narrator voice']], 'auto', () => { });
  R.append(row('All dialog', bulk, h('button', { class: 'sm', onclick: () => { project.scenes.forEach(s => s.dialogs.forEach(d => { d.voice = bulk.value; })); touch(); renderRight(); toast('Voice applied to every dialog in every scene'); } }, 'Apply to all')));
  R.append(h('div', { class: 'row' },
    h('button', { class: 'primary sm', onclick: () => { const d = newDialog(sc); sc.dialogs.push(d); selDialog = d.id; touch(); renderRight(); } }, '+ Add dialog'),
    h('button', { class: 'sm', title: 'Silently measure how long each line really takes with the browser voice, then re-space the lines and lengthen the scene if needed', onclick: async (e) => { const b = e.target; b.disabled = true; await measureScenes([sc], m => { b.textContent = m; }, true); touch(); renderAll(); toast('Lines measured; scene length adjusted to fit'); } }, '⏱ Measure all'),
    h('button', { class: 'sm', title: 'Measure the speech of every scene in one go', onclick: (e) => measureEverything(e.currentTarget) }, '⏱ All scenes')));
  if (!sc.dialogs.length) R.append(h('p', { class: 'muted' }, 'Add a dialog line, choose who speaks and when it starts. Use the browser voice, upload an audio file, or record with your microphone.'));
  [...sc.dialogs].sort((a, b) => a.t - b.t).forEach(d => {
    const speaker = sc.chars.find(c => c.id === d.charId);
    const vt = voiceTypeFor(sc, d);
    const status = d.audioKey ? h('span', { class: 'badge ok' }, '✔ ' + (d.audioName || 'audio') + ' · ' + d.dur.toFixed(1) + 's') : h('span', { class: 'badge ok' }, '🔊 browser voice' + (d.dur ? ' · ' + d.dur.toFixed(1) + 's' : '') + ' — preview; use Live export');
    const card = h('div', { class: 'card' + (selDialog === d.id ? ' sel' : ''), onclick: () => { selDialog = d.id; redrawTimeline(); } });
    card.append(
      h('div', { class: 'row' }, select([['', '— Narrator / off-screen —'], ...sc.chars.map(c => [c.id, c.name])], d.charId || '', v => { d.charId = v || null; touch(); frame(); renderRight(); }),
        h('button', { class: 'sm danger', onclick: () => { sc.dialogs = sc.dialogs.filter(x => x !== d); touch(); renderRight(); } }, '✕')),
      row('Starts at', num(d, 't', { min: 0, step: 0.1, w: '64px', after: () => fitAndRefresh(sc) }), h('span', { class: 'muted' }, 's')),
      row('Language', select(Object.entries(LANGS), d.lang || 'ne', v => { d.lang = v; touch(); renderRight(); }), select([['auto', 'auto (' + vt + ')'], ['male', 'male'], ['female', 'female'], ['narrator', 'narrator']], d.voice || 'auto', v => { d.voice = v; touch(); renderRight(); })),
      (() => { const ta = h('textarea', { placeholder: 'Dialog text (used for text-to-speech and the talking animation)…' }); ta.value = d.text; ta.oninput = () => { d.text = ta.value; d.measured = false; autoGrow(ta); fitAndRefresh(sc, true); touch(false); }; requestAnimationFrame(() => autoGrow(ta)); return ta; })(),
      h('div', { class: 'row' },
        d.audioKey ? null : h('button', { class: 'sm', onclick: async (e) => { if (!browserTtsAvailable()) return toast('This browser has no speech synthesis'); if (!d.text.trim()) return toast('Type the dialog text first'); d.source = 'tts'; cancelBrowser(); const b = e.target; b.textContent = '🔊 Speaking…'; await speakBrowser(d.text, browserProfile(project, sc, d)); b.textContent = '🗣 Speak'; } }, '🗣 Speak'),
        d.audioKey ? null : h('button', { class: 'sm', title: 'Measure the real length of this line with the chosen browser voice (silent)', onclick: async (e) => { const b = e.target; b.disabled = true; b.textContent = 'Measuring…'; const r = await measureBrowser(d.text, browserProfile(project, sc, d)); d.dur = +r.dur.toFixed(2); d.lat = +r.lat.toFixed(2); d.measured = true; fitAndRefresh(sc); touch(); renderRight(); } }, '⏱ Measure'),
        h('button', { class: 'sm', onclick: async () => { const f = await pickFile('audio/*'); if (!f) return; d.audioKey = await putBlob(f, f.name); d.audioName = f.name; d.dur = await audioDuration(f); d.source = 'upload'; fitAndRefresh(sc); touch(); renderRight(); } }, '⬆ Upload'),
        h('button', { class: recordingFor === d.id ? 'on sm' : 'sm', onclick: () => toggleRecord(d.id, async (blob) => { d.audioKey = await putBlob(blob, 'Recording'); d.audioName = 'Recording'; d.dur = await audioDuration(blob); d.source = 'record'; fitAndRefresh(sc); touch(); }) }, recordingFor === d.id ? '⏹ Stop' : '⏺ Record'),
        h('button', { class: 'sm', disabled: !d.audioKey && !d.text.trim(), onclick: () => { if (d.audioKey) playDialog(d); else { cancelBrowser(); speakBrowser(d.text, browserProfile(project, sc, d)); } } }, '▶'),
        d.audioKey ? h('button', { class: 'sm danger', title: 'Remove audio (use the browser voice again)', onclick: () => { d.audioKey = null; d.audioName = ''; d.dur = 0; touch(); renderRight(); } }, '🗑') : null),
      h('div', { class: 'row' }, status));
    R.append(card);
  });
  R.append(h('p', { class: 'muted small' }, 'Text-to-speech uses your browser’s voices (Edge: Microsoft Natural voices, Chrome: Google voices). Uploaded or recorded audio replaces the browser voice for that line. Choose voices in 🎙 Voices.'));
}
async function playDialog(d) { const b = await getBuffer(d.audioKey); if (!b) return toast('Audio could not be decoded'); const c = actx(); if (c.state === 'suspended') await c.resume(); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(); }
/* ---------- camera ---------- */
function tabCamera(R) {
  const sc = scene(); const cam = sc.camera;
  R.append(h('h3', {}, 'Camera for this scene'));
  R.append(h('label', { class: 'chk', style: { margin: '4px 0 8px' }, title: 'While a character speaks, cut to a close-up of their face' }, h('input', { type: 'checkbox', checked: !!cam.closeups, onchange: e => { cam.closeups = e.target.checked; touch(false); frame(false); } }), 'Auto close-up on the speaker'));
  R.append(h('div', { class: 'row' }, h('button', { class: camKey === 'start' ? 'on sm' : 'sm', onclick: () => { camKey = 'start'; applyKeyCamera(); renderRight(); engine.render(); } }, 'Start view'),
    h('button', { class: camKey === 'end' ? 'on sm' : 'sm', onclick: () => { if (!cam.end) cam.end = structuredClone(cam.start); camKey = 'end'; applyKeyCamera(); touch(); renderRight(); engine.render(); } }, cam.end ? 'End view' : '+ Add end view (camera move)'),
    cam.end ? h('button', { class: 'sm danger', onclick: () => { cam.end = null; camKey = 'start'; applyKeyCamera(); touch(); renderRight(); engine.render(); } }, 'Remove end') : null));
  R.append(h('p', { class: 'muted small' }, `Editing the ${camKey.toUpperCase()} view. Drag in the 3D view to orbit (left), pan (right), zoom (wheel). ${cam.end ? 'The camera glides smoothly from start to end over the scene.' : 'Add an end view to animate a camera move.'}`));
  R.append(h('h3', {}, 'Angle presets'));
  const who = selChar() || sc.chars[0]; R.append(h('div', { class: 'muted small' }, who ? `Framed around: ${who.name}` : 'Framed around the scene center (add a character to frame it)'));
  R.append(h('div', { class: 'row' }, CAM_PRESETS.map(p => h('button', { class: 'sm', onclick: () => applyPreset(p) }, p))));
  const k = sc.camera[camKey];
  const fov = h('input', { type: 'range', min: 15, max: 90, step: 1, value: k.fov }); fov.oninput = () => { k.fov = +fov.value; engine.camera.fov = k.fov; engine.camera.updateProjectionMatrix(); engine.render(); touch(false); };
  R.append(row('Field of view', fov));
  R.append(h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => { const d = ENVS[sc.env].cam; cam[camKey] = { pos: [...d.pos], target: [...d.target], fov: d.fov }; applyKeyCamera(); touch(); engine.render(); renderRight(); } }, 'Reset to scene default')));
}
function applyPreset(name) {
  const sc = scene(); const ch = selChar() || sc.chars[0]; let x, z, hd = 0;
  if (ch) { const s = charState(sc, ch, 0); x = s.x; z = s.z; hd = s.h; } else { const d = ENVS[sc.env].cam.target; x = d[0]; z = d[2]; hd = 0; }
  const c = presetCamera(name, x, z, hd); sc.camera[camKey] = c; applyKeyCamera(); touch(); engine.render(); renderRight();
}

/* ---------- selection ---------- */
function selectEntity(ent) {
  sel = ent; if (ent) { tab = ent.kind === 'char' ? (tab === 'dialog' || tab === 'camera' ? tab : 'chars') : 'props'; }
  if (pathMode && !selChar()) setPathMode(false);
  engine.select(sel, scene(), gizmoMode); engine.setEditing(!playing); frame(); renderRight(); renderTimeline(); renderHud();
}
function setGizmo(m) { gizmoMode = m; engine.select(sel, scene(), m); engine.render(); renderRight(); renderHud(); }
function setPathMode(b) { pathMode = b; engine.pathMode = b; engine.canvas.style.cursor = b ? 'crosshair' : ''; renderHud(); }
function transformEntity(s, proxy) {
  const sc = scene(); if (!s) return;
  if (s.kind === 'char') { const ch = sc.chars.find(c => c.id === s.id); ch.x = r1(proxy.position.x); ch.z = r1(proxy.position.z); if (gizmoMode === 'rotate') ch.facing = Math.round(((proxy.rotation.y * 180 / Math.PI) % 360 + 360) % 360); }
  else { const p = sc.props.find(c => c.id === s.id); p.x = r1(proxy.position.x); p.y = r1(proxy.position.y); p.z = r1(proxy.position.z); p.ry = Math.round(proxy.rotation.y * 180 / Math.PI); p.scale = Math.max(0.1, +proxy.scale.x.toFixed(2)); }
  syncBinds(); touch(); engine.syncEntities(sc); frame();
}
function renderHud() {
  const H = $('#hud'); H.innerHTML = ''; const ch = selChar(), p = selProp();
  if (ch) { H.append(h('button', { class: gizmoMode === 'translate' ? 'on sm' : 'sm', onclick: () => setGizmo('translate') }, '✥ Move'), h('button', { class: gizmoMode === 'rotate' ? 'on sm' : 'sm', onclick: () => setGizmo('rotate') }, '⟳ Turn'), h('button', { class: pathMode ? 'on sm' : 'sm', onclick: () => { setPathMode(!pathMode); renderRight(); } }, pathMode ? '✔ Click the ground to add path points' : '✎ Draw walking path')); }
  else if (p) H.append(...['translate', 'rotate', 'scale'].map(m => h('button', { class: gizmoMode === m ? 'on sm' : 'sm', onclick: () => setGizmo(m) }, { translate: '✥ Move', rotate: '⟳ Turn', scale: '⤢ Scale' }[m])));
}

/* ---------- browser-voice scheduling (preview + live export) ---------- */
let spoken = new Set(), tailEnd = null, learned = false;
const liveStates = new Map(); speechState.map = liveStates;   // dialogId -> 'pending' | 'speaking' | 'done'
const speechBusy = () => [...liveStates.values()].some(v => v !== 'done');
function resetSpeech(from = 0) { cancelBrowser(); liveStates.clear(); tailEnd = null; spoken = new Set(scene().dialogs.filter(d => d.t < from - 0.05).map(d => d.id)); }
function tickSpeech(sc, tt, fresh) {
  if (fresh) { spoken = new Set(); liveStates.clear(); }
  for (const d of sc.dialogs) {
    // start a little early by the voice's start-up delay so sound and mouth begin on the line's start time
    if (d.audioKey || !d.text.trim() || spoken.has(d.id) || tt < d.t - Math.min(2.5, d.lat || 0)) continue;
    spoken.add(d.id); liveStates.set(d.id, 'pending'); let t0 = 0;
    speakBrowser(d.text, { ...browserProfile(project, sc, d),
      onstart: () => { t0 = performance.now(); liveStates.set(d.id, 'speaking'); },
      onend: (ok) => { liveStates.set(d.id, 'done'); const real = t0 ? (performance.now() - t0) / 1000 : 0; if (ok && real > 0.4) { d.dur = +real.toFixed(2); d.measured = true; learned = true; } } });
  }
}
// after real playback, remember the true line lengths: space the lines and lengthen the scene if needed
function learnTimings(sc) { if (!learned) return; learned = false; spaceDialogs(sc); fitSceneToDialogs(sc); touch(false); renderLeft(); renderRight(); redrawTimeline(); }
// a scene may only end when no line is still being spoken (plus a short pause)
function sceneMayEnd() { if (speechBusy()) { tailEnd = null; return false; } if (tailEnd === null) tailEnd = t + 0.7; return t >= tailEnd; }
let measureAbort = false, measuring = false;
async function measureScenes(scenes, onMsg, force = false) {
  const todo = []; for (const sc of scenes) for (const d of sc.dialogs) if (!d.audioKey && d.text.trim() && (force || !d.measured)) todo.push([sc, d]);
  let i = 0; for (const [sc, d] of todo) { onMsg?.(`Measuring speech ${++i}/${todo.length}…`); if (measureAbort) break; const r = await measureBrowser(d.text, browserProfile(project, sc, d)); if (measureAbort) break; d.dur = +r.dur.toFixed(2); d.lat = +r.lat.toFixed(2); d.measured = true; }
  for (const sc of scenes) { spaceDialogs(sc); fitSceneToDialogs(sc); } if (todo.length) touch(false);
}
const hasBrowserLines = (scenes) => scenes.some(sc => sc.dialogs.some(d => !d.audioKey && d.text.trim()));

/* ======================= TRANSPORT / playback ======================= */
function renderTransport() {
  const T = $('#transport'); T.innerHTML = ''; const sc = scene();
  const pp = h('button', { class: 'primary', id: 'bPlay', onclick: () => playing ? pauseNow() : play() }, playing ? '⏸ Pause' : '▶ Play');
  const slider = h('input', { type: 'range', id: 'scrub', min: 0, max: sc.duration, step: 0.05, value: t }); slider.oninput = () => { t = +slider.value; if (playing) { player.stop(); player.play(scene(), t); resetSpeech(t); } frame(); updateTime(); };
  const all = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: playAll, onchange: e => { playAll = e.target.checked; } }), 'all scenes');
  const pc = h('label', { class: 'chk', title: 'Show the camera move while scrubbing' }, h('input', { type: 'checkbox', checked: previewCam, onchange: e => { previewCam = e.target.checked; if (!previewCam) applyKeyCamera(); frame(); } }), 'preview camera');
  T.append(pp, h('button', { onclick: () => stopPlay(true) }, '⏹'), slider, h('span', { class: 'time', id: 'timeTxt' }), all, pc); updateTime();
}
function updateTime() { const el = $('#timeTxt'); if (el) el.textContent = `${fmt(t)} / ${fmt(scene().duration)}`; const s = $('#scrub'); if (s && document.activeElement !== s) { s.max = scene().duration; s.value = t; } placePlayhead(); }
function play() {
  if (playing) return; if (t >= scene().duration - 0.05) t = 0; playing = true; setPathMode(false); engine.setEditing(false); engine.select(null, scene()); lastTs = performance.now();
  resetSpeech(t); player.play(scene(), t).catch(() => { }); $('#bPlay').textContent = '⏸ Pause'; $('#bPlay').classList.remove('primary'); requestAnimationFrame(loop);
}
function pauseNow() { playing = false; player.stop(); cancelBrowser(); liveStates.clear(); tailEnd = null; engine.fade = 1; engine.setEditing(true); engine.select(sel, scene(), gizmoMode); if (!previewCam) applyKeyCamera(); frame(); renderTransport(); }
function stopPlay(reset = false) { cancelBrowser(); liveStates.clear(); tailEnd = null; if (playing) { playing = false; player.stop(); } engine.fade = 1; engine.setEditing(true); if (reset) { t = 0; engine.select(sel, scene(), gizmoMode); applyKeyCamera(); frame(false); } renderTransport(); }
function loop(ts) {
  if (!playing) return; const dt = Math.min(0.1, (ts - lastTs) / 1000); lastTs = ts; t += dt; let sc = scene();
  if (t >= sc.duration && sceneMayEnd()) {
    learnTimings(sc); tailEnd = null;
    if (playAll && si < project.scenes.length - 1) { si++; sc = scene(); t = 0; engine.loadScene(sc); applyGlbs(); player.play(sc, 0).catch(() => { }); resetSpeech(0); renderLeft(); renderTimeline(); renderTransport(); engine.select(null, sc); }
    else { t = sc.duration; frame(true); playing = false; player.stop(); cancelBrowser(); liveStates.clear(); engine.fade = 1; engine.setEditing(true); engine.select(sel, sc, gizmoMode); renderTransport(); return; }
  }
  const f = 0.45; const endT = t >= sc.duration ? (tailEnd ?? 1e9) : sc.duration; engine.fade = project.fade ? Math.min(smoothStep(t / f), smoothStep((endT - t) / f)) : 1;
  tickSpeech(sc, t, false); frame(true); updateTime(); requestAnimationFrame(loop);
}
const smoothStep = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

/* ======================= TIMELINE ======================= */
const LAB = 120; let pps = 40;
function redrawTimeline() { renderTimeline(); }
function placePlayhead() { const ph = $('#timeline .playhead'); if (ph) ph.style.left = (LAB + t * pps) + 'px'; }
function renderTimeline() {
  const box = $('#timeline'); const sc = scene(); const sl = box.scrollLeft; box.innerHTML = '';
  pps = Math.max(22, Math.floor((box.clientWidth - LAB - 24) / sc.duration)); const W = Math.ceil(sc.duration * pps) + 24;
  const wrap = h('div', { class: 'tl', style: { width: (W + LAB) + 'px' } });
  const lane = (children, cls = '') => h('div', { class: 'tl-lane ' + cls, style: { width: W + 'px', height: '26px' } }, children);
  // ruler
  const ruler = h('div', { class: 'tl-lane ruler', style: { width: W + 'px' } }); const step = pps >= 40 ? 1 : pps >= 22 ? 2 : 5;
  for (let s = 0; s <= sc.duration; s += step) ruler.append(h('div', { class: 'tick', style: { left: s * pps + 'px' } }, s + 's'));
  const scrubTo = (e) => { const r = ruler.getBoundingClientRect(); t = clamp((e.clientX - r.left) / pps, 0, sc.duration); if (playing) { player.stop(); player.play(sc, t); resetSpeech(t); } frame(); updateTime(); };
  ruler.addEventListener('pointerdown', e => { ruler.setPointerCapture(e.pointerId); scrubTo(e); const mv = ev => scrubTo(ev); const up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); }; ruler.addEventListener('pointermove', mv); ruler.addEventListener('pointerup', up); });
  wrap.append(h('div', { class: 'tl-row', style: { height: '22px' } }, h('div', { class: 'tl-label' }, 'Time'), ruler));

  sc.chars.forEach(ch => {
    const kids = []; const poly = ch.path.length;
    if (poly) { let len = 0; let px = ch.x, pz = ch.z; ch.path.forEach(p => { len += Math.hypot(p[0] - px, p[1] - pz); px = p[0]; pz = p[1]; }); const w = Math.max(30, len / Math.max(0.05, ch.speed) * pps);
      const chip = h('div', { class: 'chip path' + (sel?.id === ch.id ? ' sel' : ''), title: 'Walking path — drag to change start time', style: { left: ch.pathStart * pps + 'px', width: w + 'px' } }, '🚶 walk ' + (len / ch.speed).toFixed(1) + 's');
      let o; drag(chip, dx => { ch.pathStart = clamp(r1(o + dx / pps), 0, sc.duration); chip.style.left = ch.pathStart * pps + 'px'; t = ch.pathStart; frame(); updateTime(); }, () => { o = ch.pathStart; selectEntity({ kind: 'char', id: ch.id }); }, () => { touch(); renderTimeline(); renderRight(); }); kids.push(chip); }
    ch.actions.forEach(a => { const lbl = (ACTIONS[CHARS[ch.type].kind === 'animal' ? 'animal' : 'human'].find(d => d.id === a.action)?.label || a.action) + (a.seat ? ' (seated)' : '');
      const chip = h('div', { class: 'chip act', title: 'Drag to change start time', style: { left: a.t * pps + 'px', top: poly ? '3px' : '3px', maxWidth: '140px', marginTop: poly ? '0' : '0' } }, lbl); let o;
      drag(chip, dx => { a.t = clamp(r1(o + dx / pps), 0, sc.duration); chip.style.left = a.t * pps + 'px'; t = a.t; frame(); updateTime(); }, () => { o = a.t; selectEntity({ kind: 'char', id: ch.id }); }, () => { touch(); renderTimeline(); renderRight(); }); kids.push(chip); });
    wrap.append(h('div', { class: 'tl-row' }, h('div', { class: 'tl-label', title: ch.name }, '🧑 ' + ch.name), lane(kids)));
  });
  // dialogs
  const dk = sc.dialogs.map(d => { const w = Math.max(40, dialogDur(d) * pps); const sp = sc.chars.find(c => c.id === d.charId);
    const chip = h('div', { class: 'chip dlg' + (d.audioKey ? '' : ' nogen') + (selDialog === d.id ? ' sel' : ''), title: (d.text || '(no text)') + ' — drag to set the start time', style: { left: d.t * pps + 'px', width: w + 'px' } }, '💬 ' + ((sp ? sp.name + ': ' : '') + (d.text || '…'))); let o;
    drag(chip, dx => { d.t = clamp(r1(o + dx / pps), 0, sc.duration - 0.2); chip.style.left = d.t * pps + 'px'; t = d.t; frame(); updateTime(); }, () => { o = d.t; selDialog = d.id; tab = 'dialog'; }, () => { touch(); renderTimeline(); renderRight(); }); return chip; });
  wrap.append(h('div', { class: 'tl-row' }, h('div', { class: 'tl-label' }, '💬 Dialog'), lane(dk)));
  wrap.append(h('div', { class: 'tl-row' }, h('div', { class: 'tl-label' }, '🎙 Narration'), lane(sc.narration?.key ? [h('div', { class: 'chip bar', style: { left: '0', width: W - 24 + 'px' } }, sc.narration.name)] : [])));
  wrap.append(h('div', { class: 'tl-row' }, h('div', { class: 'tl-label' }, '🎵 Music'), lane(sc.music?.key ? [h('div', { class: 'chip bar music', style: { left: '0', width: W - 24 + 'px' } }, sc.music.name + ' (loops)')] : [])));
  wrap.append(h('div', { class: 'playhead', style: { left: (LAB + t * pps) + 'px' } }));
  box.append(wrap); box.scrollLeft = sl;
}

/* ======================= header: project, voices, export ======================= */
$('#projName').addEventListener('input', e => { project.name = e.target.value; touch(false); });
$('#quality').addEventListener('change', e => { try { localStorage.setItem('nss-quality', e.target.value); } catch { } $('#loading').hidden = false; $('#loading').textContent = 'Rebuilding scene…'; setTimeout(() => { engine.setQuality(e.target.value); goScene(si); $('#loading').hidden = true; }, 30); });
$('#bNew').onclick = () => { if (!confirm('Start a new project? Unsaved changes will be lost.')) return; project = newProject(); project.name = 'My Nepali Story'; $('#projName').value = project.name; touch(false); goScene(0); };
$('#bSave').onclick = async () => {
  const data = JSON.parse(JSON.stringify(project)); const keys = new Set();
  data.scenes.forEach(s => { if (s.narration?.key) keys.add(s.narration.key); if (s.music?.key) keys.add(s.music.key); s.dialogs.forEach(d => d.audioKey && keys.add(d.audioKey)); s.chars.forEach(c => c.glb && keys.add(c.glb)); s.props.forEach(p => p.glb && keys.add(p.glb)); });
  if ($('#saveAudio').checked) { data.audio = {}; for (const k of keys) { const b = await getBlob(k); if (b) data.audio[k] = await blobToDataUrl(b); } }
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), (project.name || 'story').replace(/[^\w\- ]+/g, '') + '.json'); toast('Project saved');
};
$('#bOpen').onclick = () => $('#fileOpen').click();
$('#fileOpen').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { const data = JSON.parse(await f.text()); if (!data.scenes) throw new Error('not a project file'); if (data.audio) { for (const [k, u] of Object.entries(data.audio)) await putBlob(await dataUrlToBlob(u), k, k); delete data.audio; } project = migrateProject(data); project.voices ||= structuredClone(DEFAULT_VOICES); $('#projName').value = project.name || ''; touch(false); goScene(0); toast('Project loaded'); } catch (er) { toast('Could not open project: ' + er.message); }
};

function modal(content) { const m = $('#modal'); m.innerHTML = ''; m.hidden = false; const box = h('div', { class: 'dlg-box' }, content); m.append(box); m.onclick = (e) => { if (e.target === m && !modal.locked) m.hidden = true; }; return box; }
const closeModal = () => { $('#modal').hidden = true; };

function browserVoiceRows(k, v) {
  const wrap = h('div', { class: 'row grow', style: { flexDirection: 'column', alignItems: 'stretch' } });
  const build = () => {
    wrap.innerHTML = '';
    if (!browserTtsAvailable()) { wrap.append(h('div', { class: 'muted small' }, 'This browser has no speech synthesis.')); return; }
    const all = getBrowserVoices(); const mine = voicesForLang(v.lang); const list = mine.length ? mine : all;
    const opts = [['', mine.length ? 'Auto-pick best ' + (LANGS[v.lang] || v.lang) + ' voice' : 'Default browser voice'], ...list.map(x => [x.name, `${x.name} (${x.lang})`])];
    const sel = select(opts, v.bVoice || '', x => { v.bVoice = x; touch(false); });
    const rate = h('input', { type: 'range', min: 0.5, max: 1.6, step: 0.05, value: v.bRate || 1 }); rate.oninput = () => { v.bRate = +rate.value; touch(false); };
    const bp = h('input', { type: 'range', min: 0.5, max: 1.6, step: 0.05, value: v.bPitch || 1 }); bp.oninput = () => { v.bPitch = +bp.value; touch(false); };
    wrap.append(h('div', { class: 'small', style: { marginTop: '6px' } }, h('b', {}, 'Browser voice (Edge / Chrome)')), row('Voice', sel), row('Speed', rate), row('Pitch', bp));
    if (!mine.length) wrap.append(h('div', { class: 'muted small' }, `No ${LANGS[v.lang] || v.lang} voice is installed in this browser. Edge has Microsoft Hindi/Nepali voices; Chrome has Google Hindi. You can also add language voices in your OS settings.`));
    wrap.append(h('button', { class: 'sm', onclick: async () => { cancelBrowser(); const text = v.lang === 'ne' ? 'नमस्ते, म तपाईंको गाउँको कथा सुनाउँछु।' : v.lang === 'hi' ? 'नमस्ते, मैं आपके गाँव की कहानी सुनाती हूँ।' : 'Hello, welcome to our village story.'; const voice = (v.bVoice && all.find(x => x.name === v.bVoice)) || null; await speakBrowser(text, { voice: voice || undefined, langCode: v.lang === 'ne' ? 'ne-NP' : v.lang === 'hi' ? 'hi-IN' : 'en-US', rate: v.bRate || 1, pitch: v.bPitch || 1 }); } }, '▶ Test browser voice'));
  };
  build(); window.addEventListener('nss-voices', build); return wrap;
}
$('#bVoices').onclick = () => {
  const box = h('div'); box.append(h('h2', {}, '🎙 Voices (browser text-to-speech)'), h('p', { class: 'muted small' }, 'These settings define the Male, Female and Narrator voices used for every dialog. Voices come from your browser (Microsoft Edge: Natural voices, Google Chrome: Google voices). Each dialog can still override its voice type.'));
  VOICE_TYPES.forEach(k => {
    const v = project.voices[k];
    box.append(h('div', { class: 'card' }, h('b', {}, { male: 'Male voice', female: 'Female voice', narrator: 'Narration voice' }[k]),
      row('Default lang', select(Object.entries(LANGS), v.lang, x => { v.lang = x; touch(false); window.dispatchEvent(new Event('nss-voices')); })),
      browserVoiceRows(k, v)));
  });
  box.append(h('div', { class: 'row' }, h('button', { class: 'primary', onclick: closeModal }, 'Done'))); modal(box);
};

$('#bExport').onclick = () => {
  const box = h('div'); const opts = { scope: 'all', res: 720, fps: 30, bmode: 'live' };
  const browserBox = h('div', { class: 'card' });
  const refreshBrowserBox = () => {
    const scs = opts.scope === 'all' ? project.scenes : [scene()]; browserBox.innerHTML = '';
    if (!hasBrowserLines(scs)) { browserBox.hidden = true; return; } browserBox.hidden = false;
    browserBox.append(h('b', {}, '🔊 Browser-voice lines found'), h('p', { class: 'small muted' }, 'Edge/Chrome voices are played by your computer and cannot be encoded offline. Choose how to include them:'),
      select([['live', 'Live export — record in real time with system audio'], ['skip', 'Skip them (silent in the video)']], opts.bmode, v => { opts.bmode = v; refreshBrowserBox(); }));
    if (opts.bmode === 'live') browserBox.append(h('p', { class: 'small muted' }, 'After pressing Start, your browser asks what to share: choose “Entire screen” and tick “Also share system audio” (Chrome/Edge on Windows or ChromeOS). Turn your speakers on, keep this tab visible and do not play other sounds. The video is recorded in real time, so it takes as long as the video itself.'));
  };
  const out = h('div', { class: 'muted small' }, 'Everything is rendered inside your browser. Keep this tab open and visible while exporting.');
  const bar = h('div', { class: 'bar', hidden: true }, h('i')); const msg = h('div', { class: 'small' });
  const ctrl = new AbortController(); let running = false;
  const startBtn = h('button', { class: 'primary' }, '▶ Start export'); const cancel = h('button', {}, 'Close');
  const total = project.scenes.reduce((a, s) => a + s.duration, 0);
  box.append(h('h2', {}, '⬇ Export video'), row('Scenes', select([['all', `All scenes (${total}s)`], ['current', `Current scene only (${scene().duration}s)`]], 'all', v => { opts.scope = v; refreshBrowserBox(); })),
    row('Resolution', select([[720, '1280×720 (HD)'], [1080, '1920×1080 (Full HD)']], 720, v => opts.res = +v)), row('Frame rate', select([[24, '24 fps'], [30, '30 fps']], 30, v => opts.fps = +v)),
    h('div', { class: 'small muted' }, 'Output is MP4 (H.264 + AAC) when your browser supports it, otherwise WebM (VP9 + Opus). Audio — dialog, narration and music — is always mixed in.'),
    browserBox, bar, msg, out, h('div', { class: 'row' }, startBtn, cancel));
  refreshBrowserBox(); modal(box);
  cancel.onclick = () => { if (running) { ctrl.abort(); } else closeModal(); };
  startBtn.onclick = async () => {
    if (running) return; running = true; modal.locked = true; startBtn.disabled = true; cancel.textContent = 'Cancel'; bar.hidden = false; pauseNow();
    const scenes = opts.scope === 'all' ? project.scenes : [scene()];
    let liveStream = null, disp = null;
    try {
      if (hasBrowserLines(scenes)) {
        if (opts.bmode === 'live') {
          if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen/audio capture is not available in this browser. Use desktop Chrome or Edge.');
          msg.textContent = 'Choose “Entire screen” and tick “Also share system audio”…';
          disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: 'include', selfBrowserSurface: 'include', surfaceSwitching: 'exclude' });
          const surf = disp.getVideoTracks()[0]?.getSettings?.().displaySurface;
          if (surf === 'browser') throw new Error('You shared a browser tab — Chrome cannot hear browser voices from a tab. Start again and choose “Entire screen”, then tick “Also share system audio”.');
          if (!disp.getAudioTracks().length) throw new Error('No audio was shared. Start again, choose “Entire screen” and tick “Also share system audio” (Windows / ChromeOS). On macOS use recorded or uploaded audio.');
          liveStream = new MediaStream(disp.getAudioTracks());
        }
        for (const sc of scenes) { for (const o of [...sc.chars, ...sc.props]) if (o.glb && !engine.glbCache.has(o.glb)) { const b = await getBlob(o.glb); if (b) { try { await engine.loadGlbEntry(o.glb, b); } catch { } } } }
        if (opts.bmode === 'live') { await measureScenes(scenes, m => { msg.textContent = m + ' (silent, so scenes are long enough for the speech)'; }); }
      }
      const res = await exportVideo({ engine, project, scenes, res: opts.res, fps: opts.fps, signal: ctrl.signal, liveStream, speechTick: (sc, tt, fresh) => tickSpeech(sc, tt, fresh), onProgress: (p, m) => { bar.firstChild.style.width = (p * 100).toFixed(1) + '%'; msg.textContent = m; } });
      bar.firstChild.style.width = '100%'; const name = (project.name || 'story').replace(/[^\w\- ]+/g, '') + '.' + res.ext; download(res.blob, name);
      msg.textContent = `✔ Done — ${name} (${(res.blob.size / 1048576).toFixed(1)} MB). ${res.info}`;
    } catch (er) { msg.textContent = er.name === 'AbortError' ? 'Export cancelled.' : 'Export failed: ' + er.message; console.error(er); }
    finally { cancelBrowser(); liveStates.clear(); disp?.getTracks().forEach(x => x.stop()); running = false; modal.locked = false; cancel.textContent = 'Close'; startBtn.disabled = false; engine.loadScene(scene()); applyKeyCamera(); engine.select(sel, scene(), gizmoMode); frame(false); }
  };
};


/* ---- resizable side panel ---- */
(() => {
  const app = $('#app'), rz = $('#rzr'); const set = (w) => app.style.setProperty('--rw', Math.round(Math.min(Math.max(w, 280), Math.min(900, innerWidth - 400))) + 'px');
  try { const w = +localStorage.getItem('nss-rw'); if (w) set(w); } catch { }
  rz.onpointerdown = (e) => { rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); };
  rz.onpointermove = (e) => { if (rz.classList.contains('drag')) set(innerWidth - e.clientX); };
  rz.onpointerup = () => { rz.classList.remove('drag'); try { localStorage.setItem('nss-rw', parseInt(app.style.getPropertyValue('--rw')) || 340); } catch { } };
})();

window.addEventListener('keydown', e => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return; if (e.code === 'Space') { e.preventDefault(); playing ? pauseNow() : play(); } });

window.__app = { get project() { return project; }, get scene() { return scene(); }, goScene, newChar, newProp, newDialog, setT: (v) => { t = v; frame(false); updateTime(); }, frame, renderAll, touch };

/* ---- one click: measure the speech of every scene ---- */
async function measureEverything(btn) {
  if (measuring) { measureAbort = true; cancelBrowser(); return; }
  if (!browserTtsAvailable()) return toast('This browser has no speech synthesis');
  stopPlay(); measuring = true; measureAbort = false; const label = btn.textContent;
  try { await measureScenes(project.scenes, m => { btn.textContent = '■ Stop · ' + m.replace('Measuring speech ', ''); }, true); }
  finally { measuring = false; btn.textContent = label; cancelBrowser(); }
  const was = measureAbort; measureAbort = false; touch(false); goScene(si); toast(was ? 'Stopped — lines measured so far were kept' : 'All scenes measured: line lengths, spacing and scene lengths updated');
}
$('#bMeasureAll').onclick = (e) => measureEverything(e.currentTarget);
