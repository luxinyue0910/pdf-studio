"""PDF operations. All edits are replayed on a fresh original, never on a preview."""
import html
import math
import pymupdf as pdf

MAX_FILE = 50 * 1024 * 1024


def open_pdf(data):
    if len(data) > MAX_FILE:
        raise ValueError('File exceeds the 50 MB limit')
    doc = pdf.open(stream=data, filetype='pdf')
    if doc.needs_pass:
        doc.close()
        raise ValueError('Unlock the PDF with its password first, then open the unlocked copy')
    if not 0 < len(doc) <= 500:
        doc.close()
        raise ValueError('PDFs must contain 1–500 pages')
    # Bake page rotation into content so screen and PDF coordinates agree.
    for page in doc:
        page.remove_rotation()
    return doc


def spans(page):
    result = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                if not span['text'].strip():
                    continue
                result.append({
                    'id': str(len(result)), 'text': span['text'],
                    'bbox': list(span['bbox']), 'origin': list(span['origin']),
                    'size': span['size'], 'font': span['font'],
                    'color': '#%06x' % span['color'], 'flags': span['flags'],
                    'editable': abs(line['dir'][0] - 1) < .001 and abs(line['dir'][1]) < .001,
                })
    return result


def metadata(doc):
    return {'pages': [{'width': p.rect.width, 'height': p.rect.height,
                       'spans': spans(p)} for p in doc]}


def number(value, low, high):
    v = float(value)
    if not math.isfinite(v) or not low <= v <= high:
        raise ValueError('Value is outside the allowed range')
    return v


def apply_edits(original, edits):
    if not isinstance(edits, list) or len(edits) > 2000:
        raise ValueError('Invalid edit list (maximum 2,000 edits)')
    doc = pdf.open(stream=original, filetype='pdf')
    try:
        grouped, seen = {}, set()
        for e in edits:
            n = e.get('page')
            if type(n) is not int or not 0 <= n < len(doc):
                raise ValueError('Invalid page number')
            grouped.setdefault(n, []).append(e)
        for n, items in grouped.items():
            page = doc[n]
            if any(e.get('kind') == 'replace' for e in items) and any(
                a.type[0] == pdf.PDF_ANNOT_REDACT for a in (page.annots() or [])
            ):
                raise ValueError('This page has existing redaction annotations. Resolve them in the original software before replacing text.')
            originals = {s['id']: s for s in spans(page)}
            prepared = []
            for e in items:
                text = e.get('text', '')
                if not isinstance(text, str) or len(text) > 5000:
                    raise ValueError('Each edit can contain up to 5,000 characters')
                color = e.get('color', '#182b29')
                if not isinstance(color, str) or len(color) != 7 or color[0] != '#':
                    raise ValueError('Invalid color')
                rgb = tuple(int(color[i:i+2], 16) / 255 for i in (1, 3, 5))
                size = number(e.get('size', 12), 4, 144)
                source = None
                if e.get('kind') == 'replace':
                    key = (n, e.get('id'))
                    if key in seen or e.get('id') not in originals:
                        raise ValueError('Text target is duplicated or no longer valid')
                    seen.add(key)
                    source = originals[e['id']]
                    if not source['editable']:
                        raise ValueError('Rotated or angled text is not supported. Select horizontal text.')
                    rect = pdf.Rect(source['bbox'])
                    origin = pdf.Point(source['origin'])
                    # Shrink to glyph mid-height to avoid touching adjacent lines.
                    redact = pdf.Rect(rect.x0, origin.y - source['size'] * .65,
                                      rect.x1, origin.y - source['size'] * .1)
                    page.add_redact_annot(redact, fill=False, cross_out=False)
                elif e.get('kind') == 'add':
                    box = e.get('bbox', [])
                    if not isinstance(box, list) or len(box) != 4:
                        raise ValueError('Invalid text region')
                    rect = pdf.Rect([number(x, 0, max(page.rect.width, page.rect.height)) for x in box])
                    if rect.is_empty or not page.rect.contains(rect) or rect.width < 5:
                        raise ValueError('Text region must be within the page')
                    origin = pdf.Point(rect.x0, rect.y0 + size)
                else:
                    raise ValueError('Invalid edit type')
                prepared.append((text, size, rgb, rect, origin, source))
            # Keep original image/background/vector art. Remove actual text objects.
            if any(e.get('kind') == 'replace' for e in items):
                page.apply_redactions(images=0, graphics=0)
            for index, (text, size, rgb, rect, origin, source) in enumerate(prepared):
                if not text:
                    continue
                if '\n' in text:
                    css = f'* {{font-family:sans-serif;font-size:{size}pt;color:rgb({rgb[0]*255},{rgb[1]*255},{rgb[2]*255});margin:0;padding:0;line-height:1.1}}'
                    spare, scale = page.insert_htmlbox(rect, '<div>' + html.escape(text).replace('\n', '<br>') + '</div>', css=css, scale_low=.5)
                    if spare < 0:
                        raise ValueError('Text does not fit. Shorten it or reduce the font size.')
                    continue
                font = None
                # Reuse embedded fonts only when all replacement glyphs exist.
                if source:
                    for info in page.get_fonts(full=True):
                        if info[3].split('+')[-1] == source['font'].split('+')[-1]:
                            try:
                                buf = doc.extract_font(info[0])[3]
                                candidate = pdf.Font(fontbuffer=buf) if buf else None
                                if candidate and all(candidate.has_glyph(ord(c)) for c in text):
                                    font = candidate
                            except Exception:
                                pass
                            break
                if font is None:
                    flags = source['flags'] if source else 0
                    family = 'ti' if flags & 4 else 'he'
                    style = 'bi' if flags & 16 and flags & 2 else 'bo' if flags & 16 else 'it' if flags & 2 else 'ro'
                    base = 'helv' if family == 'he' and style == 'ro' else family + style
                    font = pdf.Font(base)
                    if not all(font.has_glyph(ord(c)) for c in text):
                        font = pdf.Font('cjk')
                    if not all(font.has_glyph(ord(c)) for c in text):
                        raise ValueError('Text contains unsupported characters. Remove emoji or special symbols.')
                width = font.text_length(text, fontsize=size)
                actual = min(size, size * rect.width / width) if width else size
                if actual < 4:
                    raise ValueError('Text would shrink below 4 pt. Shorten the text.')
                if origin.y + actual * max(0, -font.descender) > page.rect.height:
                    raise ValueError('Text extends below the page. Move the insertion point up.')
                name = f'localedit{index}'
                page.insert_font(fontname=name, fontbuffer=font.buffer)
                page.insert_text(origin, text, fontname=name, fontsize=actual, color=rgb)
        return doc
    except Exception:
        doc.close()
        raise


def png(page, scale=1.5):
    scale = min(scale, 2400 / max(page.rect.width, page.rect.height))
    return page.get_pixmap(matrix=pdf.Matrix(scale, scale), alpha=False).tobytes('png')
