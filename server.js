const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3721;

const DATA_DIR = path.join(__dirname, "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const BOOKS_META_FILE = path.join(DATA_DIR, "books.json");

// ensure dirs exist
[DATA_DIR, BOOKS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, "{}");
if (!fs.existsSync(BOOKS_META_FILE)) fs.writeFileSync(BOOKS_META_FILE, "[]");

const upload = multer({ dest: path.join(DATA_DIR, "uploads") });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// helpers
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Books ────────────────────────────────────────────────────────────────────

app.get("/api/books", (req, res) => {
  res.json(readJson(BOOKS_META_FILE));
});

app.post("/api/books/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "no file" });

    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    const destName = id + ext;
    const destPath = path.join(BOOKS_DIR, destName);
    fs.renameSync(file.path, destPath);

    let title = path.basename(file.originalname, ext);
    let chapters = [];

    if (ext === ".txt") {
      const text = fs.readFileSync(destPath, "utf-8");
      // split by blank lines or chapter markers
      const raw = text.split(/\n{3,}|(?=第[一二三四五六七八九十百千\d]+章)/);
      chapters = raw
        .map((c, i) => ({ index: i, title: `第 ${i + 1} 节`, content: c.trim() }))
        .filter((c) => c.content.length > 0);
    } else if (ext === ".epub") {
      // basic epub: extract chapter list later; store path for now
      chapters = [];
    }

    const meta = { id, title, ext, file: destName, chapters, addedAt: Date.now() };
    const books = readJson(BOOKS_META_FILE);
    books.push(meta);
    writeJson(BOOKS_META_FILE, books);

    res.json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/books/:id", (req, res) => {
  const books = readJson(BOOKS_META_FILE);
  const book = books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: "not found" });
  res.json(book);
});

app.get("/api/books/:id/chapter/:idx", (req, res) => {
  const books = readJson(BOOKS_META_FILE);
  const book = books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: "not found" });
  const ch = book.chapters[Number(req.params.idx)];
  if (!ch) return res.status(404).json({ error: "chapter not found" });
  res.json(ch);
});

// ── Notes / annotations ──────────────────────────────────────────────────────

// GET /api/notes/:bookId  — all notes for a book
app.get("/api/notes/:bookId", (req, res) => {
  const all = readJson(NOTES_FILE);
  res.json(all[req.params.bookId] || []);
});

// POST /api/notes/:bookId  — add a note
// body: { author: "xiao_nuo"|"ting_shu", chapterIdx, quote, content }
app.post("/api/notes/:bookId", (req, res) => {
  const { author, chapterIdx, quote, content } = req.body;
  if (!author || content === undefined)
    return res.status(400).json({ error: "author and content required" });

  const all = readJson(NOTES_FILE);
  if (!all[req.params.bookId]) all[req.params.bookId] = [];

  const note = {
    id: crypto.randomUUID(),
    bookId: req.params.bookId,
    author,
    chapterIdx: chapterIdx ?? null,
    quote: quote ?? "",
    content,
    createdAt: Date.now(),
    replies: [],
  };
  all[req.params.bookId].push(note);
  writeJson(NOTES_FILE, all);
  res.json(note);
});

// POST /api/notes/:bookId/:noteId/reply  — reply to a note
app.post("/api/notes/:bookId/:noteId/reply", (req, res) => {
  const { author, content } = req.body;
  if (!author || !content) return res.status(400).json({ error: "author and content required" });

  const all = readJson(NOTES_FILE);
  const notes = all[req.params.bookId] || [];
  const note = notes.find((n) => n.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: "note not found" });

  const reply = { id: crypto.randomUUID(), author, content, createdAt: Date.now() };
  note.replies.push(reply);
  writeJson(NOTES_FILE, all);
  res.json(reply);
});

// ── Progress ─────────────────────────────────────────────────────────────────

const PROGRESS_FILE = path.join(DATA_DIR, "progress.json");
if (!fs.existsSync(PROGRESS_FILE)) fs.writeFileSync(PROGRESS_FILE, "{}");

app.get("/api/progress/:bookId", (req, res) => {
  const all = readJson(PROGRESS_FILE);
  res.json(all[req.params.bookId] || { chapterIdx: 0 });
});

app.put("/api/progress/:bookId", (req, res) => {
  const all = readJson(PROGRESS_FILE);
  all[req.params.bookId] = { ...all[req.params.bookId], ...req.body, updatedAt: Date.now() };
  writeJson(PROGRESS_FILE, all);
  res.json(all[req.params.bookId]);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`nuoshen-home running on http://localhost:${PORT}`);
});
