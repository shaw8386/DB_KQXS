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

export { pool };

export { scheduleLotterySync } from "./lotterySync.js";
