/**
 * Tự động lấy kết quả xổ số theo giờ quay từng miền:
 * - Miền Nam: 16:13 bắt đầu poll (giờ quay 16:15-16:35)
 * - Miền Trung: 17:13 bắt đầu poll (17:15-17:35)
 * - Miền Bắc: 18:13 bắt đầu poll (18:15-18:35)
 * Poll mỗi 5s; ưu tiên API Minh Ngọc, không có thì fallback xoso188 (header chuẩn).
 * Lấy đủ kết quả → lưu DB → ngưng poll.
 */

import fetch from "node-fetch";
import cron from "node-cron";

const MINH_NGOC_BASE = "https://dc.minhngoc.net/O0O/0/xstt";
const XOSO188_API =
  "https://xoso188.net/api/front/open/lottery/history/list/game";

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

// ---------- Minh Ngọc ----------
// API trả về dạng: kqxs.mn={run:0,tinh:"1,19,21,20",ntime:...,delay:5000};
// Thường chỉ có metadata, không có số giải → trả null để fallback xoso188
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
    // Nếu có run=1 và dữ liệu số (sau này có thể mở rộng parse) thì trả draws
    // Hiện response mẫu chỉ có run,tinh,ntime,delay → không đủ để build draws
    if (data.run === 1 && data.result) {
      // TODO: parse data.result theo format Minh Ngọc nếu có
      return null;
    }
    return null;
  } catch (err) {
    console.warn("[Minh Ngọc]", region, err.message);
    return null;
  }
}

// ---------- xoso188 fallback ----------
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

const POLL_MS = 5000;
const MAX_POLL_UNTIL_MS = 25 * 60 * 1000; // tối đa ~25 phút (qua khung giờ quay)

let pollIntervals = { mn: null, mt: null, mb: null };

/**
 * Poll mỗi 5s: thử Minh Ngọc rồi xoso188. Khi có draws (ngày hôm nay) → import → dừng.
 * @param {string} region - 'mn' | 'mt' | 'mb'
 * @param {object} pool - pg.Pool
 * @param {Function} importLotteryResults - (payload) => Promise<{ imported, skipped }>
 */
async function pollUntilResult(region, pool, importLotteryResults) {
  if (pollIntervals[region]) return;
  const today = getTodayDrawDate();
  const regionLabel = { mn: "Miền Nam", mt: "Miền Trung", mb: "Miền Bắc" }[region];
  console.log(`[LotterySync] Bắt đầu poll ${regionLabel} (${today}), mỗi ${POLL_MS / 1000}s`);

  const start = Date.now();
  const tick = async () => {
    if (Date.now() - start > MAX_POLL_UNTIL_MS) {
      clearInterval(pollIntervals[region]);
      pollIntervals[region] = null;
      console.warn(`[LotterySync] Hết thời gian poll ${regionLabel}`);
      return;
    }

    let draws = await fetchMinhNgoc(region);
    if (!draws || draws.length === 0) {
      draws = await fetchXoso188ForRegion(region, today);
    }

    if (draws.length > 0) {
      const forToday = draws.filter((d) => d.draw_date === today);
      if (forToday.length > 0) {
        clearInterval(pollIntervals[region]);
        pollIntervals[region] = null;
        try {
          const result = await importLotteryResults({ draws: forToday });
          console.log(`[LotterySync] ${regionLabel} đã lưu:`, result);
        } catch (err) {
          console.error("[LotterySync] Import lỗi:", err.message);
        }
      }
    }
  };

  await tick();
  pollIntervals[region] = setInterval(tick, POLL_MS);
}

/**
 * Đăng ký cron: 16:13 MN, 17:13 MT, 18:13 MB (giờ VN, TZ đã set Asia/Ho_Chi_Minh).
 * @param {object} pool - pg.Pool
 * @param {Function} importLotteryResults - (payload) => Promise<{ imported, skipped }>
 */
export function scheduleLotterySync(pool, importLotteryResults) {
  if (!pool || !importLotteryResults) {
    console.warn("[LotterySync] Bỏ qua cron: thiếu pool hoặc importLotteryResults");
    return;
  }
  // 13 phút, giờ 16 / 17 / 18, mỗi ngày
  cron.schedule("13 16 * * *", () => pollUntilResult("mn", pool, importLotteryResults), { timezone: "Asia/Ho_Chi_Minh" });
  cron.schedule("13 17 * * *", () => pollUntilResult("mt", pool, importLotteryResults), { timezone: "Asia/Ho_Chi_Minh" });
  cron.schedule("13 18 * * *", () => pollUntilResult("mb", pool, importLotteryResults), { timezone: "Asia/Ho_Chi_Minh" });
  console.log("[LotterySync] Đã lên lịch: 16:13 MN, 17:13 MT, 18:13 MB (mỗi 5s đến khi có kết quả)");
}
