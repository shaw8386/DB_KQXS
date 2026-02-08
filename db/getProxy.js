/**
 * Tự lấy proxy free (từ API proxyscrape) để dùng khi gọi xoso188 từ Railway (tránh bị chặn).
 * - Lưu proxy hiện tại trong memory (currentProxyUrl).
 * - Refresh định kỳ mỗi 8 tiếng; khi gọi xoso188 fail → lấy proxy mới ngay.
 * - Ưu tiên env XOSO188_PROXY / HTTP_PROXY nếu có.
 */

import fetch from "node-fetch";

const PROXY_LIST_URL =
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all";
const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 tiếng

let currentProxyUrl = null;
let refreshTimer = null;

/**
 * Lấy danh sách proxy từ API (plain text, mỗi dòng IP:port).
 * @returns {Promise<string[]>} ['http://ip:port', ...]
 */
export async function fetchProxyList(showMsg = true) {
  try {
    const res = await fetch(PROXY_LIST_URL, { timeout: 15000 });
    const text = await res.text();
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s));
    const urls = lines.slice(0, 100).map((ipPort) => `http://${ipPort}`);
    if (showMsg) console.log("[getProxy] Lấy được", urls.length, "proxy từ API");
    return urls;
  } catch (err) {
    if (showMsg) console.warn("[getProxy] Lỗi lấy danh sách:", err.message);
    return [];
  }
}

/**
 * Chọn 1 proxy từ list (random hoặc đầu list), cập nhật currentProxyUrl.
 * @param {boolean} showMsg
 * @returns {Promise<string|null>} URL proxy hoặc null
 */
export async function refreshProxy(showMsg = true) {
  const list = await fetchProxyList(false);
  if (list.length === 0) {
    currentProxyUrl = null;
    return null;
  }
  const url = list[Math.floor(Math.random() * list.length)];
  currentProxyUrl = url;
  if (showMsg) console.log("[getProxy] Đã đổi proxy:", url);
  return url;
}

/**
 * Proxy đang dùng (từ memory). Env XOSO188_PROXY/HTTP_PROXY được đọc ở nơi gọi.
 */
export function getCurrentProxy() {
  return currentProxyUrl;
}

/**
 * Gọi khi request xoso188 fail → lấy proxy mới (await để có thể retry ngay).
 */
export async function onProxyFailed() {
  currentProxyUrl = null;
  await refreshProxy(true);
}

/**
 * Khởi tạo: lấy proxy ngay + đặt lịch refresh mỗi 8 tiếng.
 * Gọi 1 lần khi server start (từ scheduleLotterySync).
 */
export function initProxyRefresh(intervalMs = REFRESH_INTERVAL_MS) {
  if (process.env.XOSO188_PROXY || process.env.HTTP_PROXY) {
    console.log("[getProxy] Dùng proxy từ env (XOSO188_PROXY/HTTP_PROXY), bỏ qua free proxy list");
    return;
  }
  refreshProxy(true).then(() => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshProxy(true), intervalMs);
    console.log("[getProxy] Đã lên lịch refresh proxy mỗi", intervalMs / 3600000, "giờ");
  });
}
