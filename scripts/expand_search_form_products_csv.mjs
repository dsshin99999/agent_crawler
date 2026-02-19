import fs from "fs";
import path from "path";

const INPUT_CSV =
  process.env.INPUT_CSV || "outputs/site_metadata_discovery_recent_35.csv";
const OUTPUT_CSV =
  process.env.OUTPUT_CSV || "outputs/site_metadata_discovery_recent_35_expanded.csv";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function escapeCsv(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

function safeJsonArray(v) {
  if (!v) return [];
  const t = String(v).trim();
  if (!t || t === "null") return [];
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const inputPath = path.resolve(INPUT_CSV);
if (!fs.existsSync(inputPath)) {
  console.error(`Input CSV not found: ${inputPath}`);
  process.exit(1);
}

const csvText = fs.readFileSync(inputPath, "utf8");
const rows = parseCsv(csvText);
if (rows.length < 2) {
  console.error("Input CSV has no data rows.");
  process.exit(1);
}

const header = rows[0];
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const keepCols = [
  "brand",
  "product_name_input",
  "product_keyword1",
  "product_keyword2",
  "search_form_available",
  "source_url",
  "search_form_confirmed_url",
];

const outHeader = [
  ...keepCols,
  "item_rank",
  "item_product_name",
  "item_list_price",
  "item_sale_price",
  "item_url",
  "item_image_src",
  "item_keyword_used",
];

const outRows = [outHeader];

for (let r = 1; r < rows.length; r += 1) {
  const row = rows[r];
  const base = Object.fromEntries(
    keepCols.map((c) => [c, row[idx[c]] ?? ""]),
  );
  const products = safeJsonArray(row[idx.search_form_product_list]);

  if (products.length === 0) {
    outRows.push([
      base.brand,
      base.product_name_input,
      base.product_keyword1,
      base.product_keyword2,
      base.search_form_available,
      base.source_url,
      base.search_form_confirmed_url,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    continue;
  }

  products.forEach((p, i) => {
    outRows.push([
      base.brand,
      base.product_name_input,
      base.product_keyword1,
      base.product_keyword2,
      base.search_form_available,
      base.source_url,
      base.search_form_confirmed_url,
      String(i + 1),
      p?.productName ?? "",
      p?.listPrice ?? "",
      p?.salePrice ?? "",
      p?.url ?? "",
      p?.imageSrc ?? "",
      p?.keywordUsed ?? "",
    ]);
  });
}

const outputPath = path.resolve(OUTPUT_CSV);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const outputCsv = outRows.map((r) => r.map(escapeCsv).join(",")).join("\n") + "\n";
fs.writeFileSync(outputPath, outputCsv, "utf8");

console.log(`Input rows: ${rows.length - 1}`);
console.log(`Output rows: ${outRows.length - 1}`);
console.log(`Saved: ${outputPath}`);

