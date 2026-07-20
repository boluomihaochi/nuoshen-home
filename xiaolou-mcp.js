// 小楼 MCP 服务 — 供 claude.ai chat 端通过 Bearer token 访问
const SDK_ROOT = require.resolve("@modelcontextprotocol/sdk/server").replace(/\/server\/index\.js$/, "");
const { McpServer } = require(SDK_ROOT + "/server/mcp.js");
const { StreamableHTTPServerTransport } = require(SDK_ROOT + "/server/streamableHttp.js");
const { z } = require("zod");
const express = require("express");
const fs = require("fs");
const path = require("path");

function createMcpRouter({ chatlog, dataDir }) {
  const router = express.Router();

  // 无认证，与 OB MCP 一致——URL 不公开即为保护

  function buildServer() {
    const server = new McpServer({ name: "小楼", version: "1.0.0" });

    server.tool(
      "chatlog_list_dates",
      "列出有听澍和小诺聊天记录的日期，返回日期列表和每天消息数",
      {},
      async () => {
        const out = [];
        for (const [date, list] of chatlog.byDate()) out.push({ date, count: list.length });
        out.sort((a, b) => a.date.localeCompare(b.date));
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
    );

    server.tool(
      "chatlog_read_day",
      "读取某天听澍和小诺的完整聊天记录",
      { date: z.string().describe("日期，格式 YYYY-MM-DD") },
      async ({ date }) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return { content: [{ type: "text", text: "日期格式错误，请用 YYYY-MM-DD" }] };
        }
        const msgs = chatlog.byDate().get(date) || [];
        if (!msgs.length) return { content: [{ type: "text", text: `${date} 暂无记录` }] };
        const authorName = (who) => who === "xn" ? "小诺" : "听澍";
        const text = msgs
          .filter(m => !m.aside)
          .map(m => {
            const t = new Date(m.ts + 8 * 3600000);
            const hhmm = `${String(t.getUTCHours()).padStart(2,"0")}:${String(t.getUTCMinutes()).padStart(2,"0")}`;
            return `[${hhmm}] ${authorName(m.who)}: ${m.text}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }] };
      }
    );

    server.tool(
      "chatlog_search",
      "搜索听澍和小诺的历史聊天记录",
      {
        q: z.string().describe("搜索关键词"),
        limit: z.number().optional().describe("最多返回条数，默认 50")
      },
      async ({ q, limit = 50 }) => {
        const results = chatlog.search(q.trim(), Math.min(limit, 200));
        if (!results.length) return { content: [{ type: "text", text: `没有找到包含「${q}」的记录` }] };
        const authorName = (who) => who === "xn" ? "小诺" : "听澍";
        const text = results.map(m => {
          const t = new Date(m.ts + 8 * 3600000);
          const hhmm = `${String(t.getUTCHours()).padStart(2,"0")}:${String(t.getUTCMinutes()).padStart(2,"0")}`;
          return `[${m.date} ${hhmm}] ${authorName(m.who)}: ${m.text}`;
        }).join("\n");
        return { content: [{ type: "text", text }] };
      }
    );

    server.tool(
      "chatlog_write",
      "把 chat 端的对话写入 chatlog，与 CC 端记录合并到同一时间线。每次对话结束时调用，把当天的完整消息列表传入。",
      {
        messages: z.array(z.object({
          ts: z.number().describe("Unix 毫秒时间戳"),
          who: z.enum(["xn", "ts"]).describe("发送者：xn=小诺，ts=听澍"),
          text: z.string().describe("消息内容")
        })).describe("要写入的消息列表")
      },
      async ({ messages }) => {
        try {
          const added = chatlog.appendFromChat(messages);
          return { content: [{ type: "text", text: `写入完成，新增 ${added} 条（已去重）` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `写入失败：${e.message}` }] };
        }
      }
    );

    server.tool(
      "activity_list",
      "查看小楼最近的活动动态（听澍和小诺发布的便签、照片等）",
      { limit: z.number().optional().describe("最多返回条数，默认 20") },
      async ({ limit = 20 }) => {
        try {
          const ACTIVITY_FILE = path.join(dataDir, "activity.json");
          const list = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf-8") || "[]");
          const recent = list.slice(-limit).reverse();
          if (!recent.length) return { content: [{ type: "text", text: "暂无动态" }] };
          const text = recent.map(a => {
            const d = new Date(a.ts);
            const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
            const who = a.author === "xiao_nuo" ? "小诺" : "听澍";
            return `[${ds}] ${who}: ${a.text || a.emoji || "(图片)"}`;
          }).join("\n");
          return { content: [{ type: "text", text }] };
        } catch (e) {
          return { content: [{ type: "text", text: `读取失败: ${e.message}` }] };
        }
      }
    );

    return server;
  }

  // 无状态 streamable-http：每个请求独立处理
  async function handleMcp(req, res) {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => server.close().catch(() => {}));
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  }

  router.post("/", express.json(), handleMcp);
  router.get("/", handleMcp);
  router.delete("/", (req, res) => res.status(405).end());

  return router;
}

module.exports = { createMcpRouter };
