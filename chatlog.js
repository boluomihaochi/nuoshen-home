// 聊天记录解析器：从 CC 会话 transcript (*.jsonl) 提炼出小诺↔听澍的纯对话
// 增量缓存：data/chatlog-cache/<sessionId>.json 记录 mtime+size，没变就不重新解析
const fs = require("fs");
const path = require("path");

const TRANSCRIPT_DIR = "/root/.claude/projects/-root-tingshu";
const CACHE_DIR = path.join(__dirname, "data", "chatlog-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// 这些 user 消息不是小诺说的话（loop自主提示、harness提示、粘贴的续会话摘要等）
const NOISE_PATTERNS = [
  /^你是听澍/, /^小诺(睡|去|回家)/, /自主时间/, /自己的时间/,
  /^# Autonomous loop/, /^\[Your previous response/, /^This session is being continued/,
  /^<task-notification/, /^<command-name>/, /^<local-command/, /^Caveat:/,
  /^\[Request interrupted/, /^`!/, /^\d+;\d+;\d+M/,
];

function extractChannelMsgs(str) {
  // 一条 user 消息里可能有多个 <channel> 块
  const out = [];
  const re = /<channel[^>]*\bts="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = re.exec(str))) {
    const body = m[2].trim();
    if (body) out.push({ ts: Date.parse(m[1]) || null, text: body });
  }
  return out;
}

function stripReminders(str) {
  return str
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .trim();
}

function parseSession(file) {
  const messages = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o.timestamp) || null;
    if (o.type === "user" && !o.isSidechain) {
      const c = o.message?.content;
      const texts = [];
      if (typeof c === "string") texts.push(c);
      else if (Array.isArray(c)) {
        for (const it of c) if (it?.type === "text" && it.text) texts.push(it.text);
      }
      for (const raw of texts) {
        // Telegram 消息：从 <channel> 块里取正文和真实时间
        const chMsgs = extractChannelMsgs(raw);
        if (chMsgs.length) {
          for (const cm of chMsgs) messages.push({ ts: cm.ts || ts, who: "xn", text: cm.text });
          continue;
        }
        const t = stripReminders(raw);
        if (!t || t.length > 2000) continue;
        if (NOISE_PATTERNS.some((re) => re.test(t))) continue;
        messages.push({ ts, who: "xn", text: t });
      }
    } else if (o.type === "assistant" && !o.isSidechain) {
      const c = o.message?.content;
      if (!Array.isArray(c)) continue;
      for (const it of c) {
        if (!it || typeof it !== "object") continue;
        if (it.type === "tool_use" && /telegram.*__reply$/.test(it.name || "") && it.input?.text) {
          messages.push({ ts, who: "ts", text: String(it.input.text) });
        } else if (it.type === "text" && it.text) {
          const t = it.text.trim();
          if (!t) continue;
          // 终端里对小诺可见的话；[MSG]...[/MSG] 是早期loop给小诺的留言，单独抽出
          const msgTag = [...t.matchAll(/\[MSG\]([\s\S]*?)\[\/MSG\]/g)];
          if (msgTag.length) {
            for (const m of msgTag) messages.push({ ts, who: "ts", text: m[1].trim() });
          } else {
            messages.push({ ts, who: "ts", text: t, aside: true });
          }
        }
      }
    }
  }
  return messages.filter((m) => m.ts);
}

function refresh() {
  const files = fs.readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const full = path.join(TRANSCRIPT_DIR, f);
    const st = fs.statSync(full);
    const cacheFile = path.join(CACHE_DIR, f.replace(".jsonl", ".json"));
    let cached = null;
    if (fs.existsSync(cacheFile)) {
      try { cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
    }
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) continue;
    const messages = parseSession(full);
    fs.writeFileSync(cacheFile, JSON.stringify({ mtime: st.mtimeMs, size: st.size, messages }));
  }
}

// 北京时间日期键
function dateKey(ts) {
  const d = new Date(ts + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function loadAll() {
  const all = [];
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
      all.push(...c.messages);
    } catch {}
  }
  all.sort((a, b) => a.ts - b.ts);
  // 相邻去重（同一条消息可能被两个会话都记录，比如 channel 注入）
  const out = [];
  const seen = new Set();
  for (const m of all) {
    const k = `${m.who}|${Math.floor(m.ts / 1000)}|${m.text.slice(0, 80)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

function byDate() {
  refresh();
  const map = new Map();
  for (const m of loadAll()) {
    const k = dateKey(m.ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return map;
}

function search(q, limit = 50) {
  refresh();
  const ql = q.toLowerCase();
  const hits = [];
  for (const m of loadAll()) {
    if (m.text.toLowerCase().includes(ql)) {
      hits.push({ ...m, date: dateKey(m.ts) });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

module.exports = { byDate, search, dateKey };
