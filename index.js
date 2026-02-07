// ====================== IMPORTS ======================
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db/index.js";
import { XOSO188_HEADERS, pingXoso188 } from "./db/lotterySync.js";

process.env.TZ = "Asia/Ho_Chi_Minh";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ====================== 🔐 GI8 INTERNAL KEY GUARD ======================
app.use((req, res, next) => {
  // Cho phép health check, lottery DB read, lottery import (public - proxy bên ngoài có thể yêu cầu token riêng)
  if (req.path === "/health") return next();
  if (req.path.startsWith("/api/lottery/db/")) return next();
  if (req.path === "/api/lottery/sync-test") return next();
  if (req.path === "/api/lottery/ping-xoso188") return next();
  if (req.path === "/api/lottery/import" && req.method === "POST") return next();

  const key = req.headers["x-gi8-key"];

  if (!key || key !== process.env.GI8_INTERNAL_KEY) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Missing or invalid x-gi8-key",
    });
  }

  next();
});

// ====================== SERVE FRONTEND (/public) ======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ====================== PROXY: /api/* -> DB hoặc https://xoso188.net/api/* ======================
// API đích: GET /api/front/open/lottery/history/list/game?limitNum=200&gameCode=xxx
// Trả từ DB với format chuẩn { success, msg, code, t: { turnNum, openTime, serverTime, name, code, sort, navCate, issueList } }
const TARGET_BASE = "https://xoso188.net";

function formatDrawDate(d) {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return { turnNum: `${day}/${month}/${year}`, ymd: `${year}-${month}-${day}` };
}

app.use("/api", async (req, res, next) => {
  const match = req.path.match(/^\/front\/open\/lottery\/history\/list\/game/);
  if (match && req.method === "GET" && req.query.gameCode && db.pool) {
    try {
      const data = await db.getLotteryHistoryListGame(
        req.query.gameCode,
        req.query.limitNum || "200"
      );
      if (!data) {
        return res.status(400).json({
          success: false,
          msg: "gameCode không tồn tại",
          code: 400,
        });
      }
      const now = new Date();
      const serverTime =
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ` +
        `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

      const issueList = [];
      for (const draw of data.draws) {
        const groups = ["", "", "", "", "", "", "", "", ""];
        const prizeMap = { DB: 0, G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8 };
        for (const r of draw.results) {
          const idx = prizeMap[r.prize_code];
          if (idx !== undefined) {
            groups[idx] = groups[idx] ? groups[idx] + "," + r.result_number : r.result_number;
          }
        }
        const { turnNum, ymd } = formatDrawDate(draw.draw_date);
        const openTime = `${ymd} ${data.openTimeByRegion}`;
        const openTimeStamp = new Date(openTime).getTime();
        const openNum = groups[0] || ""; // giải đặc biệt
        issueList.push({
          turnNum,
          openNum,
          openTime,
          openTimeStamp,
          detail: JSON.stringify(groups),
          status: 2,
          replayUrl: null,
          n11: null,
          jackpot: 0,
        });
      }

      const latestTurn = data.draws.length
        ? formatDrawDate(data.draws[0].draw_date)
        : { turnNum: "", ymd: "" };
      const t = {
        turnNum: latestTurn.turnNum,
        openTime: data.draws.length
          ? `${latestTurn.ymd} ${data.openTimeByRegion}`
          : "",
        serverTime,
        name: data.name,
        code: data.code,
        sort: data.sort,
        navCate: data.navCate,
        issueList,
      };

      return res.json({
        success: true,
        msg: "ok",
        code: 0,
        t,
      });
    } catch (e) {
      console.warn("DB history/list/game error:", e.message);
      return res.status(500).json({
        success: false,
        msg: e.message || "Lỗi server",
        code: 500,
      });
    }
  }
  // Proxy to xoso188 (header chuẩn giống Python để không bị chặn)
  const targetUrl = TARGET_BASE + req.originalUrl;
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: { ...XOSO188_HEADERS, Accept: req.headers.accept || "application/json" },
      timeout: 20000,
    });
    const body = await response.text();
    res.status(response.status);
    const ct = response.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    return res.send(body);
  } catch (err) {
    return res.status(500).json({ error: "Proxy failed", message: err.message });
  }
});

// ====================== HEALTH ======================
app.get("/health", (_, res) => res.send("✅ Railway Lottery Proxy Running"));

// ====================== LOTTERY FETCH (proxy xoso188) ======================
// Header chuẩn giống tools/fetch_lottery_and_upload.py để xoso188 không chặn
// GET /api/lottery/fetch?gameCode=xxx&limit=200 - Fetch từ xoso188 qua backend
app.get("/api/lottery/fetch", async (req, res) => {
  const gameCode = req.query.gameCode;
  const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 500);
  if (!gameCode) {
    return res.status(400).json({ error: "Missing gameCode" });
  }
  const targetUrl = `https://xoso188.net/api/front/open/lottery/history/list/game?limitNum=${limit}&gameCode=${gameCode}`;
  try {
    const response = await fetch(targetUrl, {
      headers: { ...XOSO188_HEADERS, Accept: "application/json" },
      timeout: 20000,
    });
    const body = await response.text();
    res.status(response.status);
    res.setHeader("content-type", response.headers.get("content-type") || "application/json");
    return res.send(body);
  } catch (err) {
    return res.status(500).json({ error: "Fetch failed", message: err.message });
  }
});

// GET /api/lottery/ping-xoso188 - Test Railway có gọi được link phụ xoso188 không (không cần key)
app.get("/api/lottery/ping-xoso188", async (req, res) => {
  try {
    const result = await pingXoso188();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      status: 0,
      message: err?.message || String(err),
      count: 0,
      source: "xoso188",
    });
  }
});

// ====================== LOTTERY DB ======================
// POST /api/lottery/import - Nhận dữ liệu từ Python script (cần x-gi8-key)
app.post("/api/lottery/import", async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: "DB not configured", message: "DATABASE_URL not set" });
  }
  try {
    const { draws } = req.body;
    if (!Array.isArray(draws) || draws.length === 0) {
      return res.status(400).json({ error: "Invalid payload", message: "draws array required" });
    }
    const result = await db.importLotteryResults(req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Import error:", err);
    return res.status(500).json({ error: "Import failed", message: err.message });
  }
});

// GET /api/lottery/sync-test?region=mn|mt|mb - Test link phụ xoso188 (không cần key)
app.get("/api/lottery/sync-test", async (req, res) => {
  try {
    const { runSyncTest } = await import("./db/lotterySync.js");
    const region = (req.query.region || "").toLowerCase();
    const result = await runSyncTest(region);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// GET /api/lottery/db/draws?date=DD/MM/YYYY&region=MB|MT|MN - Lấy kết quả theo ngày
app.get("/api/lottery/db/draws", async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: "DB not configured" });
  }
  try {
    const dateStr = req.query.date;
    const region = req.query.region || null;
    if (!dateStr) {
      return res.status(400).json({ error: "Missing date (DD/MM/YYYY)" });
    }
    const [d, m, y] = dateStr.split(/[\/\-]/).map(Number);
    const drawDate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const draws = await db.getDrawsByDate(drawDate, region);
    const withResults = await Promise.all(
      draws.map(async (d) => {
        const results = await db.getResultsByDrawId(d.id);
        return { ...d, results };
      })
    );
    return res.json({ draws: withResults });
  } catch (err) {
    console.error("Get draws error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/lottery/db/history/:gameCode?limit=200 - Format giống xoso188 cho frontend
app.get("/api/lottery/db/history/:gameCode", async (req, res) => {
  if (!db.pool) {
    return res.status(503).json({ error: "DB not configured" });
  }
  try {
    const gameCode = req.params.gameCode;
    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 500);
    const { rows } = await db.pool.query(
      `SELECT d.draw_date, d.id as draw_id, p.api_game_code, p.code as province_code, r.code as region_code
       FROM lottery_draws d
       JOIN lottery_provinces p ON d.province_id = p.id
       JOIN regions r ON d.region_id = r.id
       WHERE p.api_game_code = $1
       ORDER BY d.draw_date DESC
       LIMIT $2`,
      [gameCode, limit]
    );
    const issueList = [];
    for (const row of rows) {
      const resRows = await db.getResultsByDrawId(row.draw_id);
      const groups = ["", "", "", "", "", "", "", "", ""];
      const prizeMap = { DB: 0, G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8 };
      for (const r of resRows) {
        const idx = prizeMap[r.prize_code];
        if (idx !== undefined) {
          if (groups[idx]) groups[idx] += "," + r.result_number;
          else groups[idx] = r.result_number;
        }
      }
      const turnNum = row.draw_date.toISOString().slice(0, 10).split("-").reverse().join("/");
      issueList.push({ turnNum, detail: JSON.stringify(groups) });
    }
    return res.json({ t: { issueList } });
  } catch (err) {
    console.error("History error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ====================== START ======================
// Server listen ngay để Railway không timeout (502); DB init chạy sau
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server chạy port", PORT);
  db
    .initDb()
    .then(async (pool) => {
      if (pool) db.scheduleLotterySync(pool, db.importLotteryResults);
      const ping = await pingXoso188();
      console.log("[Startup] xoso188:", ping.ok ? "OK (count=" + ping.count + ")" : "FAIL", ping.message || "");
    })
    .catch((e) => console.warn("DB init:", e.message));
});
