import { init } from './vendor/index.browser.js';

const LIMIT = 50 * 1024 * 1024;
let library;
let current;
let fontAssets;

function needsFont(text) {
  return /[^\x20-\x7e\n]/.test(text);
}

async function loadFontAssets(edits) {
  if (!edits.some(edit => needsFont(edit.text))) return null;
  if (!fontAssets) {
    fontAssets = (async () => {
      const names = ['DroidSansFallback.ttf', 'font-coverage.json'];
      const [font, coverage] = await Promise.all(names.map(async name => {
        const response = await fetch(new URL('./vendor/' + name, import.meta.url));
        if (!response.ok) throw new Error('Could not load the multilingual font.');
        return response;
      }));
      return {bytes: new Uint8Array(await font.arrayBuffer()), ranges: await coverage.json()};
    })().catch(error => { fontAssets = null; throw error; });
  }
  const assets = await fontAssets;
  for (const edit of edits) {
    for (const character of edit.text) {
      if (character === '\n') continue;
      const code = character.codePointAt(0);
      if (!assets.ranges.some(([first, last]) => first <= code && code <= last)) {
        throw new Error('The available fonts do not support one or more characters.');
      }
    }
  }
  return assets.bytes;
}

function withFont(api, document, bytes, use) {
  if (!bytes) return use(0);
  const font = memory(api, bytes.length, pointer => {
    api.pdfium.HEAPU8.set(bytes, pointer);
    return api.FPDFText_LoadFont(document, pointer, bytes.length, 2, true);
  });
  if (!font) throw new Error('Could not embed the multilingual font.');
  try { return use(font); }
  finally { api.FPDFFont_Close(font); }
}

async function getLibrary() {
  if (!library) {
    library = (async () => {
      const response = await fetch(new URL('./vendor/pdfium.wasm', import.meta.url));
      if (!response.ok) throw new Error('Could not load the PDF engine.');
      const api = await init({ wasmBinary: await response.arrayBuffer() });
      api.PDFiumExt_Init();
      return api;
    })().catch(error => { library = null; throw error; });
  }
  return library;
}

function memory(api, length, use) {
  const pointer = api.pdfium.wasmExports.malloc(length);
  if (!pointer) throw new Error('The PDF exceeds available memory.');
  try { return use(pointer); }
  finally { api.pdfium.wasmExports.free(pointer); }
}

function withDocument(api, bytes, use) {
  return memory(api, bytes.length, pointer => {
    api.pdfium.HEAPU8.set(bytes, pointer);
    const document = api.FPDF_LoadMemDocument(pointer, bytes.length, '');
    if (!document) throw new Error('Could not open this PDF. Check the file and unlock password protection first.');
    try { return use(document); }
    finally { api.FPDF_CloseDocument(document); }
  });
}

function withPage(api, document, index, use) {
  const page = api.FPDF_LoadPage(document, index);
  if (!page) throw new Error('Could not load this page.');
  try { return use(page); }
  finally { api.FPDF_ClosePage(page); }
}

function readValues(api, count, format, use) {
  const step = format === 'double' ? 8 : 4;
  return memory(api, count * step, pointer => {
    if (!use(pointer)) throw new Error('Could not read the PDF geometry.');
    return Array.from({length: count}, (_, index) => api.pdfium.getValue(pointer + index * step, format));
  });
}

function bounds(api, object) {
  return readValues(api, 4, 'float', p => api.FPDFPageObj_GetBounds(object, p, p + 4, p + 8, p + 12));
}

function inspectPage(api, page) {
  const width = api.FPDF_GetPageWidthF(page);
  const height = api.FPDF_GetPageHeightF(page);
  const spans = [];
  const textPage = api.FPDFText_LoadPage(page);
  if (!textPage) return {width, height, spans};
  try {
    for (let index = 0; index < api.FPDFPage_CountObjects(page); index++) {
      const object = api.FPDFPage_GetObject(page, index);
      if (api.FPDFPageObj_GetType(object) !== 1 || api.FPDFTextObj_GetTextRenderMode(object) === 3) continue;
      const length = api.FPDFTextObj_GetText(object, textPage, 0, 0);
      if (length <= 2 || length > 100000) continue;
      const text = memory(api, length, p => {
        api.FPDFTextObj_GetText(object, textPage, p, length);
        return api.pdfium.UTF16ToString(p, length);
      });
      if (!text.trim()) continue;
      const [left, bottom, right, top] = bounds(api, object);
      const [a, b, c, d, x, y] = readValues(api, 6, 'float', p => api.FPDFPageObj_GetMatrix(object, p));
      const [size] = readValues(api, 1, 'float', p => api.FPDFTextObj_GetFontSize(object, p));
      const rgb = readValues(api, 4, 'i32', p => api.FPDFPageObj_GetFillColor(object, p, p + 4, p + 8, p + 12));
      const device = (px, py) => readValues(api, 2, 'i32', p => api.FPDF_PageToDevice(page, 0, 0, Math.ceil(width * 16), Math.ceil(height * 16), 0, px, py, p, p + 4)).map(n => n / 16);
      const points = [device(left, bottom), device(left, top), device(right, top), device(right, bottom)];
      const bbox = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
      const editable = api.FPDFPage_GetRotation(page) === 0 && Math.abs(b) < .001 && Math.abs(c) < .001 && a > 0 && d > 0 && right > left;
      spans.push({id: String(index), text, bbox, x, y, width: right - left, size: Math.min(144, Math.max(4, size * d)), color: '#' + rgb.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join(''), editable, font: 'PDF text'});
    }
    return {width, height, spans};
  } finally { api.FPDFText_ClosePage(textPage); }
}

function position(api, page, x, y) {
  const width = api.FPDF_GetPageWidthF(page);
  const height = api.FPDF_GetPageHeightF(page);
  return readValues(api, 2, 'double', p => api.FPDF_DeviceToPage(page, 0, 0, Math.ceil(width * 16), Math.ceil(height * 16), 0, Math.round(x * 16), Math.round(y * 16), p, p + 8));
}

function addText(api, document, page, edit, source, font) {
  if (!edit.text) return;
  if (api.FPDFPage_GetRotation(page) !== 0) throw new Error('Text placement on rotated pages is not supported.');
  const lines = edit.text.split('\n');
  const box = source?.bbox ?? edit.bbox;
  const width = source?.width ?? box[2] - box[0];
  const size = lines.length === 1 ? edit.size : Math.min(edit.size, (box[3] - box[1]) / (1.2 * lines.length));
  if (size < 4) throw new Error('There is not enough room for these lines.');
  const [x, y] = source ? [source.x, source.y] : position(api, page, box[0], box[1] + size);
  const rgb = edit.color.slice(1).match(/../g).map(hex => parseInt(hex, 16));
  lines.forEach((line, index) => {
    if (!line) return;
    const object = needsFont(line)
      ? api.FPDFPageObj_CreateTextObj(document, font, size)
      : api.FPDFPageObj_NewTextObj(document, 'Helvetica', size);
    if (!object) throw new Error('Could not create the text object.');
    let inserted = false;
    try {
      const ok = memory(api, (line.length + 1) * 2, p => {
        api.pdfium.stringToUTF16(line, p, (line.length + 1) * 2);
        return api.FPDFText_SetText(object, p);
      });
      if (!ok) throw new Error('Could not write the replacement text.');
      const [left, , right] = bounds(api, object);
      const scale = Math.min(1, width / Math.max(0.01, right - left));
      if (size * scale < 4) throw new Error('Text would shrink below 4 pt. Shorten the text.');
      api.FPDFPageObj_Transform(object, scale, 0, 0, scale, x, y - index * size * 1.2);
      api.FPDFPageObj_SetFillColor(object, ...rgb, 255);
      api.FPDFPage_InsertObject(page, object);
      inserted = true;
    } finally { if (!inserted) api.FPDFPageObj_Destroy(object); }
  });
}

function applyPage(api, document, page, edits, spans, font) {
  // Capture handles before removing objects, since removal shifts page indices.
  const targets = edits.map(edit => {
    if (edit.kind === 'add') return {edit};
    const source = spans.find(span => span.id === edit.id && span.editable);
    if (!source) throw new Error('This text region cannot be edited.');
    return {edit, source, object: api.FPDFPage_GetObject(page, Number(edit.id))};
  });
  for (const {edit, source, object} of targets) {
    if (object) {
      if (!api.FPDFPage_RemoveObject(page, object)) throw new Error('Could not remove the original text.');
      api.FPDFPageObj_Destroy(object);
    }
    addText(api, document, page, edit, source, font);
  }
  if (edits.length && !api.FPDFPage_GenerateContent(page)) throw new Error('Could not save changes to this page.');
}

function render(api, page) {
  const w = api.FPDF_GetPageWidthF(page), h = api.FPDF_GetPageHeightF(page);
  const scale = Math.min(2, 2200 / Math.max(w, h));
  const width = Math.max(1, Math.ceil(w * scale)), height = Math.max(1, Math.ceil(h * scale));
  const bitmap = api.FPDFBitmap_Create(width, height, 0);
  if (!bitmap) throw new Error('Could not allocate the page preview.');
  try {
    api.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    // FPDF_REVERSE_BYTE_ORDER produces RGBA channel order for the canvas.
    api.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x11);
    const offset = api.FPDFBitmap_GetBuffer(bitmap);
    const stride = api.FPDFBitmap_GetStride(bitmap);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      pixels.set(api.pdfium.HEAPU8.subarray(offset + row * stride, offset + row * stride + width * 4), row * width * 4);
    }
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    const canvas = window.document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create a preview.')), 'image/png'));
  } finally { api.FPDFBitmap_Destroy(bitmap); }
}

function save(api, document) {
  const writer = api.PDFiumExt_OpenFileWriter();
  if (!writer) throw new Error('Could not create the export.');
  try {
    if (!api.FPDF_SaveAsCopy(document, writer, 2)) throw new Error('Could not export this PDF.');
    const size = api.PDFiumExt_GetFileWriterSize(writer);
    return memory(api, size, pointer => {
      api.PDFiumExt_GetFileWriterData(writer, pointer, size);
      return api.pdfium.HEAPU8.slice(pointer, pointer + size);
    });
  } finally { api.PDFiumExt_CloseFileWriter(writer); }
}

export async function request(path, body) {
  const api = await getLibrary();
  if (path === '/api/open') {
    if (body.size > LIMIT) throw new Error('This file exceeds 50 MB.');
    const bytes = new Uint8Array(await body.arrayBuffer());
    const pages = withDocument(api, bytes, document => {
      const count = api.FPDF_GetPageCount(document);
      if (count < 1 || count > 500) throw new Error('PDFs must contain 1–500 pages.');
      return Array.from({length: count}, (_, i) => withPage(api, document, i, page => inspectPage(api, page)));
    });
    current = {bytes, pages, id: crypto.randomUUID()};
    return Response.json({pages, id: current.id});
  }
  if (path === '/api/close') return Response.json({ok: true});
  if (!current) throw new Error('Open a PDF first.');
  const edits = body?.edits ?? [];
  const {bytes, pages} = current;
  const fontBytes = await loadFontAssets(edits);
  if (path === '/api/export') {
    const output = withDocument(api, bytes, document => withFont(api, document, fontBytes, font => {
      for (const index of new Set(edits.map(edit => edit.page))) {
        withPage(api, document, index, page => applyPage(api, document, page, edits.filter(edit => edit.page === index), pages[index].spans, font));
      }
      return save(api, document);
    }));
    return new Response(output, {headers: {'Content-Type': 'application/pdf'}});
  }
  const index = body?.page ?? Number(new URL(path, 'https://local.invalid').searchParams.get('page'));
  const blob = await withDocument(api, bytes, document => withFont(api, document, fontBytes, font => withPage(api, document, index, page => {
    applyPage(api, document, page, edits.filter(edit => edit.page === index), pages[index].spans, font);
    return render(api, page);
  })));
  return new Response(blob);
}
