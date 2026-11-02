import unittest
from pathlib import Path
import pymupdf as pdf
import engine


def sample():
    doc = pdf.open()
    page = doc.new_page(width=595, height=842)
    page.draw_rect(page.rect, color=None, fill=(.96, .97, .94))
    page.insert_text((55, 75), 'PDF Studio / Local editing', fontsize=22)
    page.insert_text((55, 135), 'Replace this sentence.', fontsize=14)
    page.insert_text((55, 156), 'Keep this neighboring line.', fontsize=14)
    page.insert_text((55, 210), 'English and Chinese supported.', fontsize=13)
    page.insert_text((55, 260), 'Click text to edit. Export a new PDF.', fontsize=12)
    p2 = doc.new_page(width=595, height=842)
    p2.insert_text((55, 80), 'Second page remains intact.', fontsize=18)
    data = doc.tobytes()
    doc.close()
    return data


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.original = sample()
        with engine.open_pdf(self.original) as doc:
            self.original = doc.tobytes()
            self.target = next(s for s in engine.spans(doc[0]) if s['text'].startswith('Replace'))

    def edit(self, text='Updated text', **kwargs):
        return dict(kind='replace', id=self.target['id'], page=0,
                    size=14, color='#203e37', text=text, **kwargs)

    def test_replace_removes_original_and_keeps_neighbor_and_graphics(self):
        with engine.apply_edits(self.original, [self.edit()]) as doc:
            data = doc.tobytes(garbage=4, deflate=True)
        with pdf.open(stream=data, filetype='pdf') as doc:
            text = doc[0].get_text()
            self.assertIn('Updated text', text)
            self.assertNotIn('Replace this sentence', text)
            self.assertIn('Keep this neighboring line.', text)
            self.assertEqual(len(doc[0].get_drawings()), 1)
            self.assertIn('Second page remains intact.', doc[1].get_text())

    def test_chinese_and_deletion(self):
        with engine.apply_edits(self.original, [self.edit('你好，本地文字编辑')]) as doc:
            self.assertIn('你好，本地文字编辑', doc[0].get_text())
        with engine.apply_edits(self.original, [self.edit('')]) as doc:
            self.assertNotIn('Replace this sentence', doc[0].get_text())
            self.assertIn('Keep this neighboring line.', doc[0].get_text())

    def test_add_and_multiline(self):
        e = dict(kind='add', id='new', page=0, bbox=[55, 310, 350, 380], text='新增内容\nSecond line', size=14, color='#203e37')
        with engine.apply_edits(self.original, [e]) as doc:
            self.assertIn('新增内容', doc[0].get_text())
            self.assertIn('Second line', doc[0].get_text())

    def test_rotation_and_invalid_input(self):
        with pdf.open(stream=self.original, filetype='pdf') as doc:
            doc[0].set_rotation(90)
            data = doc.tobytes()
        with engine.open_pdf(data) as doc:
            self.assertEqual(doc[0].rotation, 0)
            self.assertIn('Replace this sentence', doc[0].get_text())
        with self.assertRaises(ValueError):
            engine.apply_edits(self.original, [self.edit(), self.edit()])
        with self.assertRaises(Exception):
            engine.open_pdf(b'not a pdf')
        with self.assertRaises(ValueError):
            engine.apply_edits(self.original, [dict(self.edit(), size=float('nan'))])

    def test_preview_matches_export(self):
        edits = [self.edit('已完成编辑')]
        with engine.apply_edits(self.original, edits) as doc:
            preview = engine.png(doc[0])
            data = doc.tobytes(garbage=4, deflate=True)
        with pdf.open(stream=data, filetype='pdf') as doc:
            self.assertEqual(preview, engine.png(doc[0]))

    def test_existing_redaction_is_never_silently_applied(self):
        with pdf.open(stream=self.original, filetype='pdf') as doc:
            doc[0].add_redact_annot(pdf.Rect(50, 240, 400, 270))
            data = doc.tobytes()
        with self.assertRaises(ValueError):
            engine.apply_edits(data, [self.edit()])
        addition = dict(kind='add', id='new', page=0, bbox=[55, 350, 300, 400], text='New', size=12, color='#000000')
        with engine.apply_edits(data, [addition]) as doc:
            self.assertIn('Click text to edit.', doc[0].get_text())
            self.assertEqual(len(list(doc[0].annots())), 1)


if __name__ == '__main__':
    unittest.main()
