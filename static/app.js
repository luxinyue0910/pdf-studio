'use strict';
const $ = id => document.getElementById(id);
const token = '__TOKEN__';
let doc = null, filename = '', page = 0, edits = [], history = [], future = [];
let selected = null, mode = 'select', previewing = false, dirty = false, imageURL = null;
let loadVersion = 0, busy = false, toastTimer;
const clone = x => JSON.parse(JSON.stringify(x));

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500);
}
async function request(path, body, raw = false) {
  const options = {headers: {'X-Local-Token': token}};
  if (body !== undefined) {
    options.method = 'POST'; options.body = raw ? body : JSON.stringify(body);
    options.headers['Content-Type'] = raw ? 'application/pdf' : 'application/json';
  }
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = 'Cannot connect to the local server';
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response;
}
async function task(fn) {
  if (busy) return;
  busy = true; $('busy').hidden = false;
  try { await fn(); } catch (e) { toast(e.message); }
  finally { busy = false; $('busy').hidden = true; }
}
function pendingGuard() {
  if (!dirty) return true;
  return window.confirm('Your current input has not been applied. Discard it?');
}
function resetEditor() {
  selected = null; dirty = false; $('pending').hidden = true; $('editor').hidden = true;
  $('editTitle').textContent = 'Select some text';
  $('editHint').textContent = 'Click a text region, edit it, then choose Apply changes.';
}
function modifiedGuard() {
  if (!dirty && !edits.length) return true;
  return window.confirm('This document has edits that may not be exported. Discard them and open another file?');
}
async function openFile(file) {
  if (!file || !modifiedGuard()) return;
  if (file.size > 50 * 1024 * 1024) return toast('This file exceeds 50 MB. Choose a smaller PDF.');
  await task(async () => {
    const next = await (await request('/api/open', file, true)).json();
    if (doc) request('/api/close', {id: doc.id}).catch(() => {});
    doc = next; filename = file.name; page = 0; edits = []; history = []; future = [];
    selected = null; dirty = false; previewing = false; mode = 'select';
    $('filename').textContent = filename;
    $('filemeta').textContent = `${doc.pages.length} ${doc.pages.length === 1 ? 'page' : 'pages'} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    $('empty').hidden = true; $('empty').style.display = 'none'; $('paper').hidden = false;
    $('editor').hidden = true; $('pending').hidden = true;
    $('editTitle').textContent = 'Select some text'; $('editHint').textContent = 'Click a text region, edit it, then choose Apply changes.';
    await renderPage(); sync();
    if (!doc.pages.some(p => p.spans.length)) toast('No extractable text found. This may be a scanned PDF. Use Add text to insert new text.');
  });
}
async function renderPage() {
  if (!doc) return;
  const version = ++loadVersion;
  const p = doc.pages[page];
  $('paper').style.width = `${p.width * Number($('zoom').value)}px`;
  $('paper').style.height = `${p.height * Number($('zoom').value)}px`;
  $('status').textContent = 'Rendering page…';
  // Render the actual edited PDF after each application, not a browser approximation.
  const response = edits.some(e => e.page === page)
    ? await request('/api/preview', {id: doc.id, edits, page})
    : await request(`/api/page?id=${encodeURIComponent(doc.id)}&page=${page}`);
  const blob = await response.blob();
  if (version !== loadVersion) return;
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    const image = new Image(); image.onload = resolve; image.onerror = () => reject(new Error('Could not load the page image')); image.src = url;
  });
  const old = imageURL; imageURL = url; $('pageimg').src = url;
  if (old) URL.revokeObjectURL(old);
  renderLayers(); sync();
  $('status').textContent = previewing ? 'Export preview · Choose Back to editing to continue' : `Page ${page + 1} · Click text to edit`;
}
function bounds(node, bbox) {
  const p = doc.pages[page];
  Object.assign(node.style, {left: `${bbox[0] / p.width * 100}%`, top: `${bbox[1] / p.height * 100}%`, width: `${(bbox[2]-bbox[0]) / p.width * 100}%`, height: `${(bbox[3]-bbox[1]) / p.height * 100}%`});
}
function key(e) { return `${e.page}:${e.kind}:${e.id}`; }
function renderLayers() {
  $('layers').replaceChildren();
  if (!doc) return;
  const current = doc.pages[page];
  const regions = current.spans.map(s => ({...s, kind: 'replace', page})).concat(edits.filter(e => e.page === page && e.kind === 'add'));
  for (const region of regions) {
    const edit = edits.find(e => key(e) === key(region));
    const node = document.createElement('button'); node.type = 'button';
    node.className = 'text-hit' + (edit ? ' changed' : '') + (region.kind === 'add' ? ' added' : '') + (selected && key(selected) === key(region) ? ' selected' : '');
    node.disabled = region.editable === false;
    node.title = region.editable === false ? 'Angled text is not supported yet' : (edit?.text ?? region.text) || 'Deleted text';
    node.setAttribute('aria-label', 'Edit: ' + node.title);
    bounds(node, region.bbox);
    node.onclick = event => { event.stopPropagation(); if (mode === 'select') choose(region); };
    $('layers').append(node);
  }
}
function choose(region) {
  if (!pendingGuard()) return;
  selected = region; dirty = false; $('pending').hidden = true;
  const value = edits.find(e => key(e) === key(region)) || region;
  $('text').value = value.text; $('size').value = Number(value.size.toFixed(1)); $('color').value = value.color;
  $('editor').hidden = false;
  $('editTitle').textContent = region.kind === 'add' ? 'Edit added text' : 'Edit text';
  $('editHint').textContent = region.kind === 'add' ? 'Your text will be inserted in the selected area.' : `Original font: ${region.font} · ${region.size.toFixed(1)} pt`;
  $('delete').textContent = region.kind === 'add' ? 'Remove added text' : 'Delete text';
  renderLayers(); $('text').focus();
}
function checkpoint() { history.push(clone(edits)); if (history.length > 80) history.shift(); future = []; }
function sync() {
  $('prev').disabled = !doc || page === 0; $('next').disabled = !doc || page === doc.pages.length - 1;
  $('pageno').textContent = doc ? `${page + 1} / ${doc.pages.length}` : '— / —';
  $('undo').disabled = !history.length; $('redo').disabled = !future.length;
  $('export').disabled = !doc; $('preview').disabled = !doc;
  $('changes').textContent = `${edits.length} ${edits.length === 1 ? 'edit' : 'edits'}`;
  $('select').classList.toggle('active', mode === 'select'); $('add').classList.toggle('active', mode === 'add');
  $('paper').classList.toggle('adding', mode === 'add'); $('paper').classList.toggle('previewing', previewing);
  $('preview').classList.toggle('active', previewing); $('preview').textContent = previewing ? '↖ Back to editing' : '◉ Preview export';
}
async function commit(remove = false) {
  if (!selected) return;
  if (!$('size').checkValidity()) return $('size').reportValidity();
  await task(async () => {
    const next = edits.filter(e => key(e) !== key(selected));
    if (!(remove && selected.kind === 'add')) {
      const e = {kind: selected.kind, id: selected.id, page, text: remove ? '' : $('text').value, size: Number($('size').value), color: $('color').value};
      if (selected.kind === 'add') e.bbox = selected.bbox;
      // Unchanged values restore the original span without introducing a replacement.
      if (selected.kind === 'add' || e.text !== selected.text || Math.abs(e.size - selected.size) > .1 || e.color !== selected.color) next.push(e);
    }
    // Validate before changing state, so failed fitting never loses the last good edit.
    await request('/api/preview', {id: doc.id, edits: next, page});
    checkpoint(); edits = next; dirty = false; $('pending').hidden = true;
    if (remove && selected.kind === 'add') { selected = null; $('editor').hidden = true; }
    await renderPage(); toast(remove ? 'Deleted. Use Undo to restore it.' : 'Changes applied. The page shows the actual PDF result.');
  });
}
$('editor').onsubmit = event => { event.preventDefault(); commit(); };
$('delete').onclick = () => commit(true);
for (const id of ['text', 'size', 'color']) $(id).oninput = () => { dirty = true; $('pending').hidden = false; };
for (const id of ['open', 'choose']) $(id).onclick = () => $('file').click();
$('file').onchange = () => { openFile($('file').files[0]); $('file').value = ''; };
for (const id of ['select', 'add']) $(id).onclick = () => {
  if (!doc) return toast('Open a PDF first');
  if (!pendingGuard()) return;
  resetEditor(); mode = id; previewing = false; renderLayers(); sync();
  if (id === 'add') toast('Click a blank area to place text, then enter it in the properties panel and apply.');
};
$('layers').onclick = event => {
  if (mode !== 'add' || previewing || !doc || !pendingGuard()) return;
  const r = $('layers').getBoundingClientRect(), p = doc.pages[page];
  const x = (event.clientX - r.left) / r.width * p.width, y = (event.clientY - r.top) / r.height * p.height;
  if (p.width - x < 15 || p.height - y < 18) return toast('Place text farther away from the page edge.');
  dirty = false;
  const region = {kind:'add', id: crypto.randomUUID(), page, text:'', size:12, color:'#203e37', bbox:[x,y,Math.min(x+240,p.width-5),Math.min(y+55,p.height-5)]};
  mode = 'select'; sync(); choose(region);
};
for (const [id, delta] of [['prev', -1], ['next', 1]]) $(id).onclick = () => {
  if (!pendingGuard()) return;
  resetEditor(); page += delta;
  task(renderPage);
};
$('zoom').onchange = () => task(renderPage);
$('preview').onclick = () => {
  if (!pendingGuard()) return;
  if (dirty) resetEditor();
  previewing = !previewing; sync();
  $('status').textContent = previewing ? 'Export preview · Choose Back to editing to continue' : 'Click text to start editing';
};
async function travel(redo) {
  if (!pendingGuard()) return;
  const from = redo ? future : history, to = redo ? history : future;
  if (!from.length) return;
  await task(async () => {
    to.push(clone(edits)); edits = from.pop(); resetEditor(); await renderPage();
  });
}
$('undo').onclick = () => travel(false); $('redo').onclick = () => travel(true);
$('export').onclick = () => {
  if (dirty) return toast('Choose Apply changes in the properties panel before exporting.');
  task(async () => {
    const response = await request('/api/export', {id: doc.id, edits});
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename.replace(/\.pdf$/i, '') + '-edited.pdf'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('PDF generated. Your browser will save a new file.');
  });
};
document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey); }
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => { event.preventDefault(); openFile(event.dataTransfer.files[0]); });
window.addEventListener('beforeunload', event => { if (edits.length || dirty) { event.preventDefault(); event.returnValue = ''; } });
