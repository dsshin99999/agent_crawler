import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function csvEscape(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

function toCell(v) {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const root = process.cwd();
loadEnvFile(path.join(root, ".env.local"));
loadEnvFile(path.join(path.dirname(root), ".env.local"));

const supabaseUrl = process.env.SUPABASE_URL;
const resolvedSupabaseUrl = supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!resolvedSupabaseUrl || !serviceRoleKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY");
  process.exit(1);
}

const TABLE = process.env.TABLE || "site_metadata_discovery";
const OUTPUT_CSV =
  process.env.OUTPUT_CSV ||
  `outputs/${TABLE}_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const ORDER_COLUMN = process.env.ORDER_COLUMN || "created_at";
const ORDER_ASC = String(process.env.ORDER_ASC || "false").toLowerCase() === "true";

const supabase = createClient(resolvedSupabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let from = 0;
let allRows = [];

if (LIMIT > 0) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order(ORDER_COLUMN, { ascending: ORDER_ASC })
    .limit(LIMIT);
  if (error) {
    console.error(`Query failed: ${error.message}`);
    process.exit(1);
  }
  allRows = data || [];
} else {
  while (true) {
    const to = from + BATCH_SIZE - 1;
    const { data, error } = await supabase.from(TABLE).select("*").range(from, to);
    if (error) {
      console.error(`Query failed: ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }
}

if (allRows.length === 0) {
  console.log(`No rows in table: ${TABLE}`);
  process.exit(0);
}

const cols = Array.from(
  allRows.reduce((set, row) => {
    Object.keys(row || {}).forEach((k) => set.add(k));
    return set;
  }, new Set()),
);

const outPath = path.resolve(root, OUTPUT_CSV);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const lines = [];
lines.push(cols.map(csvEscape).join(","));
for (const row of allRows) {
  const vals = cols.map((c) => csvEscape(toCell(row?.[c])));
  lines.push(vals.join(","));
}

fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Exported ${allRows.length} rows from ${TABLE}`);
console.log(`Saved CSV: ${outPath}`);
