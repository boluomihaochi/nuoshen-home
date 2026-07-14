#!/usr/bin/env python3
"""从 pdf/docx/pptx/epub 提取纯文本，打印到 stdout。
用法：extract_text.py <文件路径> <扩展名> [plain]
  plain 模式（给书籍上传用）：pdf 不加【第 N 页】标记；epub 章节用 \\x01 标记分隔。"""
import re
import sys
import zipfile


PLAIN = len(sys.argv) > 3 and sys.argv[3] == "plain"


def _pages_to_text(pages):
    if PLAIN:
        parts = [t for _, t in pages if t]
    else:
        parts = [f"【第 {i} 页】\n{t}" for i, t in pages if t]
    text = "\n\n".join(parts)
    if len(re.sub(r"\s", "", text)) < 50:
        raise RuntimeError("这个 PDF 几乎抽不出文字，可能是扫描版（图片型）")
    return text


def from_pdf(path):
    # 优先 pdftotext（poppler）：对字距/词距的还原远好于 pypdf
    import subprocess
    try:
        out = subprocess.run(
            ["pdftotext", "-enc", "UTF-8", path, "-"],
            capture_output=True, timeout=120,
        )
        if out.returncode == 0:
            raw = out.stdout.decode("utf-8", "replace")
            pages = [(i, p.strip()) for i, p in enumerate(raw.split("\f"), 1)]
            return _pages_to_text(pages)
    except (FileNotFoundError, subprocess.TimeoutExpired, RuntimeError):
        pass
    # 兜底 pypdf
    from pypdf import PdfReader
    reader = PdfReader(path)
    pages = [(i, (page.extract_text() or "").strip()) for i, page in enumerate(reader.pages, 1)]
    return _pages_to_text(pages)


def _xml_text(xml, tag):
    """提取 <tag>…</tag> 里的文字。"""
    return re.findall(rf"<{tag}(?:\s[^>]*)?>([^<]*)</{tag}>", xml)


def from_docx(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    paras = []
    for p in re.split(r"</w:p>", xml):
        runs = _xml_text(p, "w:t")
        line = "".join(runs).strip()
        if line:
            paras.append(line)
    if not paras:
        raise RuntimeError("docx 里没有可提取的文字")
    return "\n\n".join(paras)


def from_pptx(path):
    with zipfile.ZipFile(path) as z:
        names = sorted(
            (n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
            key=lambda n: int(re.search(r"(\d+)", n).group(1)),
        )
        slides = []
        for i, name in enumerate(names, 1):
            xml = z.read(name).decode("utf-8", "replace")
            texts = []
            # 每个 <a:p> 是一个段落，段内 <a:t> 是文字块
            for p in re.split(r"</a:p>", xml):
                line = "".join(_xml_text(p, "a:t")).strip()
                if line:
                    texts.append(line)
            if texts:
                slides.append(f"【第 {i} 页】\n" + "\n".join(texts))
    if not slides:
        raise RuntimeError("pptx 里没有可提取的文字")
    return "\n\n".join(slides)


def _html_to_text(html):
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.S | re.I)
    html = re.sub(r"<br[^>]*>", "\n", html, flags=re.I)
    html = re.sub(r"</(p|div|h[1-6]|li|blockquote|tr)>", "\n\n", html, flags=re.I)
    html = re.sub(r"<[^>]+>", "", html)
    import html as h
    text = h.unescape(html)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def from_epub(path):
    """按 OPF spine 顺序抽出各章。plain 模式下用 \\x01CH\\x01标题 行分隔章节。"""
    import xml.etree.ElementTree as ET
    ns = {
        "c": "urn:oasis:names:tc:opendocument:xmlns:container",
        "opf": "http://www.idpf.org/2007/opf",
    }
    with zipfile.ZipFile(path) as z:
        container = ET.fromstring(z.read("META-INF/container.xml"))
        opf_path = container.find(".//c:rootfile", ns).get("full-path")
        opf = ET.fromstring(z.read(opf_path))
        base = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
        manifest = {
            item.get("id"): item.get("href")
            for item in opf.findall(".//opf:manifest/opf:item", ns)
        }
        chapters = []
        for iref in opf.findall(".//opf:spine/opf:itemref", ns):
            href = manifest.get(iref.get("idref"))
            if not href or not re.search(r"\.x?html?$", href.split("#")[0], re.I):
                continue
            try:
                raw = z.read(base + href.split("#")[0]).decode("utf-8", "replace")
            except KeyError:
                continue
            m = re.search(r"<h[1-3][^>]*>(.*?)</h[1-3]>", raw, re.S | re.I)
            title = _html_to_text(m.group(1)).replace("\n", " ").strip() if m else ""
            text = _html_to_text(raw)
            if len(re.sub(r"\s", "", text)) < 40:
                continue  # 封面页/版权页之类的跳过
            chapters.append((title or f"第 {len(chapters) + 1} 章", text))
    if not chapters:
        raise RuntimeError("epub 里没抽到正文")
    if PLAIN:
        return "\n".join(f"\x01CH\x01{t}\n{c}" for t, c in chapters)
    return "\n\n".join(f"{t}\n{c}" for t, c in chapters)


def main():
    path, ext = sys.argv[1], sys.argv[2].lower().lstrip(".")
    if ext == "pdf":
        text = from_pdf(path)
    elif ext == "docx":
        text = from_docx(path)
    elif ext == "pptx":
        text = from_pptx(path)
    elif ext == "epub":
        text = from_epub(path)
    elif ext in ("doc", "ppt"):
        raise RuntimeError(f"老格式 .{ext} 不支持，请另存为 .{ext}x 再传")
    else:
        raise RuntimeError(f"不认识的格式 .{ext}")
    sys.stdout.write(text)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(str(e))
        sys.exit(1)
