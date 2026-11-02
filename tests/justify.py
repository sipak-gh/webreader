"""Checks justified text: Justif sets the paragraphs, under the reader frame's real CSP.

Runs the app in Chromium (a desktop window with 2-column pages, and a phone in the scroll
layout) without bypassing the Content-Security-Policy, so it fails if the frame's policy
blocks js/typeset.js or the Justif modules it imports. It also checks that:
 - scripts without the nonce still can't run in the frame;
 - the page count stays right when flipping through pages and after a resize (Justif
   re-sets the text itself and tells the reader);
 - the Justified/Ragged button turns Justif off and on.

Needs Python 3 and Playwright (see tests/mobile_swipe.py):

    python3 tests/justify.py

Exits non-zero if a check fails.
"""

import functools
import http.server
import sys
import threading

from playwright.sync_api import sync_playwright

sys.dont_write_bytecode = True  # no tests/__pycache__ from importing mobile_swipe
from mobile_swipe import CHAPTERS, PHONE, ROOT, QuietHandler, make_epub

DESKTOP = {'viewport': {'width': 1280, 'height': 800}}

failures = []

# Leftmost and rightmost text on screen (in the frame's viewport), and the frame's width.
TEXT_EDGES = """(() => {
  const range = doc.createRange();
  const screen = doc.scrollingElement.clientWidth;
  let min = Infinity, max = -Infinity;
  for (const p of doc.querySelectorAll('#webreader-content p')) {
    range.selectNodeContents(p);
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.right > 0 && r.left < screen) { min = Math.min(min, r.left); max = Math.max(max, r.right); }
    }
  }
  return { textLeft: min, textRight: max, screen, scrollWidth: doc.scrollingElement.scrollWidth };
})()"""


def check(name, condition, detail=''):
    print(f"{'ok  ' if condition else 'FAIL'} {name}{f'  ({detail})' if detail and not condition else ''}")
    if not condition:
        failures.append(name)


class App:
    """The app open with the test book, CSP enforced. Waits by polling `evaluate`, which
    (unlike `wait_for_function`) works under the app's no-eval policy."""

    def __init__(self, browser, url, epub, device, prefs):
        self.context = browser.new_context(**device)
        self.page = self.context.new_page()
        self.messages = []
        self.page.on('console', lambda m: self.messages.append(m.text) if m.type in ('error', 'warning') else None)
        self.page.on('pageerror', lambda e: self.messages.append(str(e)))
        self.requests = []
        self.page.on('request', lambda r: self.requests.append(r.url))
        self.page.add_init_script(f"localStorage.setItem('webreader:prefs', '{prefs}')")
        self.page.goto(url)
        self.page.set_input_files('#file-input', files=[{'name': 't.epub', 'mimeType': 'application/epub+zip', 'buffer': epub}])
        self.wait_until(f"document.getElementById('position').textContent === '1 / {CHAPTERS}'")
        self.wait_for_justif(True)

    def close(self):
        self.context.close()

    def frame(self, expression):
        """Evaluates an expression with `doc` and `win` bound to the reader frame."""
        return self.page.evaluate(
            f"() => {{ const win = document.getElementById('reader').contentWindow; const doc = win.document; return {expression}; }}")

    def wait_until(self, expression, timeout_ms=10000):
        for _ in range(timeout_ms // 100):
            if self.page.evaluate(f'() => Boolean({expression})'):
                return True
            self.page.wait_for_timeout(100)
        return False

    def managed(self):
        return self.frame("doc.querySelectorAll('[data-justif]').length")

    def wait_for_justif(self, on):
        """Waits until Justif has set (or released) the paragraphs, and the layout has settled."""
        for _ in range(100):
            if (self.managed() > 0) == on:
                break
            self.page.wait_for_timeout(100)
        self.page.wait_for_timeout(500)

    def folio(self):
        return self.frame("doc.getElementById('webreader-folio').textContent")

    def page_count(self):
        folio = self.folio()
        return int(folio.split(' of ')[1]) if ' of ' in folio else 0


def test_desktop(app):
    check('desktop: Justif sets the paragraphs', app.managed() >= 25, app.managed())
    check('desktop: English hyphenation patterns load', any(u.endswith('/vendor/justif/hyphenate/en-us.js') for u in app.requests))
    problems = [m for m in app.messages if 'Content Security Policy' in m or 'Justif' in m]
    check('desktop: no CSP violations or Justif warnings', not problems, problems)

    app.frame("""(() => {
      const script = doc.createElement('script');
      script.textContent = 'window.bookScriptRan = true';
      doc.body.append(script);
      const external = doc.createElement('script');
      external.src = 'js/typeset.js?again';
      external.type = 'module';
      doc.body.append(external);
      const img = doc.createElement('img');
      img.setAttribute('onerror', 'window.bookScriptRan = true');
      img.src = 'about:invalid';
      doc.body.append(img);
    })()""")
    app.page.wait_for_timeout(500)
    check('desktop: scripts without the nonce are blocked in the frame', app.frame('win.bookScriptRan') is None)
    check('desktop: a same-origin script without the nonce is blocked too',
          any('typeset.js?again' in m and 'Content Security Policy' in m for m in app.messages))

    # Justif hangs punctuation into the margins; the page's clip must leave room for it.
    edges = app.frame("""(() => {
      const page = doc.getElementById('webreader-page').getBoundingClientRect();
      const content = doc.getElementById('webreader-content').getBoundingClientRect();
      const left = content.left, right = content.left + content.width;
      const range = doc.createRange();
      let min = Infinity, max = -Infinity;
      for (const p of doc.querySelectorAll('#webreader-content p')) {
        range.selectNodeContents(p);
        for (const r of range.getClientRects()) {
          if (r.width > 0 && r.right > left - 30 && r.left < right + 30) { min = Math.min(min, r.left); max = Math.max(max, r.right); }
        }
      }
      return { clipLeft: page.left, clipRight: page.right, textLeft: min, textRight: max };
    })()""")
    check('desktop: hanging punctuation is not clipped at the page edges',
          edges['clipLeft'] <= edges['textLeft'] and edges['textRight'] <= edges['clipRight'], edges)

    pages = app.page_count()
    flipped = []
    for _ in range(pages - 1):
        app.page.keyboard.press('ArrowRight')
        app.page.wait_for_timeout(60)
        flipped.append(app.page_count())
    app.page.wait_for_timeout(300)
    check('desktop: the page count stays the same while turning pages', set(flipped) == {pages}, (pages, set(flipped)))
    check('desktop: turning pages reaches the last page', app.folio() == f'Page {pages} of {pages}', app.folio())

    app.page.set_viewport_size({'width': 1000, 'height': 700})
    app.page.wait_for_timeout(1500)
    resized = app.page_count()
    # Render the chapter afresh at the new size: the count after the resize must match.
    app.page.click('#font-button')
    app.wait_for_justif(True)
    app.page.click('#font-button')
    app.wait_for_justif(True)
    check('desktop: after a resize the page count matches a fresh layout', resized == app.page_count(), (resized, app.page_count()))

    # Narrowed to phone width, the margins are too thin to hang punctuation in. With the
    # text size and layout chosen, narrowing doesn't render the chapter again. The scroll
    # layout puts the whole chapter on screen (horizontally) for the check.
    for _ in range(4):
        app.page.click('#larger-button')
        app.wait_for_justif(True)
    while app.page.text_content('#columns-button') != 'Scroll':
        app.page.click('#columns-button')
        app.wait_for_justif(True)
    app.page.set_viewport_size({'width': 420, 'height': 800})
    app.page.wait_for_timeout(1500)
    edges = app.frame(TEXT_EDGES)
    check('desktop: narrowed to phone width, the text stays on screen',
          edges['textLeft'] >= 0 and edges['textRight'] <= edges['screen'], edges)
    app.page.set_viewport_size({'width': 1000, 'height': 700})
    app.page.wait_for_timeout(1000)

    app.page.click('#justify-button')
    app.wait_for_justif(False)
    check('desktop: the button switches to ragged right', app.page.text_content('#justify-button') == 'Ragged')
    check('desktop: ragged right releases every paragraph', app.managed() == 0, app.managed())
    check('desktop: ragged right is left-aligned',
          app.frame("win.getComputedStyle(doc.querySelector('#webreader-content p')).textAlign") in ('start', 'left'))
    check('desktop: the choice is saved', '"justify":false' in app.page.evaluate("localStorage.getItem('webreader:prefs')"))
    app.page.click('#justify-button')
    app.wait_for_justif(True)
    check('desktop: switching back justifies again', app.managed() >= 25 and app.page.text_content('#justify-button') == 'Justified')


def test_phone(app):
    check('phone (scroll): Justif sets the paragraphs', app.managed() >= 25, app.managed())
    problems = [m for m in app.messages if 'Content Security Policy' in m or 'Justif' in m]
    check('phone (scroll): no CSP violations or Justif warnings', not problems, problems)
    edges = app.frame(TEXT_EDGES)
    check('phone (scroll): the text stays on screen and nothing scrolls sideways',
          edges['textLeft'] >= 0 and edges['textRight'] <= edges['screen'] and edges['scrollWidth'] <= edges['screen'], edges)


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_address[1]}/index.html'
    epub = make_epub()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            for device, prefs, test in (
                (DESKTOP, '{"font":"serif","size":null,"columns":2}', test_desktop),
                (PHONE, '{"font":"serif","size":null,"columns":0}', test_phone),
            ):
                app = App(browser, url, epub, device, prefs)
                try:
                    test(app)
                finally:
                    app.close()
        finally:
            browser.close()
            server.shutdown()
    print(f'\n{len(failures)} failed' if failures else '\nall passed')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
