# How an EPUB file is put together

This explains the parts of an EPUB that Web Reader uses and which code handles each part.
For how the app's code is organised, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. An EPUB is a zipped website

An `.epub` file is a ZIP archive. Inside are ordinary web files (XHTML, CSS, images and fonts)
plus a few XML files that describe the book. The packaging rules are called **OCF** (Open
Container Format). A typical book looks like this:

```
my-book.epub  (ZIP)
├── mimetype                      "application/epub+zip", must be the first entry, uncompressed
├── META-INF/
│   ├── container.xml             says where the package document is
│   └── encryption.xml            (optional) lists obfuscated or encrypted files
└── OEBPS/                        any folder name works; "OEBPS" and "OPS" are common
    ├── content.opf               the package document: metadata, manifest, spine
    ├── nav.xhtml                 EPUB 3 table of contents
    ├── toc.ncx                   EPUB 2 table of contents (often included in EPUB 3 too)
    ├── Text/
    │   ├── cover.xhtml
    │   ├── chapter-01.xhtml
    │   └── chapter-02.xhtml
    ├── Styles/book.css
    ├── Images/cover.jpg
    └── Fonts/SomeFont.otf
```

Only `mimetype`, `META-INF/container.xml` and the package document are required to be in fixed
places. Everything else is found by following references, starting from `container.xml`.

## 2. The ZIP layer

`js/zip.js` · `ZipArchive`

A ZIP file is a list of entries followed by a **central directory**, which is an index of every
entry. The very end of the file holds the **End of Central Directory** (EOCD) record:

```
[local header + data] [local header + data] … [central directory] [EOCD]
```

| Record | Signature | What we read from it |
| --- | --- | --- |
| EOCD | `PK\x05\x06` (`0x06054b50`) | number of entries and where the central directory starts |
| Central directory entry | `PK\x01\x02` (`0x02014b50`) | name, compression method, sizes, flags, offset of the local header |
| Local file header | `PK\x03\x04` (`0x04034b50`) | lengths of the name and extra field, which give where the data starts |

The reader searches backwards from the end for the EOCD. It may be followed by a comment of up
to 64 KiB. The central directory is the reliable index; local headers can leave the sizes blank
when a "data descriptor" follows the data instead.

EPUBs use two compression methods:

- **0, stored:** the bytes are used as they are. The `mimetype` file is always stored.
- **8, deflate:** decompressed with the browser's built-in `DecompressionStream('deflate-raw')`.
  This is why no WASM or library is needed.

Not supported: ZIP64 (archives over 4 GB or 65,535 entries; no real EPUB needs this) and
password-protected ZIP entries (general-purpose flag bit 0).

## 3. `META-INF/container.xml`

`js/epub.js` · `Book.open`

This file points to the **package document** (the `.opf` file):

```xml
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
```

`full-path` is relative to the root of the ZIP. If several rootfiles are listed, we use the first
one whose media type is `application/oebps-package+xml`.

## 4. The package document (OPF)

`js/epub.js` · `Book.#parsePackage`

The OPF has three parts that matter to a reader:

```xml
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:…</dc:identifier>
    <dc:title>Politics</dc:title>
    <dc:creator>Aristotle</dc:creator>
    <dc:language>en</dc:language>
  </metadata>

  <manifest>
    <item id="nav"   href="nav.xhtml"             media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx"   href="toc.ncx"               media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="Text/cover.xhtml"      media-type="application/xhtml+xml"/>
    <item id="c1"    href="Text/chapter-01.xhtml" media-type="application/xhtml+xml"/>
    <item id="img"   href="Images/cover.jpg"      media-type="image/jpeg" properties="cover-image"/>
  </manifest>

  <spine toc="ncx">
    <itemref idref="cover" linear="no"/>
    <itemref idref="c1"/>
  </spine>
</package>
```

- **metadata:** Dublin Core fields. We read `dc:title`, `dc:creator` (shown in the toolbar) and
  `dc:language` (sets `lang` on the page, which hyphenation needs).
- **manifest:** every file in the book, each with an `id`, `href` and `media-type`. `properties`
  marks special items: `nav` is the EPUB 3 table of contents, `cover-image` is the cover, and
  `svg`/`scripted` describe what a page contains.
- **spine:** the reading order, as a list of manifest ids. This is what "chapter 3 / 20" counts
  and what Previous/Next steps through. `linear="no"` marks supplementary content such as
  covers and pop-up notes. We keep these in the order given. In EPUB 2, `toc="…"` names the
  NCX file.

EPUB 2 files may also have a `<guide>` section (cover, start of text, and so on). We ignore it.

Element prefixes vary in practice (`<item>` or `<opf:item>`), so lookups match on the local name
and ignore the namespace prefix (`byTag`).

## 5. Paths and links

`js/epub.js` · `resolveHref`, `isExternalHref`

- Every `href` and `src` is **relative to the file it appears in**. In the OPF above,
  `Text/chapter-01.xhtml` becomes the ZIP path `OEBPS/Text/chapter-01.xhtml`. Inside that
  chapter, `../Images/cover.jpg` becomes `OEBPS/Images/cover.jpg`.
- Hrefs are **percent-encoded URLs**, but ZIP entry names are not. For example, the href
  `chapter%20two.xhtml` refers to the ZIP entry `chapter two.xhtml`.
- An href may end in a `#fragment` naming an `id` in the target document. Tables of contents
  and footnotes use these to point into the middle of a chapter.
- Links that start with a scheme (`https:`, `mailto:`) point outside the book.

`resolveHref` turns the referencing file's path into a URL on a dummy host
(`https://epub.invalid/…`). It uses the browser's URL resolution, then decodes the result back
into a ZIP path plus a fragment. Some EPUBs get the letter case of file names wrong, so
`ZipArchive` also falls back to a case-insensitive lookup.

## 6. Table of contents

`js/epub.js` · `Book.#parseNav`, `Book.#parseNcx`

**EPUB 3: navigation document.** This is an XHTML file (manifest `properties="nav"`) containing a
`<nav epub:type="toc">` with nested ordered lists:

```html
<nav epub:type="toc">
  <ol>
    <li><a href="Text/chapter-01.xhtml">Chapter One</a></li>
    <li><span>Part Two</span>          <!-- a heading that isn't a link -->
      <ol><li><a href="Text/chapter-02.xhtml#s1">Section 1</a></li></ol>
    </li>
  </ol>
</nav>
```

The same file can also hold `landmarks` and `page-list` navs. We pick the one marked `toc`, or
the first `<nav>` if none is marked. Headings that aren't links (`<span>`) are skipped, but their
children are kept.

**EPUB 2: NCX.** This is an XML file (`application/x-dtbncx+xml`) with nested `navPoint` elements:

```xml
<navMap>
  <navPoint id="p1">
    <navLabel><text>Chapter One</text></navLabel>
    <content src="Text/chapter-01.xhtml"/>
    <navPoint>…nested…</navPoint>
  </navPoint>
</navMap>
```

We prefer the nav document and fall back to the NCX. If there's neither, or both are empty, the
menu lists "Section 1…N", one per spine item. Each entry stores its spine index, fragment and
nesting depth. Entries that point outside the spine are dropped.

## 7. Content documents

`js/epub.js` · `Book.loadDocument`, and `js/reader.js` · `prepareContent`

Chapters are **XHTML**, which is HTML written with XML rules. That means strict nesting,
`<br/>`, and only XML's five named entities (so `&nbsp;` is technically invalid). In practice:

- We parse as `application/xhtml+xml` first. If that fails (for example because of `&nbsp;`), or
  the root element is not in the XHTML namespace, we use the forgiving `text/html` parser instead.
- Chapters often contain inline SVG. Covers are commonly
  `<svg><image xlink:href="../Images/cover.jpg"/></svg>`.
- Images, audio and video refer to other files in the ZIP. A browser can't load those directly,
  so each one is extracted into a `Blob` and given a `blob:` URL (`Book.resourceUrl`).
- Publisher CSS, embedded fonts, `<script>` and inline `style`/`on*` attributes are removed.
  Web Reader applies its own reading styles to every book.

**Fixed-layout** EPUBs (picture books, comics: `rendition:layout="pre-paginated"`) are made for
fixed-size pages. Web Reader flows them into its own pages like everything else, which works but
won't look the way the publisher intended.

## 8. `META-INF/encryption.xml`, obfuscation and DRM

`js/epub.js` · `assertNotDrm`

This file lists resources that aren't stored as plain bytes:

- **Font obfuscation** (`http://www.idpf.org/2008/embedding` and Adobe's
  `http://ns.adobe.com/pdf/enc#RC`) scrambles embedded fonts so they can't be copied out. It is
  not DRM. Since we don't use publisher fonts, these books open normally.
- **Any other algorithm** means the content itself is encrypted by DRM (Adobe ADEPT, Readium LCP,
  Apple FairPlay, …). Web Reader can't decrypt it and says so instead of showing scrambled text.
  `META-INF/rights.xml` often appears alongside DRM.

## 9. Where each part is handled

| EPUB part | Code |
| --- | --- |
| ZIP container | `ZipArchive` in `js/zip.js` |
| `encryption.xml` / DRM check | `assertNotDrm` in `js/epub.js` |
| `container.xml` → OPF location | `Book.open` |
| OPF metadata, manifest, spine | `Book.#parsePackage` |
| EPUB 3 nav / EPUB 2 NCX | `Book.#parseNav` / `Book.#parseNcx` |
| Relative hrefs | `resolveHref` |
| Chapter XHTML | `Book.loadDocument` → `prepareContent` (in `js/reader.js`) |
| Images and media | `Book.resourceUrl` (blob: URLs) |

## Further reading

- [EPUB 3.3](https://www.w3.org/TR/epub-33/) — the current W3C specification
- [EPUB Open Container Format](https://www.w3.org/TR/epub-33/#sec-ocf) — the ZIP packaging rules
- [ZIP APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) — the ZIP file format
- [OPF 2.0.1](https://idpf.org/epub/20/spec/OPF_2.0.1_draft.htm) — the EPUB 2 package format, including the NCX
