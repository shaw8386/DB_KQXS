/**
 * Get_DataXS_tructiep.js
 * Thay thế Genlogin automation: fetch trực tiếp từ Minh Ngọc (dc.minhngoc.net),
 * parse kqxs_data, POST lên Railway server /api/lottery/push-kqxs.
 * Server nhận -> utils/minhNgocToXoso188.js parse -> lưu DB.
 *
 * Giờ tự động: MN 16:15, MT 17:15, MB 18:15 (VN). Poll mỗi 2 phút trong ~30 phút.
 *
 * Chạy: node Get_DataXS_tructiep.js
 * Env: RAILWAY_URL=https://your-app.railway.app (hoặc ngrok)
 */

import fetch from "node-fetch";
import cron from "node-cron";

process.env.TZ = "Asia/Ho_Chi_Minh";

const MINH_NGOC_BASE = "https://dc.minhngoc.net/O0O/0/xstt";
const RAILWAY_URL = process.env.RAILWAY_URL || process.env.API_BASE || "http://localhost:3000";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

// js_m1 = MN, js_m2 = MB, js_m3 = MT (theo minhNgocToXoso188.js)
const REGION_CONFIG = {
  mn: { url: "js_m1.js", label: "Miền Nam", cronAt: "15 16 * * *", pollMinutes: 30 },
  mt: { url: "js_m3.js", label: "Miền Trung", cronAt: "15 17 * * *", pollMinutes: 30 },
  mb: { url: "js_m2.js", label: "Miền Bắc", cronAt: "15 18 * * *", pollMinutes: 30 },
};

/**
 * Parse text JS từ Minh Ngọc -> object kqxs_data
 * Format: kqxs.mn={run,tinh,ntime,delay,kq:{13:{0:"xxx",1:"xxx",...},...}}
 */
function parseMinhNgocJs(text, regionKey) {
  const re = new RegExp(`kqxs\\.(${regionKey})\\s*=\\s*(\\{)`);
  const m = text.match(re);
  if (!m) return null;

  let start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;

  let objStr = text.slice(start, end + 1);
  objStr = objStr.replace(/(\w+)\s*:/g, '"$1":');

  try {
    return JSON.parse(objStr);
  } catch {
    return null;
  }
}

/**
 * Fetch raw body từ URL Minh Ngọc
 */
async function fetchMinhNgocRaw(region) {
  const cfg = REGION_CONFIG[region];
  if (!cfg) throw new Error("region phải là mn | mt | mb");

  const url = `${MINH_NGOC_BASE}/${cfg.url}?_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { Accept: "*/*", "User-Agent": "Mozilla/5.0 (compatible; Get_DataXS_tructiep/1.0)" },
    timeout: 15000,
  });

  if (!res.ok) throw new Error(`Minh Ngọc HTTP ${res.status}`);
  return res.text();
}

/**
 * Lấy kqxs_data từ Minh Ngọc, push lên Railway
 */
async function fetchAndPush(region) {
  const cfg = REGION_CONFIG[region];
  const baseUrl = RAILWAY_URL.replace(/\/$/, "");
  const pushUrl = `${baseUrl}/api/lottery/push-kqxs`;

  try {
    const raw = await fetchMinhNgocRaw(region);
    const kqxs_data = parseMinhNgocJs(raw, region);

    if (!kqxs_data || typeof kqxs_data.kq !== "object") {
      console.log(`[Get_DataXS] ${cfg.label}: chưa có kq (đang chờ xổ)`);
      return { ok: false, reason: "no_kq" };
    }

    const res = await fetch(pushUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({ kqxs_data, region }),
      timeout: 15000,
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.message || result.error || `HTTP ${res.status}`);
    }

    console.log(`[Get_DataXS] ${cfg.label}: OK`, result);
    return { ok: true, ...result };
  } catch (err) {
    console.warn(`[Get_DataXS] ${cfg.label} lỗi:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Poll liên tục trong khung giờ xổ (mỗi 2 phút)
 */
function startPolling(region) {
  const cfg = REGION_CONFIG[region];
  // const pollMs = 2 * 60 * 1000;
  // const pollMs = 5 * 1000;
  const maxDuration = cfg.pollMinutes * 60 * 1000;

  const pollMs = POLL_INTERVAL_MS;
  console.log(`[Get_DataXS] Bắt đầu poll ${cfg.label} mỗi ${pollMs / 1000}s (tối đa ${cfg.pollMinutes} phút)`);
  const start = Date.now();
  const tick = async () => {
    if (Date.now() - start > maxDuration) {
      clearInterval(interval);
      console.log(`[Get_DataXS] ${cfg.label}: hết khung poll`);
      return;
    }

    const r = await fetchAndPush(region);
    if (r.ok && r.imported > 0) {
      // Đã có data -> có thể dừng sớm hoặc tiếp tục (để cập nhật live)
      // Giữ poll để cập nhật các giải còn lại
    }
  };

  tick();
  const interval = setInterval(tick, pollMs);
}

/**
 * Chạy 1 lần cho 1 region (dùng khi gọi thủ công: node Get_DataXS_tructiep.js mn)
 */
async function runOnce(region) {
  const r = (region || "").toLowerCase();
  if (r !== "mn" && r !== "mt" && r !== "mb") {
    console.error("Usage: node Get_DataXS_tructiep.js [mn|mt|mb]");
    console.error("  Không có arg: chạy cron 16:15/17:15/18:15");
    process.exit(1);
  }
  const result = await fetchAndPush(r);
  process.exit(result.ok ? 0 : 1);
}

// ====================== MAIN ======================
const args = process.argv.slice(2);
const manualRegion = args[0];

if (manualRegion) {
  runOnce(manualRegion);
} else {
  console.log("[Get_DataXS] Khởi động cron MN 16:15, MT 17:15, MB 18:15 (VN)");
  console.log("[Get_DataXS] RAILWAY_URL =", RAILWAY_URL);

  Object.entries(REGION_CONFIG).forEach(([region, cfg]) => {
    cron.schedule(cfg.cronAt, () => {
      console.log(`[Get_DataXS] Cron: ${cfg.label}`, new Date().toISOString());
      startPolling(region);
    }, { timezone: "Asia/Ho_Chi_Minh" });
  });

  console.log("[Get_DataXS] Đã lên lịch. Chờ giờ xổ...");
}
