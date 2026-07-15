const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3721;

const DATA_DIR = path.join(__dirname, "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const BOOKS_META_FILE = path.join(DATA_DIR, "books.json");
const PROGRESS_FILE = path.join(DATA_DIR, "progress.json");

[DATA_DIR, BOOKS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, "{}");
if (!fs.existsSync(BOOKS_META_FILE)) fs.writeFileSync(BOOKS_META_FILE, "[]");
if (!fs.existsSync(PROGRESS_FILE)) fs.writeFileSync(PROGRESS_FILE, "{}");

// ── 密码门 ────────────────────────────────────────────────────────────────────
// localhost 免验（听澍的CLI、hooks、备份脚本都走本机）；外部访问需要 cookie。

const AUTH_FILE = path.join(DATA_DIR, "auth.json");
if (!fs.existsSync(AUTH_FILE)) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ password: "小楼一夜听春雨", tokens: [] }, null, 2));
}
function readAuth() { return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")); }

function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

app.post("/api/login", express.json(), (req, res) => {
  const auth = readAuth();
  if ((req.body?.password || "") !== auth.password) {
    return res.status(401).json({ error: "不对哦" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  auth.tokens = (auth.tokens || []).slice(-19);   // 最多保留20个设备
  auth.tokens.push(token);
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
  res.set("Set-Cookie", `xiaolou=${token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  const ip = req.socket.remoteAddress || "";
  const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  // cloudflared 隧道的请求也来自 127.0.0.1，但会带 cf-connecting-ip / x-forwarded-for；
  // 只有真·本机请求（听澍的CLI、hooks、备份脚本）才免验
  const viaTunnel = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"];
  if (isLoopback && !viaTunnel) return next();
  if (req.path === "/login.html") return next();
  const token = getCookie(req, "xiaolou");
  if (token && (readAuth().tokens || []).includes(token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "需要登录" });
  res.redirect("/login.html");
});

// ── OB dashboard proxy (回忆模块) ─────────────────────────────────────────────
// 把 Ombre Brain 前端(localhost:8000)代理进小楼，"回忆"页同源 iframe 嵌入。
// 必须放在 express.json() 之前，否则 POST 请求体会被提前消费掉。

const http = require("http");
const OB_PREFIXES = ["/dashboard", "/auth/", "/api/buckets", "/api/bucket/", "/api/search", "/api/network", "/api/config", "/api/breath-debug"];

app.use((req, res, next) => {
  if (!OB_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) return next();
  const proxyReq = http.request(
    { host: "127.0.0.1", port: 8000, path: req.originalUrl, method: req.method, headers: { ...req.headers, host: "127.0.0.1:8000" } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", () => res.status(502).json({ error: "OB 后端没有响应" }));
  req.pipe(proxyReq);
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
function writeJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ── Text decoding: UTF-8 / BOM / UTF-16 / GB18030 ────────────────────────────

function decodeBytes(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    const le = buf[0] === 0xff;
    return new TextDecoder(le ? "utf-16le" : "utf-16be").decode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf-8");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (_) {}
  try {
    return new TextDecoder("gb18030", { fatal: true }).decode(buf);
  } catch (_) {}
  return buf.toString("utf-8"); // lossy fallback
}

// ── Chapter splitting (ported from Ombre Brain library.py) ───────────────────

const CHAPTER_RE = new RegExp(
  "^(?:" +
    "第\\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\\s*[章回节卷集部篇幕]" +
    "|(?:Chapter|CHAPTER|Chap\\.?|Part|PART)\\s*(?:[0-9]+|[IVXLCivxlc]+|(?:ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY)(?:-[A-Z]+)?)" +
    "|序章|序言|自序|楔子|引子|尾声|终章|后记|跋|番外" +
    ")(?:[\\s:：.、－—-].{0,40})?$",
  "i"
);

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function splitChapters(text) {
  const lines = text.split("\n");
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s && s.length <= 60 && CHAPTER_RE.test(s)) marks.push([i, s]);
  }

  const chapters = [];
  if (marks.length >= 2) {
    if (marks[0][0] > 0) {
      const head = lines.slice(0, marks[0][0]).join("\n").trim();
      if (head.length > 80) chapters.push({ title: "卷首", content: head });
    }
    for (let j = 0; j < marks.length; j++) {
      const [idx, title] = marks[j];
      const end = j + 1 < marks.length ? marks[j + 1][0] : lines.length;
      const body = lines.slice(idx, end).join("\n").trim();
      if (body) chapters.push({ title, content: body });
    }
  } else {
    const size = 12000;
    const n = Math.max(1, Math.ceil(text.length / size));
    for (let k = 0; k < n; k++) {
      chapters.push({ title: `第 ${k + 1} 部分`, content: text.slice(k * size, (k + 1) * size) });
    }
  }
  return chapters;
}

// ── Book storage: chapters as files, books.json holds index only ─────────────

function bookDir(id) {
  return path.join(BOOKS_DIR, id);
}
function chapterFile(id, idx) {
  return path.join(bookDir(id), `ch_${String(idx).padStart(4, "0")}.txt`);
}

function storeBook(title, chapters, coverColor) {
  const id = crypto.randomUUID();
  fs.mkdirSync(bookDir(id), { recursive: true });
  chapters.forEach((ch, i) => fs.writeFileSync(chapterFile(id, i), ch.content));
  const meta = {
    id,
    title,
    coverColor: coverColor || COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
    status: "reading",
    addedAt: Date.now(),
    chapters: chapters.map((ch) => ({ title: ch.title, chars: ch.content.length })),
  };
  const books = readJson(BOOKS_META_FILE);
  books.push(meta);
  writeJson(BOOKS_META_FILE, books);
  return meta;
}

const COVER_COLORS = ["#8b7d9e","#7d9e8b","#9e8b7d","#7d8f9e","#9e7d8b","#6e8c7a","#8c7a6e","#7a6e8c","#7a8a6e","#8c6e8a"];

// One-time migration: strip inline chapter content out of books.json into files
(function migrate() {
  const books = readJson(BOOKS_META_FILE);
  let changed = false;
  for (const b of books) {
    if (b.chapters.length && b.chapters[0].content !== undefined) {
      fs.mkdirSync(bookDir(b.id), { recursive: true });
      b.chapters.forEach((ch, i) => fs.writeFileSync(chapterFile(b.id, i), ch.content || ""));
      b.chapters = b.chapters.map((ch) => ({ title: ch.title, chars: (ch.content || "").length }));
      changed = true;
    }
  }
  if (changed) {
    writeJson(BOOKS_META_FILE, books);
    console.log("migrated inline chapters to per-chapter files");
  }
})();

// ── Books API ────────────────────────────────────────────────────────────────

app.get("/api/books", (req, res) => {
  res.json(readJson(BOOKS_META_FILE));
});

// POST /api/books/upload?name=书名.txt — raw file body（txt/md/epub/pdf/docx）
const BOOK_EXTS = ["txt", "md", "epub", "pdf", "docx"];
app.post("/api/books/upload", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
  try {
    const name = req.query.name || "未命名.txt";
    const ext = path.extname(name).toLowerCase().replace(".", "") || "txt";
    const title = path.basename(name, path.extname(name)).slice(0, 80) || "未命名";
    if (!BOOK_EXTS.includes(ext))
      return res.status(400).json({ error: `不支持 .${ext}，能传：${BOOK_EXTS.join(" / ")}` });

    let chapters;
    if (ext === "txt" || ext === "md") {
      const text = normalizeText(decodeBytes(req.body));
      if (text.length < 10) return res.status(400).json({ error: "文件是空的或无法解码" });
      chapters = splitChapters(text);
    } else {
      // epub/pdf/docx：先落临时文件，交给 extract_text.py（plain 模式，不加页码标记）
      const tmp = path.join(require("os").tmpdir(), `book-${crypto.randomUUID()}.${ext}`);
      fs.writeFileSync(tmp, req.body);
      let text;
      try {
        text = execFileSync("python3", [path.join(__dirname, "extract_text.py"), tmp, ext, "plain"], {
          maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        }).toString("utf-8");
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString("utf-8") : String(e);
        return res.status(400).json({ error: msg || "提取文字失败" });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      if (ext === "epub" && text.includes("\x01CH\x01")) {
        // epub 自带章节结构，直接用
        chapters = text.split("\x01CH\x01").filter((s) => s.trim()).map((s) => {
          const nl = s.indexOf("\n");
          return { title: s.slice(0, nl).trim().slice(0, 60) || "无题", content: normalizeText(s.slice(nl + 1)) };
        }).filter((ch) => ch.content);
      } else {
        chapters = splitChapters(normalizeText(text));
      }
      if (!chapters.length) return res.status(400).json({ error: "文件里没有可提取的文字" });
    }
    res.json(storeBook(title, chapters));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.patch("/api/books/:id", (req, res) => {
  const books = readJson(BOOKS_META_FILE);
  const idx = books.findIndex((b) => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "not found" });
  ["status", "title", "coverColor"].forEach((k) => {
    if (req.body[k] !== undefined) books[idx][k] = req.body[k];
  });
  writeJson(BOOKS_META_FILE, books);
  res.json(books[idx]);
});

app.delete("/api/books/:id", (req, res) => {
  let books = readJson(BOOKS_META_FILE);
  const book = books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: "not found" });
  books = books.filter((b) => b.id !== req.params.id);
  writeJson(BOOKS_META_FILE, books);
  fs.rmSync(bookDir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get("/api/books/:id", (req, res) => {
  const book = readJson(BOOKS_META_FILE).find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: "not found" });
  res.json(book);
});

app.get("/api/books/:id/chapter/:idx", (req, res) => {
  const book = readJson(BOOKS_META_FILE).find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: "not found" });
  const idx = Number(req.params.idx);
  const meta = book.chapters[idx];
  if (!meta) return res.status(404).json({ error: "chapter not found" });
  const file = chapterFile(book.id, idx);
  // legacy books stored under the original .txt filename before migration
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  res.json({ index: idx, title: meta.title, content });
});

// ── Notes / annotations ──────────────────────────────────────────────────────

app.get("/api/allnotes", (req, res) => {
  res.json(readJson(NOTES_FILE));
});

app.get("/api/notes/:bookId", (req, res) => {
  const all = readJson(NOTES_FILE);
  res.json(all[req.params.bookId] || []);
});

app.post("/api/notes/:bookId", (req, res) => {
  const { author, chapterIdx, quote, content, color } = req.body;
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
    color: color || null,
    createdAt: Date.now(),
    replies: [],
  };
  all[req.params.bookId].push(note);
  writeJson(NOTES_FILE, all);
  res.json(note);
});

app.delete("/api/notes/:bookId/:noteId", (req, res) => {
  const all = readJson(NOTES_FILE);
  const notes = all[req.params.bookId] || [];
  const idx = notes.findIndex((n) => n.id === req.params.noteId);
  if (idx < 0) return res.status(404).json({ error: "note not found" });
  notes.splice(idx, 1);
  writeJson(NOTES_FILE, all);
  res.json({ ok: true });
});

app.delete("/api/notes/:bookId/:noteId/reply/:replyId", (req, res) => {
  const all = readJson(NOTES_FILE);
  const note = (all[req.params.bookId] || []).find((n) => n.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: "note not found" });
  const idx = note.replies.findIndex((r) => r.id === req.params.replyId);
  if (idx < 0) return res.status(404).json({ error: "reply not found" });
  note.replies.splice(idx, 1);
  writeJson(NOTES_FILE, all);
  res.json({ ok: true });
});

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

// ── Study files (学习) ───────────────────────────────────────────────────────

const { execFileSync } = require("child_process");
const FILES_DIR = path.join(DATA_DIR, "files");
const FILES_META = path.join(DATA_DIR, "files.json");
fs.mkdirSync(FILES_DIR, { recursive: true });
if (!fs.existsSync(FILES_META)) fs.writeFileSync(FILES_META, "[]");

const STUDY_EXTS = ["txt", "md", "pdf", "docx", "pptx"];

app.get("/api/files", (req, res) => {
  res.json(readJson(FILES_META));
});

app.post("/api/files/upload", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
  try {
    const name = path.basename(req.query.name || "未命名.txt").slice(0, 100);
    const ext = path.extname(name).toLowerCase().replace(".", "");
    if (!STUDY_EXTS.includes(ext))
      return res.status(400).json({ error: `不支持 .${ext}，能传：${STUDY_EXTS.join(" / ")}` });

    const id = crypto.randomUUID();
    const rawPath = path.join(FILES_DIR, `${id}.${ext}`);
    fs.writeFileSync(rawPath, req.body);

    let text;
    if (ext === "txt" || ext === "md") {
      text = normalizeText(decodeBytes(req.body));
    } else {
      try {
        text = execFileSync("python3", [path.join(__dirname, "extract_text.py"), rawPath, ext], {
          maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        }).toString("utf-8");
      } catch (e) {
        fs.unlinkSync(rawPath);
        const msg = e.stderr ? e.stderr.toString("utf-8") : String(e);
        return res.status(400).json({ error: msg || "提取文字失败" });
      }
      text = normalizeText(text);
    }
    if (text.length < 5) {
      fs.unlinkSync(rawPath);
      return res.status(400).json({ error: "文件里没有可提取的文字" });
    }
    fs.writeFileSync(path.join(FILES_DIR, `${id}.extracted.txt`), text);

    const meta = { id, name, ext, size: req.body.length, chars: text.length, addedAt: Date.now() };
    const files = readJson(FILES_META);
    files.push(meta);
    writeJson(FILES_META, files);
    res.json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/files/:id/text", (req, res) => {
  const meta = readJson(FILES_META).find((f) => f.id === req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  const p = path.join(FILES_DIR, `${meta.id}.extracted.txt`);
  res.json({ ...meta, content: fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "" });
});

app.delete("/api/files/:id", (req, res) => {
  let files = readJson(FILES_META);
  const meta = files.find((f) => f.id === req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  files = files.filter((f) => f.id !== req.params.id);
  writeJson(FILES_META, files);
  for (const suffix of [`.${meta.ext}`, ".extracted.txt"]) {
    const p = path.join(FILES_DIR, meta.id + suffix);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

// ── Avatars ──────────────────────────────────────────────────────────────────

const AVATARS_DIR = path.join(DATA_DIR, "avatars");
fs.mkdirSync(AVATARS_DIR, { recursive: true });

function sniffImageExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf.length > 12 && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  if (buf.length > 3 && buf.subarray(0, 3).toString() === "GIF") return "gif";
  return null;
}
function findAvatar(who) {
  for (const ext of ["jpg", "png", "webp", "gif"]) {
    const f = path.join(AVATARS_DIR, `${who}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

app.post("/api/avatar/:who", express.raw({ type: "*/*", limit: "10mb" }), (req, res) => {
  const who = req.params.who;
  if (!["xn", "ts"].includes(who)) return res.status(400).json({ error: "who must be xn or ts" });
  const ext = sniffImageExt(req.body);
  if (!ext) return res.status(400).json({ error: "不是能识别的图片格式（jpg/png/webp/gif）" });
  const old = findAvatar(who);
  if (old) fs.unlinkSync(old);
  fs.writeFileSync(path.join(AVATARS_DIR, `${who}.${ext}`), req.body);
  res.json({ ok: true });
});

app.get("/api/avatar/:who", (req, res) => {
  const f = findAvatar(req.params.who);
  if (!f) return res.status(404).end();
  // 前端用 ?v=版本号 控制更新，这里可以放心长缓存
  res.set("Cache-Control", "public, max-age=604800");
  res.sendFile(f);
});

// ── Progress ─────────────────────────────────────────────────────────────────

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

// ── Clawd 状态（听澍的 CC 会话通过 hooks 上报，网页轮询）──────────────────────

let clawdStatus = { state: "offline", ts: 0 };

app.post("/api/clawd/status", (req, res) => {
  const { state } = req.body || {};
  if (!["working", "idle", "offline"].includes(state)) {
    return res.status(400).json({ error: "state 必须是 working/idle/offline" });
  }
  clawdStatus = { state, ts: Date.now() };
  res.json(clawdStatus);
});

app.get("/api/clawd/status", (req, res) => {
  // 小诺定的规则：5 分钟没动静就显示睡着
  const stale = Date.now() - clawdStatus.ts > 5 * 60 * 1000;
  res.json(stale ? { state: "offline", ts: clawdStatus.ts } : clawdStatus);
});

// ���─ 听澍动态日志 ────────────────────────────────────────────────────────────────

const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, "[]");

app.post("/api/activity", (req, res) => {
  const { text, type } = req.body || {};
  if (!text) return res.status(400).json({ error: "text 必填" });
  const list = readJson(ACTIVITY_FILE);
  const entry = { id: crypto.randomUUID(), ts: Date.now(), text, type: type || "other" };
  list.unshift(entry);
  if (list.length > 2000) list.splice(2000);
  writeJson(ACTIVITY_FILE, list);
  res.json(entry);
});

app.get("/api/activity", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 2000);
  const list = readJson(ACTIVITY_FILE);
  res.json(list.slice(0, limit));
});

// ── 聊天记录（回忆日历）─────────────────────────────────────────────────────────
const chatlog = require("./chatlog");

app.get("/api/chatlog/dates", (req, res) => {
  try {
    const out = [];
    for (const [date, list] of chatlog.byDate()) out.push({ date, count: list.length });
    out.sort((a, b) => a.date.localeCompare(b.date));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/chatlog/search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q 必填" });
  try {
    res.json(chatlog.search(q, Math.min(parseInt(req.query.limit) || 50, 200)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/chatlog/:date", (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "日期格式 YYYY-MM-DD" });
  try {
    res.json(chatlog.byDate().get(req.params.date) || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`小楼 running on http://localhost:${PORT}`);
});
