import fs from "fs";
import path from "path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const CSV_PATH = process.env.SEED_CSV || "data/seed_list.csv";
const DELAY_MS = Number(process.env.DELAY_MS || 1500);
const MAX_RETRY = Number(process.env.MAX_RETRY || 2);
const OUTPUT_CSV =
  process.env.OUTPUT_CSV ||
  `outputs/batch_result_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const parseCsvLine = (line) => {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
};

const csvText = fs.readFileSync(path.resolve(CSV_PATH), "utf8");
const lines = csvText
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

if (lines.length <= 1) {
  console.error("CSV is empty or missing header.");
  process.exit(1);
}

const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
const findHeader = (...names) =>
  names
    .map((name) => headers.indexOf(name.toLowerCase()))
    .find((idx) => idx >= 0) ?? -1;

const brandIdx = findHeader("brand");
const productKoIdx = findHeader("product name (korean)", "product_name", "product name");
const productEnIdx = findHeader("product name (english)", "product_name_en");

if (brandIdx < 0 || productKoIdx < 0) {
  console.error(
    "CSV header must include Brand and Product name (Korean) (or product_name).",
  );
  process.exit(1);
}

const rows = lines.slice(1).map((line) => {
  const cols = parseCsvLine(line);
  return {
    brand: (cols[brandIdx] || "").trim(),
    product_name: (cols[productKoIdx] || "").trim(),
    product_name_en: productEnIdx >= 0 ? (cols[productEnIdx] || "").trim() : "",
  };
});

const total = rows.length;
console.log(
  `[batch] total=${total}, base=${BASE_URL}, delay=${DELAY_MS}ms, output=${OUTPUT_CSV}`,
);

const outputRows = [
  [
    "seed_index",
    "brand",
    "input_product_name_en",
    "input_product_name",
    "item_rank",
    "item_product_name",
    "item_list_price",
    "item_sale_price",
    "item_url",
    "item_image_src",
    "item_keyword_used",
    "status",
    "attempts",
    "id",
    "search_form_confirmed_url",
    "error",
    "started_at",
    "ended_at",
  ],
];

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const startedAt = new Date().toISOString();
  let endedAt = "";
  let id = "";
  let searchFormConfirmedUrl = "";
  let searchFormProductList = [];
  let error = "";
  if (!row.brand || !row.product_name) {
    console.log(`[skip] ${i + 1}/${total} invalid row`, row);
    endedAt = new Date().toISOString();
    outputRows.push([
      String(i + 1),
      row.brand,
      row.product_name_en,
      row.product_name,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "skipped",
      "0",
      "",
      "",
      "invalid row",
      startedAt,
      endedAt,
    ]);
    continue;
  }

  let attempt = 0;
  let ok = false;
  while (attempt <= MAX_RETRY && !ok) {
    attempt += 1;
    try {
      console.log(
        `[start] ${i + 1}/${total} (${attempt}/${MAX_RETRY + 1}) ${row.brand} / ${row.product_name}`,
      );
      const res = await fetch(`${BASE_URL}/api/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      id = data?.id || "";
      if (id) {
        try {
          const productRes = await fetch(
            `${BASE_URL}/api/products?id=${encodeURIComponent(id)}`,
          );
          const productData = await productRes.json();
          const product = productData?.data || productData?.product || null;
          if (productRes.ok && product) {
            searchFormConfirmedUrl =
              product.search_form_confirmed_url || "";
            const productList = product.search_form_product_list;
            searchFormProductList = Array.isArray(productList) ? productList : [];
          }
        } catch {
          // Keep batch resilient even when product lookup fails.
        }
      }
      console.log(`[ok] ${i + 1}/${total} id=${id || "unknown"}`);
      ok = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error = msg;
      console.log(`[fail] ${i + 1}/${total} ${msg}`);
      if (attempt <= MAX_RETRY) {
        await sleep(1000);
      }
    }
  }
  endedAt = new Date().toISOString();
  if (ok && searchFormProductList.length > 0) {
    searchFormProductList.forEach((item, idx) => {
      outputRows.push([
        String(i + 1),
        row.brand,
        row.product_name_en,
        row.product_name,
        String(idx + 1),
        item?.productName || "",
        item?.listPrice || "",
        item?.salePrice || "",
        item?.url || "",
        item?.imageSrc || "",
        item?.keywordUsed || "",
        "ok",
        String(attempt),
        id,
        searchFormConfirmedUrl,
        "",
        startedAt,
        endedAt,
      ]);
    });
  } else {
    outputRows.push([
      String(i + 1),
      row.brand,
      row.product_name_en,
      row.product_name,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      ok ? "ok" : "failed",
      String(attempt),
      id,
      searchFormConfirmedUrl,
      ok ? "" : error,
      startedAt,
      endedAt,
    ]);
  }

  await sleep(DELAY_MS);
}

const outputPath = path.resolve(OUTPUT_CSV);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const csvOut = outputRows.map((r) => r.map(escapeCsv).join(",")).join("\n") + "\n";
fs.writeFileSync(outputPath, csvOut, "utf8");
console.log(`[batch] csv_saved=${outputPath}`);
console.log("[batch] done");
