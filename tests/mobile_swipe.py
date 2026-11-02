"""Checks that swipes work on a touch-screen phone, in both the page and scroll layouts.

Runs the app in Chromium emulating a phone (touch screen, mobile viewport) and swipes
with real touch input (DevTools `Input.dispatchTouchEvent`). The touches go through the
browser's own gesture handling, so they scroll the page and reach the reader frame just
as a finger would, unlike `TouchEvent`s made up in JavaScript.

iOS only sends touches to listeners in a frame if the parent page also has touch
listeners over it. Desktop browsers don't model this, so the test only checks that the
listener on the <iframe> is there.

Needs Python 3 and Playwright:

    pip install playwright && python3 -m playwright install --with-deps chromium
    python3 tests/mobile_swipe.py

Exits non-zero if a check fails.
"""

import functools
import http.server
import io
import sys
import threading
import zipfile
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CHAPTERS = 3
PHONE = {'viewport': {'width': 390, 'height': 844}, 'device_scale_factor': 3, 'is_mobile': True, 'has_touch': True}


def make_epub():
    """A small EPUB 3 with CHAPTERS chapters, each several screens long."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', (
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'))
        items, refs, links = [], [], []
        for i in range(1, CHAPTERS + 1):
            text = ''.join(f'<p>Chapter {i}, paragraph {j}. ' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' * 6 + '</p>'
                           for j in range(30))
            z.writestr(f'OEBPS/c{i}.xhtml', f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C{i}</title></head>'
                                            f'<body><h1>Chapter {i}</h1>{text}</body></html>')
            items.append(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>')
            refs.append(f'<itemref idref="c{i}"/>')
            links.append(f'<li><a href="c{i}.xhtml">Chapter {i}</a></li>')
        z.writestr('OEBPS/nav.xhtml', (
            '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
            f'<head><title>Contents</title></head><body><nav epub:type="toc"><ol>{"".join(links)}</ol></nav></body></html>'))
        z.writestr('OEBPS/content.opf', (
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">swipe-test</dc:identifier>'
            '<dc:title>Swipe Test</dc:title><dc:language>en</dc:language></metadata>'
            '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            f'{"".join(items)}</manifest><spine>{"".join(refs)}</spine></package>'))
    return buf.getvalue()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Phone:
    """The app open on an emulated phone, with the test book loaded."""

    def __init__(self, browser, url, epub, columns):
        # The app's CSP forbids eval, which Playwright's wait_for_function needs.
        self.context = browser.new_context(**PHONE, bypass_csp=True)
        self.page = self.context.new_page()
        self.page.add_init_script(
            f"localStorage.setItem('webreader:prefs', JSON.stringify({{font: 'serif', size: null, columns: {columns}}}))")
        self.page.goto(url)
        self.page.set_input_files('#file-input', files=[{'name': 'swipe.epub', 'mimeType': 'application/epub+zip', 'buffer': epub}])
        self.page.wait_for_function(f"document.getElementById('position').textContent === '1 / {CHAPTERS}'")
        self.wait_for_chapter(1)
        self.cdp = self.context.new_cdp_session(self.page)
        box = self.page.locator('#reader').bounding_box()
        self.cx = box['x'] + box['width'] / 2
        self.cy = box['y'] + box['height'] / 2

    def close(self):
        self.context.close()

    def state(self):
        return self.page.evaluate('''() => {
          const doc = document.getElementById('reader').contentDocument;
          return {
            chapter: Number(document.getElementById('position').textContent.split(' / ')[0]),
            folio: doc.getElementById('webreader-folio').textContent,
            scrollTop: doc.scrollingElement.scrollTop,
          };
        }''')

    def wait_for_chapter(self, chapter):
        """Waits up to 5 s for a chapter to be shown; the checks that follow report it if it isn't."""
        try:
            self.page.wait_for_function(
                f"document.getElementById('position').textContent === '{chapter} / {CHAPTERS}'"
                " && document.getElementById('reader').contentDocument.getElementById('webreader-content').textContent"
                f".includes('Chapter {chapter}, paragraph 0.')", timeout=5000)
        except PlaywrightTimeoutError:
            pass
        self.settle()

    def settle(self):
        self.page.wait_for_timeout(400)

    def swipe(self, dx, dy, steps=12):
        """Drags one finger across the middle of the reader by (dx, dy) CSS px, then lifts it."""
        x0, y0 = self.cx - dx / 2, self.cy - dy / 2
        self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
        for i in range(1, steps + 1):
            point = {'x': x0 + dx * i / steps, 'y': y0 + dy * i / steps}
            self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [point]})
        self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        self.settle()

    def frame_has_touch_listener(self):
        """True if the <iframe> element in the app page has a touchstart listener (needed by iOS)."""
        frame = self.cdp.send('Runtime.evaluate', {'expression': "document.getElementById('reader')"})
        listeners = self.cdp.send('DOMDebugger.getEventListeners', {'objectId': frame['result']['objectId']})
        return any(listener['type'] == 'touchstart' for listener in listeners['listeners'])


failures = []


def check(name, condition, detail=''):
    print(f"{'ok  ' if condition else 'FAIL'} {name}{f'  ({detail})' if detail and not condition else ''}")
    if not condition:
        failures.append(name)


def test_pages(phone):
    """1-column pages: horizontal swipes turn pages, and past either end change chapter."""
    s = phone.state()
    check('pages: opens on page 1', s['folio'].startswith('Page 1 of'), s)
    pages = int(s['folio'].split(' of ')[1])

    phone.swipe(-200, 10)
    s = phone.state()
    check('pages: swipe left turns to the next page', s['folio'] == f'Page 2 of {pages}', s)

    phone.swipe(200, -10)
    s = phone.state()
    check('pages: swipe right turns to the previous page', s['folio'] == f'Page 1 of {pages}', s)

    phone.swipe(-30, 0)
    check('pages: a short swipe does nothing', phone.state()['folio'] == f'Page 1 of {pages}')

    phone.swipe(-20, -250)
    check('pages: a vertical swipe does nothing', phone.state()['folio'] == f'Page 1 of {pages}')

    phone.swipe(200, 0)
    check('pages: swipe right on the first page of the book does nothing', phone.state()['chapter'] == 1)

    for _ in range(pages - 1):
        phone.swipe(-200, 0)
    s = phone.state()
    check('pages: swiping reaches the last page', s['folio'] == f'Page {pages} of {pages}', s)
    phone.swipe(-200, 0)
    phone.wait_for_chapter(2)
    s = phone.state()
    check('pages: swipe left on the last page opens the next chapter at page 1',
          s['chapter'] == 2 and s['folio'].startswith('Page 1 of'), s)

    phone.swipe(200, 0)
    phone.wait_for_chapter(1)
    s = phone.state()
    check('pages: swipe right on the first page opens the previous chapter at its last page',
          s['chapter'] == 1 and s['folio'] == f'Page {pages} of {pages}', s)


def test_scroll(phone):
    """Scroll layout: vertical swipes scroll; horizontal swipes change chapter."""
    s = phone.state()
    check('scroll: opens at the top of chapter 1', s['chapter'] == 1 and s['scrollTop'] == 0 and s['folio'] == '', s)

    phone.swipe(0, -400)
    s = phone.state()
    check('scroll: swipe up scrolls the chapter', s['scrollTop'] > 100, s)
    check('scroll: swipe up stays in the chapter', s['chapter'] == 1, s)

    phone.swipe(-30, 0)
    check('scroll: a short swipe does nothing', phone.state()['chapter'] == 1)

    phone.swipe(-200, 15)
    phone.wait_for_chapter(2)
    s = phone.state()
    check('scroll: swipe left opens the next chapter at the top', s['chapter'] == 2 and s['scrollTop'] == 0, s)

    phone.swipe(-200, -15)
    phone.wait_for_chapter(3)
    check('scroll: swipe left again opens the chapter after', phone.state()['chapter'] == 3)

    phone.swipe(-200, 0)
    check('scroll: swipe left in the last chapter does nothing', phone.state()['chapter'] == 3)

    phone.swipe(200, 0)
    phone.wait_for_chapter(2)
    s = phone.state()
    check('scroll: swipe right opens the previous chapter at the top', s['chapter'] == 2 and s['scrollTop'] == 0, s)


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_address[1]}/index.html'
    epub = make_epub()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            for columns, test in ((1, test_pages), (0, test_scroll)):
                phone = Phone(browser, url, epub, columns)
                try:
                    if columns == 1:
                        check('iOS: the <iframe> has a touch listener in the app page', phone.frame_has_touch_listener())
                    test(phone)
                finally:
                    phone.close()
        finally:
            browser.close()
            server.shutdown()
    print(f'\n{len(failures)} failed' if failures else '\nall passed')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
