import { supabaseAdmin } from "@/lib/supabase/server";
import { chromium } from "playwright";

type SearchItem = {
  title?: string;
  link?: string;
  snippet?: string;
};

type GroundedDecision = {
  officialUrl: string | null;
  confidence: number | null;
  reason: string | null;
  groundingMetadata?: unknown;
};

type ProductSignals = {
  url: string;
  text: string;
  priceBlockText: string;
  productName: string;
  listPrice: string;
  salePrice: string;
  score: number;
};

const TOP_TEXT_LIMIT = 1500;
const MAX_CRAWL_PAGES = 5;
const MAX_CRAWL_DEPTH = 2;
const MAX_PARSE_CANDIDATES = 1;
const PARSE_TEXT_LIMIT = 2000;
const MIN_PRODUCT_SCORE = 3;

async function fetchOfficialSiteCandidates(keyword: string) {
  const apiKey = process.env.SERPAPI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing SERPAPI_API_KEY in env");
  }

  const query = `${keyword} 공식 온라인몰 제품 식품`;
  const url =
    "https://serpapi.com/search.json" +
    `?engine=google` +
    `&q=${encodeURIComponent(query)}` +
    `&hl=ko&gl=kr` +
    `&api_key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpAPI request failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    error?: string;
    organic_results?: SearchItem[];
  };

  if (data.error) {
    throw new Error(`SerpAPI error: ${data.error}`);
  }

  const items = (data.organic_results ?? []).slice(0, 5).map((item) => ({
    title: item.title ?? "",
    link: item.link ?? "",
    snippet: item.snippet ?? "",
  }));

  return items;
}

async function fetchPageTopText(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      return "";
    }

    const html = await res.text();
    const withoutScripts = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");
    const text = withoutScripts
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, TOP_TEXT_LIMIT);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyOfficialSiteWithGemini(
  keyword: string,
  candidates: SearchItem[],
): Promise<GroundedDecision> {
  const apiKey = process.env.GOOGLE_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY in env");
  }

  const enrichedCandidates: Array<{
    title: string;
    link: string;
    snippet: string;
    topText: string;
  }> = [];

  for (const item of candidates) {
    const title = item.title ?? "";
    const link = item.link ?? "";
    const snippet = item.snippet ?? "";
    const topText = link ? await fetchPageTopText(link) : "";

    enrichedCandidates.push({ title, link, snippet, topText });
  }

  const candidateText = enrichedCandidates
    .map((item, i) => {
      return [
        `${i + 1}. ${item.title}`,
        item.link,
        item.snippet,
        item.topText ? `TOP_TEXT: ${item.topText}` : "TOP_TEXT: (없음)",
      ].join("\n");
    })
    .join("\n\n");

  const prompt = [
    "당신은 제품의 공식 홈페이지를 판별하는 검증기입니다.",
    `제품 키워드: ${keyword}`,
    "",
    "후보 URL 목록이 주어집니다. 필요하면 Google Search로 추가 검증해도 됩니다.",
    "아래 조건을 만족하는 하나의 URL을 골라 주세요:",
    "- 브랜드 또는 제조사 공식 홈페이지",
    "- 공식몰/공식사이트/브랜드 사이트가 아닌 단순 판매처는 제외",
    "- 제품 키워드가 상품일 가능성이 높으므로, 공식 제품 판매/구매/스토어 페이지를 우선",
    "- 동일 브랜드의 여러 페이지가 있으면 상품 구매 또는 공식 스토어가 있는 쪽을 우선",
    "- 페이지 상단(TOP_TEXT)에 구매/스토어 관련 신호가 있는 후보를 더 우선",
    "",
    "결과는 JSON만 반환하세요. 형식:",
    '{"officialUrl":"https://...","confidence":0.0,"reason":"..."}',
    "",
    "후보 목록:",
    candidateText || "(후보 없음)",
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini request failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: unknown;
    }>;
  };

  const rawText =
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  const text = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonSlice = (() => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return text.slice(start, end + 1);
    }
    return text;
  })();

  let parsed: { officialUrl?: string; confidence?: number; reason?: string } =
    {};

  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    const match = text.match(/https?:\/\/[^\s"'<>]+/);
    parsed = {
      officialUrl: match ? match[0] : undefined,
      confidence: undefined,
      reason: text,
    };
  }

  return {
    officialUrl: parsed.officialUrl ?? null,
    confidence:
      typeof parsed.confidence === "number" ? parsed.confidence : null,
    reason: parsed.reason ?? null,
    groundingMetadata: data.candidates?.[0]?.groundingMetadata,
  };
}

function isSameOriginOrSubdomain(baseUrl: URL, target: string) {
  try {
    const targetUrl = new URL(target, baseUrl);
    const baseHost = baseUrl.hostname;
    const targetHost = targetUrl.hostname;
    return (
      targetUrl.origin === baseUrl.origin ||
      targetHost === baseHost ||
      targetHost.endsWith(`.${baseHost}`)
    );
  } catch {
    return false;
  }
}

function normalizeUrl(baseUrl: URL, target: string) {
  try {
    const url = new URL(target, baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function scoreProductUrl(url: string) {
  const lower = url.toLowerCase();
  const keywords = [
    "/product",
    "/products",
    "/item",
    "/goods",
    "/detail",
    "/category",
    "/categories",
    "/shop",
    "/store",
    "/mall",
    "product_id=",
    "goods_id=",
    "item_id=",
    "cate_no=",
    "category=",
    "category_no=",
    "goodsno=",
  ];

  let score = 0;
  for (const key of keywords) {
    if (lower.includes(key)) {
      score += 1;
    }
  }
  return score;
}

function scoreKeywordMatch(url: string, keyword: string) {
  const normalized = keyword.toLowerCase().replace(/\s+/g, "");
  if (!normalized) return 0;
  const urlLower = url.toLowerCase();
  if (urlLower.includes(normalized)) return 3;

  const tokens = keyword
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (urlLower.includes(token)) score += 1;
  }
  return score;
}

function scoreKeywordText(text: string, keyword: string) {
  const normalized = keyword.toLowerCase().replace(/\s+/g, "");
  if (!normalized) return 0;
  const textLower = text.toLowerCase();
  if (textLower.includes(normalized)) return 4;

  const tokens = keyword
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (textLower.includes(token)) score += 1;
  }
  return score;
}

async function crawlProductUrls(startUrl: string, keyword: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const baseUrl = new URL(startUrl);
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    { url: startUrl, depth: 0 },
  ];
  const productCandidates = new Map<string, number>();
  const searchCandidates = new Set<string>();
  let fallbackSearchUrl: string | null = null;
  let addedCategoryUrls = 0;
  let searchOnlyMode = false;

  try {
    while (queue.length > 0 && visited.size < MAX_CRAWL_PAGES) {
      const current = queue.shift();
      if (!current) continue;
      const normalized = normalizeUrl(baseUrl, current.url);
      if (!normalized || visited.has(normalized)) continue;

      visited.add(normalized);

      const page = await context.newPage();
      try {
        await page.goto(normalized, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        try {
          await page.waitForLoadState("networkidle", { timeout: 1500 });
        } catch {
          // ignore if network keeps busy
        }
        await page.waitForTimeout(300);

        const hrefs = await page.evaluate(() => {
          const links: Array<{ href: string; text: string }> = [];

          const push = (value?: string | null) => {
            if (!value) return;
            const v = value.trim();
            if (!v || v.startsWith("javascript:")) return;
            links.push({ href: v, text: "" });
          };

          document.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href");
            const text = (a.textContent || "").replace(/\s+/g, " ").trim();
            if (!href) return;
            const v = href.trim();
            if (!v || v.startsWith("javascript:")) return;
            links.push({ href: v, text });
          });
          document
            .querySelectorAll("[data-href],[data-url],[data-link]")
            .forEach((el) => {
              const anyEl = el as HTMLElement;
              push(anyEl.getAttribute("data-href"));
              push(anyEl.getAttribute("data-url"));
              push(anyEl.getAttribute("data-link"));
            });

          document.querySelectorAll("[onclick]").forEach((el) => {
            const handler = el.getAttribute("onclick") || "";
            const match = handler.match(
              /location\.href\s*=\s*['"]([^'"]+)['"]/,
            );
            if (match?.[1]) {
              push(match[1]);
            }
          });

          return links;
        });

        if (!fallbackSearchUrl && current.depth === 0) {
          const searchUrl = await page.evaluate((searchKeyword) => {
            const input =
              document.querySelector('input[type="search"]') ||
              document.querySelector('input[name*="search" i]') ||
              document.querySelector('input[name*="query" i]') ||
              document.querySelector('input[name*="keyword" i]') ||
              document.querySelector('input[name*="q" i]');

            if (!input) return null;
            const form = input.closest("form");
            if (!form) return null;

            const method = (form.getAttribute("method") || "get").toLowerCase();
            if (method !== "get") return null;

            const action = form.getAttribute("action") || window.location.href;
            const name = input.getAttribute("name") || "q";

            try {
              const url = new URL(action, window.location.href);
              url.searchParams.set(name, searchKeyword);
              return url.toString();
            } catch {
              return null;
            }
          }, keyword);

          if (searchUrl) {
            fallbackSearchUrl = searchUrl;
            searchOnlyMode = true;
            queue.length = 0;
            queue.push({
              url: searchUrl,
              depth: Math.min(current.depth + 1, MAX_CRAWL_DEPTH),
            });
            continue;
          }
        }

        for (const item of hrefs as Array<{ href: string; text: string }>) {
          const absolute = normalizeUrl(baseUrl, item.href);
          if (!absolute) continue;
          if (!isSameOriginOrSubdomain(baseUrl, absolute)) continue;

          if (!searchOnlyMode && current.depth === 0 && addedCategoryUrls < 5) {
            if (
              absolute.toLowerCase().includes("category") ||
              absolute.toLowerCase().includes("cate_no=")
            ) {
              queue.push({ url: absolute, depth: current.depth + 1 });
              addedCategoryUrls += 1;
            }
          }

          const score =
            scoreProductUrl(absolute) +
            scoreKeywordMatch(absolute, keyword) +
            scoreKeywordText(item.text || "", keyword);
          if (score > 0) {
            const prev = productCandidates.get(absolute) ?? 0;
            if (score > prev) {
              productCandidates.set(absolute, score);
            }
          }

          if (fallbackSearchUrl && normalized === fallbackSearchUrl) {
            searchCandidates.add(absolute);
          }

          if (!searchOnlyMode && current.depth + 1 <= MAX_CRAWL_DEPTH) {
            queue.push({ url: absolute, depth: current.depth + 1 });
          }
        }
      } catch {
        // ignore individual page failures
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const sorted = Array.from(productCandidates.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([url, score]) => ({ url, score }));

  return {
    visited: Array.from(visited),
    productCandidates: sorted,
    fallbackSearchUrl,
    searchCandidates: Array.from(searchCandidates),
  };
}

async function fetchProductSignals(url: string): Promise<ProductSignals> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const result = await page.evaluate(() => {
      const pickText = (selector: string) =>
        document.querySelector(selector)?.textContent?.trim() || "";
      const normalizePrice = (value: string) => {
        if (!value) return "";
        const matches =
          value.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)/g) ?? [];
        const nums = matches
          .map((m) => Number(m.replace(/,/g, "")))
          .filter((n) => Number.isFinite(n));
        if (!nums.length) return "";
        const filtered = nums.filter((n) => n >= 1000);
        const best = (filtered.length ? Math.max(...filtered) : Math.max(...nums));
        return String(best);
      };

      const ogTitle =
        document
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content")
          ?.trim() || "";

      const title =
        pickText("h1") ||
        pickText(".product_name") ||
        pickText(".prd_name") ||
        pickText(".product_title") ||
        pickText(".product-name") ||
        ogTitle ||
        document.title ||
        "";

      const listPriceSelectors = [
        "#span_product_price_text",
        ".prdPrice",
        ".price",
        ".product_price",
        ".product-price",
        "[itemprop='price']",
      ];

      const salePriceSelectors = [
        ".sale_price",
        ".discount_price",
        ".price--sale",
        ".price.sale",
      ];

      const pickFirst = (selectors: string[]) => {
        for (const sel of selectors) {
          const value = pickText(sel);
          if (value) return value;
        }
        return "";
      };

      const listPrice =
        pickFirst(listPriceSelectors) ||
        document
          .querySelector('meta[property="product:price:amount"]')
          ?.getAttribute("content")
          ?.trim() ||
        "";

      const salePrice = pickFirst(salePriceSelectors);

      const structuredListPrice =
        pickText(".custom.through") ||
        pickText(".price .custom.through") ||
        pickText(".dk-custom");
      const structuredSalePrice =
        pickText("#span_product_price_text") ||
        pickText(".price.msale") ||
        pickText(".price .msale") ||
        pickText(".dk-sale");

      const labelPricePairs = Array.from(
        document.querySelectorAll("li, tr, p, div, span"),
      )
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 0 && text.length < 120);

      let labeledListPrice = "";
      let labeledSalePrice = "";
      let priceBlockText = "";

      for (const text of labelPricePairs) {
        if (!labeledListPrice && /정가|소비자\s*가격/.test(text)) {
          const match = text.match(/([0-9][0-9,\.]*)\s*(원|₩)/);
          if (match?.[1]) labeledListPrice = match[1];
        }
        if (!labeledSalePrice && /판매가|할인가|할인\s*가/.test(text)) {
          const match = text.match(/([0-9][0-9,\.]*)\s*(원|₩)/);
          if (match?.[1]) labeledSalePrice = match[1];
        }
        if (labeledListPrice && labeledSalePrice) break;
      }

      if (labeledListPrice || labeledSalePrice) {
        const nodes = Array.from(
          document.querySelectorAll("li, tr, p, div, span"),
        ).filter((el) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          return /정가|소비자\s*가격|판매가|할인가|할인\s*가/.test(t);
        });

        const blockTexts = nodes
          .map((el) => {
            const parent = el.closest("li, tr, p, div") || el;
            return (parent.textContent || "").replace(/\s+/g, " ").trim();
          })
          .filter(Boolean);

        priceBlockText = blockTexts.join(" | ").slice(0, 800);
      }

      const finalListPrice = normalizePrice(
        structuredListPrice || labeledListPrice || listPrice,
      );
      const finalSalePrice = normalizePrice(
        structuredSalePrice || labeledSalePrice || salePrice,
      );

      const main =
        document.querySelector("main")?.textContent ||
        document.querySelector("#container")?.textContent ||
        document.body?.textContent ||
        "";

      return {
        title,
        listPrice: finalListPrice,
        salePrice: finalSalePrice,
        priceBlockText,
        text: main,
      };
    });

    const text = (result.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, PARSE_TEXT_LIMIT);

    const formatPrice = (value: string) => {
      if (!value) return "";
      const num = Number(value.replace(/[^\d]/g, ""));
      return Number.isFinite(num) && num > 0
        ? `${num.toLocaleString("ko-KR")}원`
        : "";
    };

    return {
      url,
      text,
      priceBlockText: result.priceBlockText || "",
      productName: result.title || "",
      listPrice: formatPrice(result.listPrice || ""),
      salePrice: formatPrice(result.salePrice || ""),
      score: 0,
    };
  } catch {
    return {
      url,
      text: "",
      priceBlockText: "",
      productName: "",
      listPrice: "",
      salePrice: "",
      score: 0,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

function parsePriceNumber(value: string) {
  if (!value) return null;
  const num = Number(value.replace(/[^\d]/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function isPriceAnomalous(listPrice: string, salePrice: string) {
  const listNum = parsePriceNumber(listPrice);
  const saleNum = parsePriceNumber(salePrice);
  if (!listNum || !saleNum) return false;
  return saleNum > listNum;
}

async function parseProductInfoWithGemini(
  keyword: string,
  candidates: Array<ProductSignals>,
  mode: "validate" | "fill",
) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY in env");
  }

  const promptHeader =
    mode === "validate"
      ? [
          "너는 DOM에서 추출된 가격/상품명을 검증하는 검증기다.",
          `사용자 키워드: ${keyword}`,
          "",
          "DOM에서 추출된 값이 올바른지 확인하고 필요하면 교정하되,",
          "추론으로 값을 만들어내지 말고 제공된 정보에 기반해 판단한다.",
        ]
      : [
          "너는 상품 상세 페이지에서 정보를 추출하는 파서다.",
          `사용자 키워드: ${keyword}`,
          "",
          "DOM에서 누락된 값이 있을 수 있다. 제공된 힌트와 텍스트를 활용해 채워라.",
        ];

  const promptRules = [
    "출력 JSON 스키마:",
    '{"productName":"...","listPrice":"...","salePrice":"...","detailUrl":"...","reason":"..."}',
    "",
    "규칙:",
    "- detailUrl은 실제 상품 정보가 있는 후보 URL이어야 함",
    "- 텍스트에 여러 상품이 있으면, 위에서 아래로 읽었을 때 처음 등장하는 상품을 선택",
    "- productName과 listPrice가 확인되는 최초 정보를 우선",
    "- salePrice가 없으면 빈 문자열로 둠",
    "- JSON 외 다른 텍스트 출력 금지",
    "",
    "후보:",
  ];

  const promptCandidates =
    candidates.length > 0
      ? candidates
          .map((item, i) => {
            const header = `${i + 1}. ${item.url}`;
            if (mode === "validate") {
              return (
                `${header}\n` +
                `HINT_NAME: ${item.productName || "(없음)"}\n` +
                `HINT_LIST_PRICE: ${item.listPrice || "(없음)"}\n` +
                `HINT_SALE_PRICE: ${item.salePrice || "(없음)"}\n` +
                `${
                  item.priceBlockText
                    ? `PRICE_BLOCK: ${item.priceBlockText}`
                    : "PRICE_BLOCK: (없음)"
                }`
              );
            }
            return (
              `${header}\n` +
              `HINT_NAME: ${item.productName || "(없음)"}\n` +
              `HINT_LIST_PRICE: ${item.listPrice || "(없음)"}\n` +
              `HINT_SALE_PRICE: ${item.salePrice || "(없음)"}\n` +
              `${
                item.priceBlockText
                  ? `PRICE_BLOCK: ${item.priceBlockText}`
                  : "PRICE_BLOCK: (없음)"
              }\n` +
              `${item.text ? `TEXT: ${item.text}` : "TEXT: (없음)"}`
            );
          })
          .join("\n\n")
      : "(후보 없음)";

  const prompt = [...promptHeader, "", ...promptRules, promptCandidates].join(
    "\n",
  );

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini request failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const rawText =
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  const text = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonSlice = (() => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return text.slice(start, end + 1);
    }
    return text;
  })();

  let parsed: {
    productName?: string;
    listPrice?: string;
    salePrice?: string;
    detailUrl?: string;
    reason?: string;
  } = {};

  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    parsed = { reason: text };
  }

  return {
    productName: parsed.productName ?? "",
    listPrice: parsed.listPrice ?? "",
    salePrice: parsed.salePrice ?? "",
    detailUrl: parsed.detailUrl ?? "",
    reason: parsed.reason ?? "",
  };
}

async function parseFirstValidProductInfo(
  keyword: string,
  candidates: Array<ProductSignals>,
) {
  for (const candidate of candidates) {
    const hasDomName =
      candidate.productName && candidate.productName.trim().length > 0;
    const hasDomListPrice =
      candidate.listPrice && candidate.listPrice.trim().length > 0;

    const mode = hasDomName && hasDomListPrice ? "validate" : "fill";
    const result = await parseProductInfoWithGemini(keyword, [candidate], mode);
    const hasName = result.productName && result.productName.trim().length > 0;
    const hasListPrice =
      result.listPrice && result.listPrice.trim().length > 0;

    if (hasName && hasListPrice) {
      return result;
    }
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const tStart = Date.now();
    const body = await request.json();
    const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";

    if (!keyword) {
      return Response.json({ error: "keyword is required" }, { status: 400 });
    }

    const t0 = Date.now();
    const items = await fetchOfficialSiteCandidates(keyword);
    console.log("[timing] serpapi_ms", Date.now() - t0);

    const t1 = Date.now();
    const verified = await verifyOfficialSiteWithGemini(keyword, items);
    console.log("[timing] gemini_verify_ms", Date.now() - t1);
    const sourceUrl = verified.officialUrl ?? items[0]?.link ?? null;
    const t2 = Date.now();
    const crawlResult = sourceUrl
      ? await crawlProductUrls(sourceUrl, keyword)
      : null;
    console.log("[timing] crawl_ms", Date.now() - t2);
    const candidatePool = (crawlResult?.productCandidates ?? []).filter(
      (item) => item.score >= MIN_PRODUCT_SCORE,
    );
    const searchSet = new Set(crawlResult?.searchCandidates ?? []);
    const searchOnly = candidatePool.filter((item) => searchSet.has(item.url));
    const finalPool = searchOnly.length > 0 ? searchOnly : candidatePool;
    const maxScore = finalPool.length > 0 ? finalPool[0].score : 0;
    const topCandidates = finalPool
      .filter((item) => item.score === maxScore)
      .slice(0, 3);

    const t3 = Date.now();
    const candidateSignals: ProductSignals[] = [];
    for (const item of topCandidates) {
      const signals = await fetchProductSignals(item.url);
      candidateSignals.push({ ...signals, score: item.score });
    }
    if (candidateSignals.length === 0 && sourceUrl) {
      const signals = await fetchProductSignals(sourceUrl);
      candidateSignals.push({ ...signals, score: 0 });
    }
    console.log("[timing] dom_parse_ms", Date.now() - t3);

    const parsedCandidates: Array<{
      url: string;
      productName: string;
      listPrice: string;
      salePrice: string;
      score: number;
      reason: string;
    }> = [];

    const t4 = Date.now();
    for (const candidate of candidateSignals) {
      let finalCandidate = {
        url: candidate.url,
        productName: candidate.productName,
        listPrice: candidate.listPrice,
        salePrice: candidate.salePrice,
        score: candidate.score,
        reason: "DOM parsed",
      };

      if (
        isPriceAnomalous(candidate.listPrice, candidate.salePrice) ||
        (!candidate.listPrice && candidate.salePrice)
      ) {
        const corrected = await parseProductInfoWithGemini(keyword, [candidate]);
        if (corrected.productName || corrected.listPrice || corrected.salePrice) {
          finalCandidate = {
            url: corrected.detailUrl || candidate.url,
            productName: corrected.productName || candidate.productName,
            listPrice: corrected.listPrice || candidate.listPrice,
            salePrice: corrected.salePrice || candidate.salePrice,
            score: candidate.score,
            reason: "Gemini corrected",
          };
        }
      }

      parsedCandidates.push(finalCandidate);
    }
    console.log("[timing] gemini_price_ms", Date.now() - t4);

    const parsedInfo = parsedCandidates[0] ?? null;

    const t5 = Date.now();
    const { data, error } = await supabaseAdmin
      .from("products")
      .insert({
        keyword,
        source_url: sourceUrl,
        detail_url: parsedInfo?.url || null,
        product_name: parsedInfo?.productName || null,
        list_price: parsedInfo?.listPrice || null,
        sale_price: parsedInfo?.salePrice || null,
        raw_data: {
          stage: "grounded_search",
          query: `${keyword} 공식 온라인몰 제품 식품`,
          items,
          grounded: verified,
        },
        raw_data_parse: {
          stage: "parse",
          crawl: crawlResult,
          parsed: parsedInfo,
          parsed_candidates: parsedCandidates,
        },
      })
      .select()
      .single();
    console.log("[timing] db_ms", Date.now() - t5);
    console.log("[timing] total_ms", Date.now() - tStart);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true, id: data?.id ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
