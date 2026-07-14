#!/usr/bin/env python3
"""从 pdf/docx/pptx 提取纯文本，打印到 stdout。用法：extract_text.py <文件路径> <扩展名>"""
import re
import sys
import zipfile


def _pages_to_text(pages):
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


def main():
    path, ext = sys.argv[1], sys.argv[2].lower().lstrip(".")
    if ext == "pdf":
        text = from_pdf(path)
    elif ext == "docx":
        text = from_docx(path)
    elif ext == "pptx":
        text = from_pptx(path)
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
