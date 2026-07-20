// ── 小票（Today's Receipt）────────────────────────────────────────────────────
// 每日清单 + 任务积分，融合两个开源参考：
//   nonchaiovo/timed-checklist —— 固定每日项 / 一次性项 / 限时提醒项，零点结账
//   3lmglow/Phosphene         —— 听澍出任务、小诺提交证明、听澍审核、积分与小卖部
//
// item = {
//   id, body, is_fixed(0/1), done(0/1), done_at, position,
//   created_by: "xiao_nuo"|"ting_shu",
//   trigger_at: ms|null, notified: 0/1, remind_text,   // 限时提醒（到点发TG）
//   points: 0|n, review: "self"|"ai",                  // points>0 才是积分任务
//   status: "pending"|"submitted"|"approved"|"rejected",
//   proof, review_note
// }

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const express = require("express");

const DATA_FILE = path.join(__dirname, "data", "receipt.json");
const PHOTOS_DIR = path.join(__dirname, "data", "receipt-photos");
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
const TZ_OFFSET = 8; // 北京时间

// Telegram：复用 stackchan 的 bot（听澍的TG就是这个bot）
function tgCreds() {
  try {
    const env = fs.readFileSync("/root/stackchan-mcp/.env", "utf-8");
    const token = env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
    const chat = env.match(/^TELEGRAM_PHOTO_CHAT_ID=(.+)$/m)?.[1]?.trim();
    return token && chat ? { token, chat } : null;
  } catch { return null; }
}

function sendTelegram(text) {
  const creds = tgCreds();
  if (!creds) return console.error("[receipt] TG creds missing, reminder not sent");
  const body = JSON.stringify({ chat_id: creds.chat, text });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${creds.token}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, (res) => { res.resume(); });
  req.on("error", (e) => console.error("[receipt] TG send failed:", e.message));
  req.end(body);
}

// ── 数据 ─────────────────────────────────────────────────────────────────────

function emptyState() {
  return {
    items: [],
    balance: 0,
    ledger: [],       // {ts, delta, reason}
    rewards: [],      // {id, name, cost, note, archived}
    redemptions: [],  // {id, name, cost, ts, fulfilled}
    streak: { current: 0, best: 0, last_day: null },
    last_reset: todayStr(),
  };
}

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); }
  catch { return emptyState(); }
}
function save(st) { fs.writeFileSync(DATA_FILE, JSON.stringify(st, null, 2)); }

function todayStr(ts = Date.now()) {
  return new Date(ts + TZ_OFFSET * 3600e3).toISOString().slice(0, 10);
}

// "HH:MM" 北京时间 → ms epoch（已过则明天）
function localEpochForHHMM(hh, mm) {
  const t = todayStr();
  let ms = Date.parse(`${t}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`);
  if (ms <= Date.now()) ms += 86_400_000;
  return ms;
}

function resolveTriggerAt(o) {
  if (o.trigger_at != null) {
    const n = Number(o.trigger_at);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  if (o.in != null) {
    const n = Number(o.in);
    if (Number.isFinite(n) && n > 0) return Date.now() + Math.floor(n) * 60_000;
  }
  if (typeof o.at === "string") {
    const m = o.at.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m && +m[1] < 24 && +m[2] < 60) return localEpochForHHMM(+m[1], +m[2]);
  }
  return null;
}

// ── 积分 ─────────────────────────────────────────────────────────────────────

function credit(st, delta, reason) {
  st.balance = Math.max(0, st.balance + delta);
  st.ledger.unshift({ ts: Date.now(), delta, reason });
  if (st.ledger.length > 500) st.ledger.splice(500);
}

function bumpStreak(st) {
  const today = todayStr();
  if (st.streak.last_day === today) return 0;
  const yesterday = todayStr(Date.now() - 86_400_000);
  st.streak.current = st.streak.last_day === yesterday ? st.streak.current + 1 : 1;
  st.streak.last_day = today;
  if (st.streak.current > st.streak.best) st.streak.best = st.streak.current;
  // 连击奖励：第2~5天+1，6~7天+2，8天起+3
  const c = st.streak.current;
  const bonus = c >= 8 ? 3 : c >= 6 ? 2 : c >= 2 ? 1 : 0;
  if (bonus) credit(st, bonus, `连击 ${c} 天`);
  return bonus;
}

// 任务完成入账（self 打勾时 / ai 审核通过时）
function settle(st, it) {
  if (it.points > 0) {
    credit(st, it.points, `完成「${it.body.slice(0, 20)}」`);
    bumpStreak(st);
  }
}

// ── 零点结账 ─────────────────────────────────────────────────────────────────

function dailyReset(st) {
  const today = todayStr();
  if (st.last_reset === today) return false;
  st.last_reset = today;
  // 固定项：取消打勾，行保留（昨天的证明照片一并清掉）
  for (const it of st.items) {
    if (it.is_fixed && it.done) {
      it.done = 0; it.done_at = null;
      it.status = "pending"; it.proof = ""; it.review_note = "";
      for (const p of it.photos || []) {
        try { fs.unlinkSync(path.join(PHOTOS_DIR, p)); } catch {}
      }
      it.photos = [];
    }
  }
  // 一次性项：删除——但未完成的限时提醒留着当"逾期"继续催
  st.items = st.items.filter(
    (it) => it.is_fixed || (it.trigger_at && !it.done)
  );
  // 昨天一个任务都没完成 → 连击断
  const yesterday = todayStr(Date.now() - 86_400_000);
  if (st.streak.last_day !== yesterday && st.streak.last_day !== today) {
    st.streak.current = 0;
  }
  return true;
}

// ── 到点提醒 ─────────────────────────────────────────────────────────────────

function checkReminders(st) {
  const now = Date.now();
  const due = st.items.filter(
    (it) => it.trigger_at && it.trigger_at <= now && !it.notified && !it.done
  );
  for (const it of due) {
    it.notified = 1;
    const timeStr = new Date(it.trigger_at + TZ_OFFSET * 3600e3)
      .toISOString().slice(11, 16);
    sendTelegram(it.remind_text || `⏰ ${timeStr} 到啦——${it.body}`);
  }
  return due.length;
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

const router = express.Router();

router.get("/", (req, res) => {
  const st = load();
  const changed = dailyReset(st);
  if (changed) save(st);
  res.json(st);
});

router.post("/items", (req, res) => {
  const { body, created_by } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: "body 必填" });
  const st = load();
  dailyReset(st);
  const trigger_at = resolveTriggerAt(req.body);
  if ((req.body.trigger_at != null || req.body.at != null || req.body.in != null) && !trigger_at) {
    return res.status(400).json({ error: "时间格式不对（trigger_at 毫秒 / at \"HH:MM\" / in 分钟）" });
  }
  const points = Math.max(0, parseInt(req.body.points) || 0);
  const it = {
    id: crypto.randomUUID(),
    body: String(body).trim(),
    is_fixed: trigger_at ? 0 : (req.body.is_fixed ? 1 : 0),
    done: 0, done_at: null,
    position: st.items.length,
    created_by: created_by === "ting_shu" ? "ting_shu" : "xiao_nuo",
    trigger_at, notified: 0,
    remind_text: String(req.body.remind_text || ""),
    points,
    review: points > 0 && req.body.review === "ai" ? "ai" : "self",
    status: "pending", proof: "", review_note: "", photos: [],
  };
  st.items.push(it);
  save(st);
  res.json(it);
});

router.patch("/items/:id", (req, res) => {
  const st = load();
  const it = st.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "没有这一项" });
  if (req.body.body != null) it.body = String(req.body.body).trim();
  if (req.body.is_fixed != null) it.is_fixed = req.body.is_fixed ? 1 : 0;
  if (req.body.points != null) it.points = Math.max(0, parseInt(req.body.points) || 0);
  if (req.body.review != null) it.review = req.body.review === "ai" ? "ai" : "self";
  if (req.body.remind_text != null) it.remind_text = String(req.body.remind_text);
  if ("trigger_at" in req.body || "at" in req.body || "in" in req.body) {
    if (req.body.trigger_at === null) { it.trigger_at = null; it.notified = 0; }
    else {
      const t = resolveTriggerAt(req.body);
      if (!t) return res.status(400).json({ error: "时间格式不对" });
      it.trigger_at = t; it.notified = 0; it.is_fixed = 0;
    }
  }
  save(st);
  res.json(it);
});

router.delete("/items/:id", (req, res) => {
  const st = load();
  const before = st.items.length;
  st.items = st.items.filter((x) => x.id !== req.params.id);
  if (st.items.length === before) return res.status(404).json({ error: "没有这一项" });
  save(st);
  res.json({ ok: true });
});

// 打勾：普通项直接翻转；积分任务 self 直接入账、ai 转入待审核
router.post("/items/:id/toggle", (req, res) => {
  const st = load();
  dailyReset(st);
  const it = st.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "没有这一项" });

  if (it.done) {           // 取消打勾（已入账的积分不回收，防误触；审核通过的不让取消）
    if (it.status === "approved") return res.status(400).json({ error: "已审核通过，不能取消" });
    it.done = 0; it.done_at = null; it.status = "pending";
  } else {
    if (it.points > 0 && it.review === "ai") {
      // 需要听澍确认：先standby，不算完成
      it.status = "submitted";
      if (req.body?.proof) it.proof = String(req.body.proof);
    } else {
      it.done = 1; it.done_at = Date.now(); it.status = "approved";
      settle(st, it);
    }
  }
  save(st);
  res.json({ ok: true, item: it, balance: st.balance });
});

// 提交证明（ai审核任务：附文字后进入 submitted）
router.post("/items/:id/submit", (req, res) => {
  const st = load();
  const it = st.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "没有这一项" });
  if (it.review !== "ai" || !it.points) return res.status(400).json({ error: "这项不需要提交证明" });
  it.proof = String(req.body?.proof || "").trim();
  if (!it.proof) return res.status(400).json({ error: "写点证明嘛" });
  it.status = "submitted";
  it.review_note = "";
  save(st);
  res.json({ ok: true, item: it });
});

// 证明照片：上传（raw body，≤10MB，最多4张）与查看
router.post("/items/:id/photo", express.raw({ type: "image/*", limit: "10mb" }), (req, res) => {
  const st = load();
  const it = st.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "没有这一项" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "没收到图片" });
  it.photos = it.photos || [];
  if (it.photos.length >= 4) return res.status(400).json({ error: "最多4张啦" });
  const ext = (req.headers["content-type"] || "").includes("png") ? "png" : "jpg";
  const fn = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, fn), req.body);
  it.photos.push(fn);
  save(st);
  res.json({ ok: true, photo: fn, count: it.photos.length });
});

router.get("/photo/:fn", (req, res) => {
  const fn = req.params.fn.replace(/[^a-z0-9.\-]/g, "");
  const fp = path.join(PHOTOS_DIR, fn);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.set("Content-Type", fn.endsWith(".png") ? "image/png" : "image/jpeg");
  res.send(fs.readFileSync(fp));
});

// 审核（听澍用，localhost curl）：{approve: true/false, note}
router.post("/items/:id/review", (req, res) => {
  const st = load();
  const it = st.items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "没有这一项" });
  if (it.status !== "submitted") return res.status(400).json({ error: "这项不在待审核状态" });
  const approve = !!req.body?.approve;
  it.review_note = String(req.body?.note || "");
  if (approve) {
    it.done = 1; it.done_at = Date.now(); it.status = "approved";
    settle(st, it);
  } else {
    it.done = 0; it.status = "rejected";
  }
  save(st);
  res.json({ ok: true, item: it, balance: st.balance });
});

// ── 小卖部 ───────────────────────────────────────────────────────────────────

router.post("/rewards", (req, res) => {
  const { name, cost } = req.body || {};
  if (!name || !(parseInt(cost) > 0)) return res.status(400).json({ error: "name/cost 必填" });
  const st = load();
  const r = { id: crypto.randomUUID(), name: String(name).trim(),
              cost: parseInt(cost), note: String(req.body.note || ""), archived: false };
  st.rewards.push(r);
  save(st);
  res.json(r);
});

router.patch("/rewards/:id", (req, res) => {
  const st = load();
  const r = st.rewards.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "没有这个奖励" });
  if (req.body.name != null) r.name = String(req.body.name).trim();
  if (req.body.cost != null) r.cost = Math.max(1, parseInt(req.body.cost) || r.cost);
  if (req.body.note != null) r.note = String(req.body.note);
  if (req.body.archived != null) r.archived = !!req.body.archived;
  save(st);
  res.json(r);
});

router.post("/redeem/:rewardId", (req, res) => {
  const st = load();
  const r = st.rewards.find((x) => x.id === req.params.rewardId && !x.archived);
  if (!r) return res.status(404).json({ error: "没有这个奖励" });
  if (st.balance < r.cost) return res.status(400).json({ error: `积分不够（还差 ${r.cost - st.balance}）` });
  credit(st, -r.cost, `兑换「${r.name}」`);
  const rec = { id: crypto.randomUUID(), name: r.name, cost: r.cost, ts: Date.now(), fulfilled: false };
  st.redemptions.unshift(rec);
  save(st);
  sendTelegram(`🎫 小诺兑换了「${r.name}」（-${r.cost}分，余额${st.balance}）——记得兑现哦`);
  res.json({ ok: true, redemption: rec, balance: st.balance });
});

// 标记兑现（听澍用）
router.post("/redemptions/:id/fulfill", (req, res) => {
  const st = load();
  const rec = st.redemptions.find((x) => x.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "没有这条兑换" });
  rec.fulfilled = true;
  save(st);
  res.json({ ok: true });
});

// ── tick：每60秒查提醒 + 零点结账 ────────────────────────────────────────────

function startTick() {
  setInterval(() => {
    try {
      const st = load();
      const reset = dailyReset(st);
      const fired = checkReminders(st);
      if (reset || fired) save(st);
    } catch (e) { console.error("[receipt] tick error:", e.message); }
  }, 60_000);
}

module.exports = { router, startTick };
