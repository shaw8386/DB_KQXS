/**
 * LOTTERY SYNC – Automation của server (không liên quan web gi8 / client).
 * Mục đích: Tự động lấy kết quả xổ số cuối ngày → lưu vào DB server → cho user/client dùng sau.
 *
 * 1) Lịch từng miền: từ giờ bắt đầu → đến hết giờ xổ của miền đó, gọi liên tục mỗi 5s
 *    cho đến khi lấy được kết quả → lưu DB → ngưng poll.
 * 2) Nguồn API (chỉ server cron gọi):
 *    - Ưu tiên: MINH_NGOC_BASE (Minh Ngọc) – lấy kết quả trực tiếp ngày hôm đó.
 *    - Fallback: nếu Minh Ngọc không lấy được thì gọi XOSO188_API (header chuẩn) → lưu DB.
 */

import fetch from "node-fetch";
import cron from "node-cron";

// ---------- API server tự cron gọi (không dùng cho web gi8 / client) ----------
const MINH_NGOC_BASE = "https://dc.minhngoc.net/O0O/0/xstt";
const XOSO188_API =
  "https://xoso188.net/api/front/open/lottery/history/list/game";

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

// Header giống tools/fetch_lottery_and_upload.py (để xoso188 không chặn)
const XOSO188_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
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

// ---------- API phụ: xoso188 (XOSO188_API) – chỉ dùng khi Minh Ngọc không lấy được ----------
async function fetchXoso188Game(gameCode, limitNum = 10) {
  const url = `${XOSO188_API}?limitNum=${limitNum}&gameCode=${gameCode}`;
  try {
    const res = await fetch(url, {
      headers: { ...XOSO188_HEADERS, Accept: "application/json" },
      timeout: 20000,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data?.t?.issueList ?? [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn("[xoso188]", gameCode, err.message);
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
  console.log("[LotterySync] Đã lên lịch (automation server): MN 16:13, MT 17:13, MB 18:13 VN — API ưu tiên Minh Ngọc, fallback xoso188 → lưu DB.");
}
