import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });
}

export async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("⚠ DATABASE_URL not set – DB features disabled");
    return null;
  }
  try {
    const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(schema);

    const provinces = fs.readFileSync(path.join(__dirname, "provinces-seed.sql"), "utf8");
    await pool.query(provinces);

    console.log("✅ DB initialized");
    return pool;
  } catch (err) {
    console.error("❌ DB init error:", err.message);
    return null;
  }
}

export async function importLotteryResults(payload) {
  const client = await pool.connect();
  try {
    const { draws } = payload;
    let imported = 0;
    let skipped = 0;

    for (const d of draws) {
      const { draw_date, province_code, region_code, results } = d;
      if (!draw_date || !province_code || !region_code || !results?.length) continue;

      const regionRes = await client.query(
        "SELECT id FROM regions WHERE code = $1",
        [region_code]
      );
      const regionId = regionRes.rows[0]?.id;
      if (!regionId) {
        skipped++;
        continue;
      }

      const provRes = await client.query(
        "SELECT id FROM lottery_provinces WHERE code = $1 AND region_id = $2",
        [province_code, regionId]
      );
      const provinceId = provRes.rows[0]?.id;
      if (!provinceId) {
        skipped++;
        continue;
      }

      const { rows: insertDraw } = await client.query(
        `INSERT INTO lottery_draws (draw_date, province_id, region_id)
         VALUES ($1::date, $2, $3)
         ON CONFLICT (draw_date, province_id) DO UPDATE SET draw_date = EXCLUDED.draw_date
         RETURNING id`,
        [draw_date, provinceId, regionId]
      );
      const drawId = insertDraw[0]?.id;
      if (!drawId) continue;

      for (const r of results) {
        const { prize_code, prize_order = 1, result_number } = r;
        if (!prize_code || result_number == null) continue;
        await client.query(
          `INSERT INTO lottery_results (draw_id, prize_code, prize_order, result_number)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (draw_id, prize_code, prize_order) DO UPDATE SET result_number = EXCLUDED.result_number`,
          [drawId, prize_code, prize_order, String(result_number)]
        );
      }
      imported++;
    }

    return { imported, skipped };
  } finally {
    client.release();
  }
}

export async function getDrawsByDate(drawDate, regionCode = null) {
  let query = `
    SELECT d.id, d.draw_date, p.code as province_code, p.name as province_name,
           r.code as region_code, d.created_at
    FROM lottery_draws d
    JOIN lottery_provinces p ON d.province_id = p.id
    JOIN regions r ON d.region_id = r.id
    WHERE d.draw_date = $1::date
  `;
  const params = [drawDate];
  if (regionCode) {
    query += " AND r.code = $2";
    params.push(regionCode);
  }
  query += " ORDER BY r.id, p.name";

  const { rows } = await pool.query(query, params);
  return rows;
}

export async function getResultsByDrawId(drawId) {
  const { rows } = await pool.query(
    `SELECT prize_code, prize_order, result_number
     FROM lottery_results WHERE draw_id = $1
     ORDER BY prize_code, prize_order`,
    [drawId]
  );
  return rows;
}

export async function getDrawWithResults(drawDate, provinceCode, regionCode) {
  const { rows } = await pool.query(
    `SELECT d.id FROM lottery_draws d
     JOIN lottery_provinces p ON d.province_id = p.id
     JOIN regions r ON d.region_id = r.id
     WHERE d.draw_date = $1::date AND p.code = $2 AND r.code = $3`,
    [drawDate, provinceCode, regionCode]
  );
  if (!rows.length) return null;
  const results = await getResultsByDrawId(rows[0].id);
  return { draw_id: rows[0].id, results };
}

/** Giờ mở thưởng theo miền (HH:MM) */
const REGION_OPEN_TIME = { MB: "18:15:00", MT: "17:15:00", MN: "16:15:00" };
/** sort theo miền (giống frontend) */
const REGION_SORT = { MB: 10, MT: 20, MN: 30 };

/**
 * Lấy dữ liệu cho API /api/front/open/lottery/history/list/game
 * @returns {Promise<{ name, code, sort, navCate, openTimeByRegion, draws: [{ draw_date, draw_id, results }] } | null>}
 */
export async function getLotteryHistoryListGame(gameCode, limitNum) {
  if (!pool) return null;
  const limit = Math.min(parseInt(limitNum, 10) || 200, 500);
  const { rows: metaRows } = await pool.query(
    `SELECT p.name, p.api_game_code, p.id as province_id, r.code as region_code
     FROM lottery_provinces p
     JOIN regions r ON p.region_id = r.id
     WHERE p.api_game_code = $1
     LIMIT 1`,
    [gameCode]
  );
  if (!metaRows.length) return null;

  const meta = metaRows[0];
  const { rows: drawRows } = await pool.query(
    `SELECT d.id as draw_id, d.draw_date
     FROM lottery_draws d
     JOIN lottery_provinces p ON d.province_id = p.id
     WHERE p.api_game_code = $1
     ORDER BY d.draw_date DESC
     LIMIT $2`,
    [gameCode, limit]
  );
  if (!drawRows.length) {
    return {
      name: meta.name,
      code: meta.api_game_code,
      sort: REGION_SORT[meta.region_code] || 0,
      navCate: meta.region_code.toLowerCase(),
      openTimeByRegion: REGION_OPEN_TIME[meta.region_code] || "17:15:00",
      draws: [],
    };
  }

  const drawIds = drawRows.map((r) => r.draw_id);
  const { rows: resultRows } = await pool.query(
    `SELECT draw_id, prize_code, prize_order, result_number
     FROM lottery_results
     WHERE draw_id = ANY($1::int[])
     ORDER BY draw_id, prize_code, prize_order`,
    [drawIds]
  );
  const byDrawId = {};
  for (const r of resultRows) {
    if (!byDrawId[r.draw_id]) byDrawId[r.draw_id] = [];
    byDrawId[r.draw_id].push(r);
  }

  const draws = drawRows.map((row) => ({
    draw_date: row.draw_date,
    draw_id: row.draw_id,
    results: byDrawId[row.draw_id] || [],
  }));

  return {
    name: meta.name,
    code: meta.api_game_code,
    sort: REGION_SORT[meta.region_code] || 0,
    navCate: meta.region_code.toLowerCase(),
    openTimeByRegion: REGION_OPEN_TIME[meta.region_code] || "17:15:00",
    draws,
  };
}

export { pool };

export { scheduleLotterySync } from "./lotterySync.js";
