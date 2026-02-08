/**
 * LOTTERY SYNC – Automation của server (không liên quan web gi8 / client).
 * Mục đích: Tự động lấy kết quả xổ số cuối ngày → lưu vào DB server → cho user/client dùng sau.
 *
 * 1) Lịch từng miền: từ giờ bắt đầu → đến hết giờ xổ của miền đó, gọi liên tục mỗi 5s
 *    cho đến khi lấy được kết quả → lưu DB → ngưng poll.
 * 2) Nguồn API (chỉ server cron gọi):
 *    - Ưu tiên: MINH_NGOC_BASE (Minh Ngọc) – lấy kết quả trực tiếp ngày hôm đó.
 *    - Fallback: nếu Minh Ngọc không lấy được thì gọi xoso188 qua Cloudflare Worker → lưu DB.
 * 3) 20h cuối ngày (giờ VN): kiểm tra lottery_draws đã có data ngày hôm nay chưa.
 *    Nếu chưa → gọi xoso188 lấy toàn bộ 3 miền cho ngày đó → lưu DB. Nếu có rồi → bỏ qua.
 */

import fetch from "node-fetch";
import cron from "node-cron";

// ---------- API server tự cron gọi (không dùng cho web gi8 / client) ----------
const MINH_NGOC_BASE = "https://dc.minhngoc.net/O0O/0/xstt";
const XOSO188_API =
  "https://xoso188.net/api/front/open/lottery/history/list/game";
// Cloudflare Worker proxy: gọi Worker thay vì xoso188 trực tiếp (tránh bị chặn trên Railway). Có thể override bằng env XOSO188_WORKER_URL.
const XOSO188_WORKER_URL =
  process.env.XOSO188_WORKER_URL || "https://xoso188-proxy.xoso188-proxy.workers.dev";
const getXoso188BaseUrl = () => (XOSO188_WORKER_URL || XOSO188_API).replace(/\/$/, "");

// ---------- Lịch cụ thể từng miền: giờ bắt đầu poll → kết thúc giờ xổ ----------
// Bắt đầu poll trước 2 phút so với giờ quay; poll đến khi có kết quả hoặc hết khung.
const REGION_SCHEDULE = {
  mn: {
    label: "Miền Nam",
    cronAt: "13 16 * * *",       // 16:13 mỗi ngày
    drawStart: "16:15",
    drawEnd: "16:35",
    pollIntervalMs: 5000,
    maxPollDurationMs: 25 * 60 * 1000, // tối đa ~25 phút (qua giờ xổ)
  },
  mt: {
    label: "Miền Trung",
    cronAt: "13 17 * * *",      // 17:13
    drawStart: "17:15",
    drawEnd: "17:35",
    pollIntervalMs: 5000,
    maxPollDurationMs: 25 * 60 * 1000,
  },
  mb: {
    label: "Miền Bắc",
    cronAt: "13 18 * * *",      // 18:13
    drawStart: "18:15",
    drawEnd: "18:35",
    pollIntervalMs: 5000,
    maxPollDurationMs: 25 * 60 * 1000,
  },
};

// Header khớp tools/fetch_lottery_and_upload.py BROWSER_HEADERS (từ DevTools xoso188 - Edge)
const XOSO188_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Cache-Control": "max-age=0",
  "Sec-Ch-Ua":
    '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  Priority: "u=0, i",
};

const PRIZE_CODES = ["DB", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"];

// gameCode -> [region_code, province_code | null (MB tính theo ngày)]
const GAME_TO_REGION_PROVINCE = {
  miba: ["MB", null],
  dana: ["MT", "DN"],
  bidi: ["MT", "BDI"],
  dalak: ["MT", "DLK"],
  dano: ["MT", "DNO"],
  gila: ["MT", "GLA"],
  khho: ["MT", "KHO"],
  kotu: ["MT", "KTU"],
  nith: ["MT", "NTH"],
  phye: ["MT", "PYE"],
  qubi: ["MT", "QBI"],
  quna: ["MT", "QNM"],
  qung: ["MT", "QNG"],
  qutr: ["MT", "QTR"],
  thth: ["MT", "THH"],
  angi: ["MN", "AGI"],
  bali: ["MN", "BLI"],
  bidu: ["MN", "BDU"],
  biph: ["MN", "BPH"],
  cama: ["MN", "CMA"],
  cath: ["MN", "CTH"],
  dalat: ["MN", "DLT"],
  dona: ["MN", "DNA"],
  doth: ["MN", "DTH"],
  hagi: ["MN", "HGI"],
  kigi: ["MN", "KGI"],
  loan: ["MN", "LAN"],
  sotr: ["MN", "STR"],
  tani: ["MN", "TNI"],
  tigi: ["MN", "TGI"],
  tphc: ["MN", "HCM"],
  trvi: ["MN", "TVI"],
  vilo: ["MN", "VLO"],
  vuta: ["MN", "VTA"],
};

const REGION_GAME_CODES = {
  mn: ["angi", "bali", "bidu", "biph", "cama", "cath", "dalat", "dona", "doth", "hagi", "kigi", "loan", "sotr", "tani", "tigi", "tphc", "trvi", "vilo", "vuta"],
  mt: ["dana", "bidi", "dalak", "dano", "gila", "khho", "kotu", "nith", "phye", "qubi", "quna", "qung", "qutr", "thth"],
  mb: ["miba"],
};

const MB_NAME_TO_CODE = {
  "Thái Bình": "TB",
  "Hà Nội": "HN",
  "Quảng Ninh": "QN",
  "Bắc Ninh": "BN",
  "Hải Phòng": "HP",
  "Nam Định": "ND",
};

function getStationNameMB(dateStr) {
  // dateStr: DD/MM/YYYY; JS getDay() 0=Chủ nhật
  try {
    const parts = String(dateStr).replace(/-/g, "/").split("/").map(Number);
    const [d, m, y] = parts;
    const dt = new Date(y, (m || 1) - 1, d || 1);
    const map = {
      0: "Thái Bình",
      1: "Hà Nội",
      2: "Quảng Ninh",
      3: "Bắc Ninh",
      4: "Hà Nội",
      5: "Hải Phòng",
      6: "Nam Định",
    };
    return map[dt.getDay()] ?? "Hà Nội";
  } catch {
    return "Hà Nội";
  }
}

function getTodayDrawDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Trả về ngày (YYYY-MM-DD) lùi `daysBack` ngày so với hôm nay (theo giờ VN nếu TZ đã set). */
function getDrawDateOffset(daysBack) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDetail(detailStr) {
  const results = [];
  let groups = [];
  try {
    groups = JSON.parse(detailStr || "[]");
  } catch {
    return results;
  }
  if (!Array.isArray(groups)) return results;
  for (let i = 0; i < PRIZE_CODES.length; i++) {
    if (i >= groups.length) break;
    const val = groups[i];
    if (val == null || val === "") continue;
    const parts = String(val).split(",");
    parts.forEach((num, idx) => {
      const n = num.trim();
      if (n)
        results.push({
          prize_code: PRIZE_CODES[i],
          prize_order: idx + 1,
          result_number: n,
        });
    });
  }
  return results;
}

function issuesToDraws(gameCode, issues, filterDrawDate) {
  const meta = GAME_TO_REGION_PROVINCE[gameCode];
  if (!meta) return [];
  const [regionCode, fixedProvince] = meta;
  const draws = [];
  for (const issue of issues) {
    const turnNum = issue.turnNum || "";
    if (!turnNum) continue;
    let d, m, y;
    try {
      const parts = String(turnNum).replace(/-/g, "/").split("/").map(Number);
      if (parts.length >= 3) {
        [d, m, y] = parts;
      } else continue;
    } catch {
      continue;
    }
    const drawDate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (filterDrawDate && drawDate !== filterDrawDate) continue;

    const provinceCode = fixedProvince
      ? fixedProvince
      : MB_NAME_TO_CODE[getStationNameMB(turnNum)] || "HN";
    const results = parseDetail(issue.detail || "");
    if (!results.length) continue;
    draws.push({
      draw_date: drawDate,
      province_code: provinceCode,
      region_code: regionCode,
      results,
    });
  }
  return draws;
}

// ---------- API chính: Minh Ngọc (MINH_NGOC_BASE) – kết quả trực tiếp ngày hôm đó ----------
// Server cron gọi trước; nếu không có kết quả thì mới dùng xoso188.
// Response mẫu: kqxs.mn={run:0,tinh:"1,19,21,20",ntime:...,delay:5000} — hiện chỉ metadata, chưa có số giải → trả null → fallback xoso188.
async function fetchMinhNgoc(region) {
  const urls = {
    mn: `${MINH_NGOC_BASE}/js_m1.js`,
    mt: `${MINH_NGOC_BASE}/js_m3.js`,
    mb: `${MINH_NGOC_BASE}/js_m2.js`,
  };
  const url = `${urls[region]}?_=${Date.now()}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "*/*", "User-Agent": "Mozilla/5.0 (compatible; LotterySync/1.0)" },
      timeout: 15000,
    });
    const text = await res.text();
    const match = text.match(/kqxs\.(mn|mb|mt)\s*=\s*(\{[^}]+\})/);
    if (!match) return null;
    const objStr = match[2].replace(/(\w+):/g, '"$1":');
    let data;
    try {
      data = JSON.parse(objStr);
    } catch {
      return null;
    }
    if (data.run === 1 && data.result) {
      // TODO: khi Minh Ngọc trả về số giải (data.result), parse thành draws ở đây
      return null;
    }
    return null;
  } catch (err) {
    console.warn("[Minh Ngọc]", region, err.message);
    return null;
  }
}

// ---------- API phụ: xoso188 – gọi qua Cloudflare Worker (chỉ dùng khi Minh Ngọc không lấy được) ----------
const MAX_XOSO188_RETRIES = 5;

async function fetchXoso188Game(gameCode, limitNum = 10, retryCount = 0) {
  const baseUrl = getXoso188BaseUrl();
  const url = `${baseUrl}?limitNum=${limitNum}&gameCode=${gameCode}`;
  const options = {
    headers: { Accept: "application/json" },
    timeout: 20000,
  };
  try {
    const res = await fetch(url, options);
    const raw = await res.text();
    if (!res.ok) {
      console.warn("[xoso188]", gameCode, "status", res.status, "retry", retryCount + 1 + "/" + MAX_XOSO188_RETRIES);
      if (retryCount < MAX_XOSO188_RETRIES - 1) {
        return fetchXoso188Game(gameCode, limitNum, retryCount + 1);
      }
      return [];
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      console.warn("[xoso188]", gameCode, "response không phải JSON, retry", retryCount + 1 + "/" + MAX_XOSO188_RETRIES);
      if (retryCount < MAX_XOSO188_RETRIES - 1) {
        return fetchXoso188Game(gameCode, limitNum, retryCount + 1);
      }
      return [];
    }
    const list = data?.t?.issueList ?? [];
    const arr = Array.isArray(list) ? list : [];
    if (arr.length === 0 && (data?.code !== 0 || !data?.success)) {
      console.warn("[xoso188]", gameCode, "issueList rỗng, retry", retryCount + 1 + "/" + MAX_XOSO188_RETRIES);
      if (retryCount < MAX_XOSO188_RETRIES - 1) {
        return fetchXoso188Game(gameCode, limitNum, retryCount + 1);
      }
    }
    return arr;
  } catch (err) {
    console.warn("[xoso188]", gameCode, err.message, "retry", retryCount + 1 + "/" + MAX_XOSO188_RETRIES);
    if (retryCount < MAX_XOSO188_RETRIES - 1) {
      return fetchXoso188Game(gameCode, limitNum, retryCount + 1);
    }
    return [];
  }
}

/** Test từ server có gọi được xoso188 không. Trả về { ok, status, message, count }. */
export async function pingXoso188() {
  try {
    const issues = await fetchXoso188Game("miba", 2);
    return {
      ok: true,
      status: 200,
      message: "OK",
      count: issues.length,
      source: "xoso188",
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err?.message || String(err),
      count: 0,
      source: "xoso188",
    };
  }
}

export { XOSO188_HEADERS };

async function fetchXoso188ForRegion(region, filterDrawDate) {
  const gameCodes = REGION_GAME_CODES[region];
  if (!gameCodes) return [];
  const allDraws = [];
  for (const gameCode of gameCodes) {
    const issues = await fetchXoso188Game(gameCode, 15);
    const draws = issuesToDraws(gameCode, issues, filterDrawDate);
    allDraws.push(...draws);
    await new Promise((r) => setTimeout(r, 300)); // tránh gọi dồn
  }
  return allDraws;
}

let pollIntervals = { mn: null, mt: null, mb: null };

/**
 * 20h cuối ngày (và khi startup): kiểm tra 5 ngày theo giờ VN.
 * - Trước 16:00 VN (chưa xổ ngày hôm nay) → bỏ qua hôm nay, check 5 ngày trước: D-1 .. D-5.
 * - Từ 16:00 trở đi → check hôm nay + 4 ngày trước: D .. D-4.
 * Với mỗi ngày chưa có trong lottery_draws → gọi xoso188 lấy MN, MT, MB và lưu DB.
 * @param {object} pool - pg.Pool
 * @param {Function} importLotteryResults - (payload) => Promise<{ imported, skipped }>
 */
async function checkAndBackfillToday(pool, importLotteryResults) {
  if (!pool || !importLotteryResults) return;
  const now = new Date();
  const hourVN = now.getHours();
  const today = getTodayDrawDate();
  const includeToday = hourVN >= 16;
  const datesToCheck = includeToday
    ? [0, 1, 2, 3, 4].map((d) => getDrawDateOffset(d))
    : [1, 2, 3, 4, 5].map((d) => getDrawDateOffset(d));
  console.log(
    "[LotterySync] 20h check: giờ VN",
    hourVN + ":xx, includeToday=" + includeToday,
    "→ kiểm tra",
    datesToCheck.join(", ")
  );
  try {
    for (const drawDate of datesToCheck) {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS c FROM lottery_draws WHERE draw_date = $1::date",
        [drawDate]
      );
      const count = parseInt(rows[0]?.c ?? 0, 10);
      if (count > 0) {
        console.log("[LotterySync] 20h check:", drawDate, "đã có", count, "bản ghi → bỏ qua");
        continue;
      }
      console.log("[LotterySync] 20h backfill: bắt đầu gọi xoso188 cho MN, MT, MB (draw_date=" + drawDate + ")");
      const allDraws = [];
      for (const region of ["mn", "mt", "mb"]) {
        const draws = await fetchXoso188ForRegion(region, drawDate);
        allDraws.push(...draws);
        console.log("[LotterySync] 20h backfill:", drawDate, region.toUpperCase(), "lấy được", draws.length, "draws");
        await new Promise((r) => setTimeout(r, 300));
      }
      if (allDraws.length === 0) {
        console.warn("[LotterySync] 20h backfill: xoso188 không trả về kết quả cho", drawDate);
        continue;
      }
      console.log("[LotterySync] 20h backfill: tổng", allDraws.length, "draws cho", drawDate, ", đang import...");
      const result = await importLotteryResults({ draws: allDraws });
      console.log("[LotterySync] 20h backfill đã lưu", drawDate, ":", result);
    }
  } catch (err) {
    console.error("[LotterySync] 20h backfill lỗi:", err.message);
  }
}

/**
 * Poll liên tục từ giờ bắt đầu → đến khi có kết quả hoặc hết khung giờ xổ:
 * 1) Gọi API Minh Ngọc (MINH_NGOC_BASE) lấy kết quả trực tiếp ngày hôm đó.
 * 2) Nếu không lấy được → gọi XOSO188_API (fallback) với header chuẩn.
 * Khi có draws ngày hôm nay → import vào DB → ngưng poll.
 * @param {string} region - 'mn' | 'mt' | 'mb'
 * @param {object} pool - pg.Pool
 * @param {Function} importLotteryResults - (payload) => Promise<{ imported, skipped }>
 */
async function pollUntilResult(region, pool, importLotteryResults) {
  if (pollIntervals[region]) return;
  const schedule = REGION_SCHEDULE[region];
  if (!schedule) return;
  const today = getTodayDrawDate();
  const { label, pollIntervalMs, maxPollDurationMs } = schedule;
  console.log(`[LotterySync] ${label}: bắt đầu poll (${today}), giờ xổ ${schedule.drawStart}–${schedule.drawEnd}, mỗi ${pollIntervalMs / 1000}s`);

  const start = Date.now();
  let loggedFallback = false;

  const tick = async () => {
    if (Date.now() - start > maxPollDurationMs) {
      clearInterval(pollIntervals[region]);
      pollIntervals[region] = null;
      console.warn(`[LotterySync] ${label}: hết khung giờ xổ, ngưng poll`);
      return;
    }

    // 1) Ưu tiên Minh Ngọc – lấy kết quả trực tiếp ngày hôm đó
    let draws = await fetchMinhNgoc(region);
    // 2) Không có thì fallback xoso188
    if (!draws || draws.length === 0) {
      if (!loggedFallback) {
        console.log(`[LotterySync] ${label}: Minh Ngọc chưa có kết quả → fallback xoso188`);
        loggedFallback = true;
      }
      draws = await fetchXoso188ForRegion(region, today);
    }

    if (draws.length > 0) {
      const forToday = draws.filter((d) => d.draw_date === today);
      if (forToday.length > 0) {
        clearInterval(pollIntervals[region]);
        pollIntervals[region] = null;
        try {
          const result = await importLotteryResults({ draws: forToday });
          console.log(`[LotterySync] ${label} đã lưu DB:`, result);
        } catch (err) {
          console.error("[LotterySync] Import lỗi:", err.message);
        }
      }
    }
  };

  await tick();
  pollIntervals[region] = setInterval(tick, pollIntervalMs);
}

/**
 * Test link phụ xoso188: gọi đúng fetchXoso188ForRegion (header chuẩn).
 * @param {string} region - 'mn' | 'mt' | 'mb'
 * @returns {Promise<{ ok: boolean, drawsCount?: number, region?: string, drawDate?: string, sample?: object, error?: string }>}
 */
export async function runSyncTest(region) {
  const valid = { mn: 1, mt: 1, mb: 1 };
  if (!valid[region]) {
    return { ok: false, error: "region phải là mn | mt | mb" };
  }
  try {
    const today = getTodayDrawDate();
    const draws = await fetchXoso188ForRegion(region, null);
    const forToday = draws.filter((d) => d.draw_date === today);
    const sample = draws[0] ? { draw_date: draws[0].draw_date, province_code: draws[0].province_code, resultsCount: draws[0].results?.length } : null;
    return {
      ok: true,
      drawsCount: draws.length,
      forTodayCount: forToday.length,
      region,
      drawDate: today,
      sample,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Gọi sync cho một miền ngay (từ HTTP trigger hoặc cron ngoài).
 * Trả về ngay; poll chạy nền. Dùng khi Railway sleep hoặc cron trong process không chạy đúng giờ.
 * @param {string} region - 'mn' | 'mt' | 'mb'
 * @param {object} pool - pg.Pool
 * @param {Function} importLotteryResults - (payload) => Promise<{ imported, skipped }>
 */
export function triggerRegionSync(region, pool, importLotteryResults) {
  if (!pool || !importLotteryResults) {
    console.warn("[LotterySync] triggerRegionSync: thiếu pool hoặc importLotteryResults");
    return;
  }
  const r = (region || "").toLowerCase();
  if (r !== "mn" && r !== "mt" && r !== "mb") {
    console.warn("[LotterySync] triggerRegionSync: region phải là mn | mt | mb");
    return;
  }
  console.log("[LotterySync] Trigger thủ công:", { mn: "Miền Nam", mt: "Miền Trung", mb: "Miền Bắc" }[r], new Date().toISOString());
  pollUntilResult(r, pool, importLotteryResults);
}

/**
 * Đăng ký cron nội bộ: mỗi ngày đúng giờ bắt đầu poll từng miền (server automation, không liên quan client).
 * MN 16:13, MT 17:13, MB 18:13 (giờ VN) → gọi liên tục Minh Ngọc (rồi fallback xoso188) đến khi có kết quả → lưu DB.
 * @param {object} pool - pg.Pool
 * @param {Function} importLotteryResults - (payload) => Promise<{ imported, skipped }>
 */
export function scheduleLotterySync(pool, importLotteryResults) {
  if (!pool || !importLotteryResults) {
    console.warn("[LotterySync] Bỏ qua cron: thiếu pool hoặc importLotteryResults");
    return;
  }
  const tz = "Asia/Ho_Chi_Minh";
  cron.schedule(REGION_SCHEDULE.mn.cronAt, () => {
    console.log("[LotterySync] Cron:", REGION_SCHEDULE.mn.label, "16:13", new Date().toISOString());
    pollUntilResult("mn", pool, importLotteryResults);
  }, { timezone: tz });
  cron.schedule(REGION_SCHEDULE.mt.cronAt, () => {
    console.log("[LotterySync] Cron:", REGION_SCHEDULE.mt.label, "17:13", new Date().toISOString());
    pollUntilResult("mt", pool, importLotteryResults);
  }, { timezone: tz });
  cron.schedule(REGION_SCHEDULE.mb.cronAt, () => {
    console.log("[LotterySync] Cron:", REGION_SCHEDULE.mb.label, "18:13", new Date().toISOString());
    pollUntilResult("mb", pool, importLotteryResults);
  }, { timezone: tz });
  // 20h cuối ngày: kiểm tra đã có data ngày hôm nay chưa → chưa thì backfill từ xoso188
  cron.schedule("0 20 * * *", () => {
    console.log("[LotterySync] Cron: 20h check & backfill", new Date().toISOString());
    checkAndBackfillToday(pool, importLotteryResults);
  }, { timezone: tz });
  // Chạy ngay khi deploy/startup (kiểm tra & backfill nếu thiếu data hôm nay)
  checkAndBackfillToday(pool, importLotteryResults);
  console.log("[LotterySync] Đã lên lịch (automation server): MN 16:13, MT 17:13, MB 18:13 VN; 20h check & backfill nếu thiếu data; đã chạy check ngay khi startup.");
}
