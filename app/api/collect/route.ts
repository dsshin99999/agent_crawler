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
  titleBlockText: string;
  priceLines: string;
  currencyHint: string;
  imageSrc: string;
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
  const apiKey = process.env.SEARCHAPI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing SEARCHAPI_API_KEY in env");
  }

  const query = `${keyword} 공식 판매 온라인 제품 스토어 official store website official sell online product store`;
  const url =
    "https://www.searchapi.io/api/v1/search" +
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
    results?: SearchItem[];
    items?: SearchItem[];
  };

  if (data.error) {
    throw new Error(`SearchAPI error: ${data.error}`);
  }

  const organic =
    data.organic_results ??
    data.results ??
    data.items ??
    [];

  const items = organic.slice(0, 5).map((item) => ({
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

type OfficialDecision = GroundedDecision & {
  officialStoreUrl?: string | null;
  officialDetailUrl?: string | null;
  businessAlias?: string | null;
  officialEn?: string | null;
  officialKo?: string | null;
  productKeywords?: string[];
};

async function verifyOfficialSiteWithGemini(
  brand: string,
  productNameKo: string,
  productNameEn: string,
  candidates: SearchItem[],
): Promise<OfficialDecision> {
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
    "당신은 브랜드의 공식 온라인 판매몰을 판별하는 검증기입니다.",
    `브랜드: ${brand}`,
    `제품명(한글): ${productNameKo}`,
    `제품명(영문): ${productNameEn || "(없음)"}`,
    "",
    "후보 URL 목록(SerpAPI 결과)만을 근거로 판단하세요.",
    "아래 항목을 JSON으로 반환하세요:",
    "- officialHomepage: 브랜드 공식 판매점/스토어 홈페이지",
    "- officialStoreUrl: 공식 온라인몰 도메인(있다면)",
    "- officialDetailUrl: 후보 중 공식 판매점의 제품 상세 페이지로 판단되는 URL(있다면)",
    "- businessAlias: 브랜드 별칭",
    "- officialEn: 공식 영문명",
    "- officialKo: 공식 한글명",
    "- productKeywords 규칙:",
    "- product_keyword1(original): 입력 제품명(한글, productNameKo) 문자열에서 브랜드명을 제외하고, 제품 유형을 가장 잘 설명하는 핵심 단어 1개를 원문 그대로 추출한다. 같은 의미의 다른 단어로 변형 금지",
    "- product_keyword2(ko): product_keyword1이 한글이면 원문 그대로 복사한다. product_keyword1이 영문이면 productNameKo 또는 후보 텍스트에 실제 존재하는 대응 한글 표현 1개를 사용한다.",
    "- product_keyword3(en): product_keyword1에 대응되는 영문 표현 1개를 productNameEn에서 우선 선택한다. productNameEn에 없으면 후보 텍스트에 실제 존재하는 영문 표현만 사용한다.",
    "- 금지: 새 단어 생성/의역/추측/확장 금지. 입력 제품명 또는 후보 텍스트에 실제로 존재하는 표현만 사용한다.",
    "- 금지: officialKo/officialEn(브랜드명)과 동일하거나 브랜드명 일부인 단어 사용 금지.",
    // "- 복합어 유지: 원문이 복합어/붙여쓰기이면 분해하지 말고 원문 그대로 사용 (예: 무선선풍기).",
    "- 대응 언어 표현이 입력/후보 텍스트에 없으면 해당 컬럼은 빈 문자열로 둔다.",
    "- 값이 없으면 빈 문자열로 반환한다.",
    "- 출처는 공식 판매점이며, 검색한 제품의 상세 정보가 담긴 페이지인지 판단하라",
    "- confidence: 0~1",
    "- reason: 간단 이유",
    "",
    "결과는 JSON만 반환하세요. 형식:",
    '{"officialHomepage":"https://...","officialStoreUrl":"https://...","officialDetailUrl":"https://...","businessAlias":"...","officialEn":"...","officialKo":"...","productKeywords":["<original>","<ko>","<en>"],"confidence":0.0,"reason":"..."}',
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

  let parsed: {
    officialHomepage?: string;
    officialStoreUrl?: string;
    officialDetailUrl?: string;
    businessAlias?: string;
    officialEn?: string;
    officialKo?: string;
    productKeywords?: string[];
    confidence?: number;
    reason?: string;
  } = {};

  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    const match = text.match(/https?:\/\/[^\s"'<>]+/);
    parsed = {
      officialHomepage: match ? match[0] : undefined,
      confidence: undefined,
      reason: text,
    };
  }

  return {
    officialUrl: parsed.officialHomepage ?? null,
    officialStoreUrl: parsed.officialStoreUrl ?? null,
    officialDetailUrl: parsed.officialDetailUrl ?? null,
    businessAlias: parsed.businessAlias ?? null,
    officialEn: parsed.officialEn ?? null,
    officialKo: parsed.officialKo ?? null,
    productKeywords: parsed.productKeywords ?? [],
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

      const detectCurrency = (value: string) => {
        if (/[₩원]/.test(value)) return "KRW";
        if (/\$|USD/i.test(value)) return "USD";
        if (/€|EUR/i.test(value)) return "EUR";
        if (/£|GBP/i.test(value)) return "GBP";
        return "";
      };

      const ogTitle =
        document
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content")
          ?.trim() || "";

      const titleSelectors = [
        "h1",
        "h2",
        ".product_name",
        ".prd_name",
        ".product_title",
        ".product-name",
      ];
      const titleBlockText = titleSelectors
        .map((sel) => pickText(sel))
        .filter(Boolean)
        .join(" | ");

      const normalizeName = (value: string) =>
        value.replace(/\s+/g, " ").trim();
      const isInvalidName = (value: string) => {
        const v = normalizeName(value);
        if (!v) return true;
        if (v.length <= 3) return true;
        if (/^\d+$/.test(v)) return true;
        if (
          /배송|공지|로그인|장바구니|품절|SOLD OUT|WORLD SHIPPING/i.test(v)
        ) {
          return true;
        }
        return false;
      };

      const titleCandidates = [
        pickText("h1"),
        pickText("h2"),
        pickText(".product_name"),
        pickText(".prd_name"),
        pickText(".product_title"),
        pickText(".product-name"),
        pickText(".title"),
        ogTitle,
        document.title,
      ].map(normalizeName);

      const title =
        titleCandidates.find((value) => !isInvalidName(value)) || "";

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

      const rawListPrice = structuredListPrice || labeledListPrice || listPrice;
      const rawSalePrice = structuredSalePrice || labeledSalePrice || salePrice;
      const finalListPrice = normalizePrice(rawListPrice);
      const finalSalePrice = normalizePrice(rawSalePrice);

      const main =
        document.querySelector("main")?.textContent ||
        document.querySelector("#container")?.textContent ||
        document.body?.textContent ||
        "";

      const currencyHint =
        detectCurrency(rawListPrice || "") ||
        detectCurrency(rawSalePrice || "") ||
        detectCurrency(main || "");

      const textHead = main.replace(/\s+/g, " ").trim().slice(0, 1000);
      const imageSrc =
        (document.querySelector('meta[property="og:image"]') as HTMLMetaElement)
          ?.content ||
        (document.querySelector("img[src]") as HTMLImageElement)?.src ||
        "";
      const priceLines = main
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => /([0-9]{1,3}(?:,[0-9]{3})+|\d+)\s*(원|₩|\$|€|£|USD|EUR|GBP)/i.test(line))
        .slice(0, 20)
        .join(" | ");

      return {
        title,
        listPrice: finalListPrice,
        salePrice: finalSalePrice,
        priceBlockText,
        text: textHead,
        titleBlockText,
        imageSrc,
        priceLines,
        currencyHint,
        rawListPrice,
        rawSalePrice,
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
      titleBlockText: result.titleBlockText || "",
      priceLines: result.priceLines || "",
      currencyHint: result.currencyHint || "",
      imageSrc: (result.imageSrc || "").trim(),
      productName: result.title || "",
      listPrice:
        result.currencyHint && result.currencyHint !== "KRW"
          ? extractCurrencyPrice(result.priceLines || "") ||
            (result.rawListPrice || "").trim()
          : formatPrice(result.listPrice || ""),
      salePrice:
        result.currencyHint && result.currencyHint !== "KRW"
          ? extractCurrencyPrice(result.priceLines || "") ||
            (result.rawSalePrice || "").trim()
          : formatPrice(result.salePrice || ""),
      score: 0,
    };
  } catch {
    return {
      url,
      text: "",
      priceBlockText: "",
      titleBlockText: "",
      priceLines: "",
      currencyHint: "",
      imageSrc: "",
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

function extractCurrencyPrice(lines: string) {
  if (!lines) return "";
  const match = lines.match(
    /([$€£]\s?[0-9][0-9,\.]*|[0-9][0-9,\.]*\s?(USD|EUR|GBP))/i,
  );
  return match ? match[0].trim() : "";
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
          "DOM에서 추출한 제품 정보가 실제 제품을 의미하는지 확인하고,",
          "추론으로 값을 만들어내지 말고 제공된 정보에 기반해 판단한다.",
          "TEXT_HEAD에 근거가 없는 제품명/가격은 제외한다.",
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
    "- productName은 실제 상품명을 의미해야 하며, 배송/공지/브랜드명/사이트명/카테고리명은 제외",
    "- DOM에서 추출한 제품 정보가 실제 제품을 의미하는지 확인하고,",
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
            const base =
              `${header}\n` +
              `HINT_NAME: ${item.productName || "(없음)"}\n` +
              `HINT_LIST_PRICE: ${item.listPrice || "(없음)"}\n` +
              `HINT_SALE_PRICE: ${item.salePrice || "(없음)"}\n` +
              `${
                item.priceBlockText
                  ? `PRICE_BLOCK: ${item.priceBlockText}`
                  : "PRICE_BLOCK: (없음)"
              }\n` +
              `${
                item.titleBlockText
                  ? `TITLE_BLOCK: ${item.titleBlockText}`
                  : "TITLE_BLOCK: (없음)"
              }\n` +
              `${
                item.priceLines
                  ? `PRICE_LINES: ${item.priceLines}`
                  : "PRICE_LINES: (없음)"
              }\n` +
              `${
                item.currencyHint
                  ? `CURRENCY_HINT: ${item.currencyHint}`
                  : "CURRENCY_HINT: (없음)"
              }\n` +
              `${item.text ? `TEXT_HEAD: ${item.text}` : "TEXT_HEAD: (없음)"}`;
            return base;
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

async function parseSearchFormProductsWithGemini(
  keyword: string,
  pageUrl: string,
  attempts: Array<{
    url: string;
    keyword: string;
    pageText: string;
    networkText: string;
    candidateProducts: Array<{
      detailUrl: string;
      thumbCandidates: string[];
      cardText: string;
    }>;
  }>,
  priorityKeywords: string[],
) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY in env");
  }

  const prompt = [
    "너는 검색 결과 페이지 텍스트에서 상품 목록을 구조화하는 파서다.",
    "목표: 실제 판매 상품만 최대 10개 추출.",
    `사용자 키워드: ${keyword}`,
    `기준 페이지 URL: ${pageUrl}`,
    `우선 키워드: ${priorityKeywords.filter(Boolean).join(", ") || "(없음)"}`,
    "",
    "출력 JSON 스키마:",
    '{"products":[{"url":"...","productName":"...","listPrice":"...","salePrice":"...","imageSrc":"...","reason":"..."}]}',
    "",
    "규칙:",
    "- products는 최대 10개",
    "- productName은 실제 상품명이어야 함",
    "- productName으로 사용 금지: SHOP, WORLD SHIPPING, Home, Category, 공지, 배송, 리뷰, 브랜드명 단독",
    "- 가격 정보(listPrice 또는 salePrice)가 없는 항목은 제외",
    "- 우선 키워드(priorityKeywords)가 productName 또는 근거 텍스트에 포함된 항목을 먼저 채택",
    "- 우선 키워드 매칭 항목이 5개 미만이면 나머지를 보조 항목으로 채움",
    "- listPrice/salePrice는 텍스트 원문 유지(통화/기호 포함)",
    "- salePrice가 없으면 빈 문자열",
    "- imageSrc는 해당 상품의 thumbCandidates를 우선 사용",
    "- 확신이 낮으면 해당 항목을 제외",
    "- JSON 외 텍스트 금지",
    "",
    "좋은 예:",
    '{"products":[{"url":"https://.../product/123","productName":"무선선풍기 FAN PRIME 3","listPrice":"66,000원","salePrice":"57,900원","imageSrc":"https://.../image.jpg","reason":"우선 키워드 매칭 + 가격 확인"}]}',
    "나쁜 예:",
    '{"products":[{"url":"https://...","productName":"SHOP","listPrice":"","salePrice":"","imageSrc":"","reason":"메뉴 텍스트"}]}',
    "",
    "입력 텍스트:",
    attempts
      .map((item, i) =>
        [
          `${i + 1}. URL: ${item.url}`,
          `SEARCH_KEYWORD: ${item.keyword}`,
          `CANDIDATE_PRODUCTS: ${
            item.candidateProducts.length > 0
              ? JSON.stringify(item.candidateProducts)
              : "[]"
          }`,
          item.pageText ? `PAGE_TEXT: ${item.pageText}` : "PAGE_TEXT: (없음)",
          item.networkText
            ? `NETWORK_TEXT: ${item.networkText}`
            : "NETWORK_TEXT: (없음)",
        ].join("\n"),
      )
      .join("\n\n"),
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
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const jsonSlice = start >= 0 && end > start ? text.slice(start, end + 1) : text;

  try {
    const parsed = JSON.parse(jsonSlice) as {
      products?: Array<{
        url?: string;
        productName?: string;
        listPrice?: string;
        salePrice?: string;
        imageSrc?: string;
        reason?: string;
      }>;
    };
    return (parsed.products ?? []).slice(0, 10);
  } catch {
    return [];
  }
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

async function checkSearchFormAvailability(
  homepageUrl: string,
  searchKeywords: string[],
  productName: string,
): Promise<{ available: boolean; info: Record<string, unknown> | null }> {
  const keywords = Array.from(
    new Set(
      searchKeywords
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    ),
  );
  if (keywords.length === 0) {
    return { available: false, info: null };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  try {
    const page = await context.newPage();
    await page.goto(homepageUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    let lastInfo: Record<string, unknown> | null = null;
    const probeHistory: Array<Record<string, unknown>> = [];

    const probe = async (label: string, searchKeyword: string) => {
      const readSearchInfo = async (kw: string) =>
        page.evaluate((innerKw) => {
        const inputCandidates = Array.from(document.querySelectorAll("input"))
          .slice(0, 20)
          .map((el) => {
            const input = el as HTMLInputElement;
            return {
              type: input.getAttribute("type") || "",
              name: input.getAttribute("name") || "",
              id: input.getAttribute("id") || "",
              className: input.getAttribute("class") || "",
              placeholder: input.getAttribute("placeholder") || "",
            };
          });

        const input =
          document.querySelector('input[type="search"]') ||
          document.querySelector('input[name*="search" i]') ||
          document.querySelector('input[name*="query" i]') ||
          document.querySelector('input[name*="keyword" i]') ||
          document.querySelector('input[name*="kwrd" i]') ||
          document.querySelector('input[name*="q" i]');

        if (!input) {
          return {
            errorReason: "input_not_found",
            pageUrl: window.location.href,
            inputCandidates,
          };
        }
        const form = input.closest("form");
        if (!form) {
          return {
            errorReason: "form_not_found",
            pageUrl: window.location.href,
            inputCandidates,
            inputDebug: {
              type: input.getAttribute("type") || "",
              name: input.getAttribute("name") || "",
              id: input.getAttribute("id") || "",
              className: input.getAttribute("class") || "",
              placeholder: input.getAttribute("placeholder") || "",
            },
          };
        }

        const method = (form.getAttribute("method") || "get").toLowerCase();
        if (method !== "get") {
          return {
            errorReason: "method_not_get",
            pageUrl: window.location.href,
            inputCandidates,
            formDebug: {
              actionRaw: form.getAttribute("action") || "",
              methodRaw: form.getAttribute("method") || "",
              id: form.getAttribute("id") || "",
              className: form.getAttribute("class") || "",
            },
          };
        }

        const action = form.getAttribute("action") || window.location.href;
        const name = input.getAttribute("name") || "q";

        try {
          const url = new URL(action, window.location.href);
          url.searchParams.set(name, innerKw);
          return {
            action: url.toString(),
            method,
            inputName: name,
            inputDebug: {
              selectorHint: "type=search|name*=search/query/keyword/kwrd/q",
              type: input.getAttribute("type") || "",
              name: input.getAttribute("name") || "",
              id: input.getAttribute("id") || "",
              className: input.getAttribute("class") || "",
              placeholder: input.getAttribute("placeholder") || "",
            },
            formDebug: {
              actionRaw: form.getAttribute("action") || "",
              methodRaw: form.getAttribute("method") || "",
              id: form.getAttribute("id") || "",
              className: form.getAttribute("class") || "",
            },
          };
        } catch {
          return {
            errorReason: "invalid_action_url",
            pageUrl: window.location.href,
            inputCandidates,
            formDebug: {
              actionRaw: form.getAttribute("action") || "",
              methodRaw: form.getAttribute("method") || "",
              id: form.getAttribute("id") || "",
              className: form.getAttribute("class") || "",
            },
          };
        }
      }, kw);

      let searchInfo = await readSearchInfo(searchKeyword);

      if (!searchInfo?.action && searchInfo?.errorReason === "form_not_found") {
        const inputId =
          typeof searchInfo?.inputDebug?.id === "string"
            ? searchInfo.inputDebug.id.trim()
            : "";
        if (inputId) {
          const clicked = await page.evaluate((id) => {
            const trigger = document.getElementById(id);
            if (trigger instanceof HTMLElement) {
              trigger.click();
              return true;
            }
            return false;
          }, inputId);
          if (clicked) {
            await page.waitForTimeout(400);
            searchInfo = await readSearchInfo(searchKeyword);
            console.log("[searchform] trigger_reprobe", {
              source: label,
              submittedText: searchKeyword,
              triggerId: inputId,
              recoveredAction: !!searchInfo?.action,
              reason: searchInfo?.errorReason ?? null,
            });
          }
        }
      }

      if (!searchInfo?.action) {
        const noFormInfo = {
          source: label,
          submittedText: searchKeyword,
          fromUrl: page.url(),
          action: "",
          resultUrl: page.url(),
          searchKeyword,
          productName,
          nameHit: false,
          priceHit: false,
          reason: searchInfo?.errorReason ?? "unknown",
          debug: searchInfo ?? null,
        };
        console.log("[searchform] probe_no_form", noFormInfo);
        return { available: false, info: noFormInfo };
      }
      console.log("[searchform] probe_submit", {
        source: label,
        submittedText: searchKeyword,
        fromUrl: page.url(),
        action: searchInfo.action,
        inputName: searchInfo.inputName,
        inputDebug: searchInfo.inputDebug,
        formDebug: searchInfo.formDebug,
      });

      await page.goto(searchInfo.action, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      const resultUrl = page.url();
      console.log("[searchform] probe_result_page", {
        source: label,
        submittedText: searchKeyword,
        resultUrl,
      });
      const bodyText = await page.evaluate(() => document.body?.textContent || "");
      const normalized = bodyText.replace(/\s+/g, " ").toLowerCase();
      const nameHit =
        normalized.includes(productName.toLowerCase()) ||
        normalized.includes(searchKeyword.toLowerCase());
      const priceHit =
        /([0-9]{1,3}(?:,[0-9]{3})+)\s*원/.test(bodyText) ||
        /([$€£]\s?[0-9][0-9,\.]*|[0-9][0-9,\.]*\s?(USD|EUR|GBP))/i.test(bodyText);

      return {
        available: nameHit,
        info: {
          source: label,
          submittedText: searchKeyword,
          resultUrl,
          searchKeyword,
          productName,
          ...searchInfo,
          nameHit,
          priceHit,
        },
      };
    };

    // 1) Try on homepage
    for (const kw of keywords) {
      const first = await probe("homepage", kw);
      if (first?.info) lastInfo = first.info;
      if (first?.info) probeHistory.push({ round: 1, ...(first.info as Record<string, unknown>) });
      console.log("[searchform] homepage_probe", {
        homepageUrl,
        searchKeyword: kw,
        productName,
        available: first?.available ?? null,
        hasInfo: !!first?.info,
      });
      if (first?.available) return first;
    }

    // 2) If both keywords failed, retry once with wait interval.
    for (const kw of keywords) {
      await page.waitForTimeout(2000);
      const second = await probe("homepage_retry", kw);
      if (second?.info) lastInfo = second.info;
      if (second?.info)
        probeHistory.push({ round: 2, ...(second.info as Record<string, unknown>) });
      console.log("[searchform] homepage_retry_probe", {
        homepageUrl,
        searchKeyword: kw,
        productName,
        available: second?.available ?? null,
        hasInfo: !!second?.info,
      });
      if (second?.available) return second;
    }

    return {
      available: false,
      info: {
        source: "homepage",
        reason: "all_probe_failed",
        homepageUrl,
        productName,
        attempts: probeHistory,
        ...(lastInfo ?? {}),
      } as Record<string, unknown>,
    };
  } catch {
    return { available: false, info: null };
  } finally {
    await context.close();
    await browser.close();
  }
}

type SearchFormProductItem = {
  url: string;
  productName: string;
  listPrice: string;
  salePrice: string;
  imageSrc: string;
  score: number;
  reason: string;
  keywordUsed: string;
};

type SearchFormProductsDebug = {
  stage: string;
  reason?: string;
  confirmedUrl: string;
  keyword?: string;
  attempts?: Array<{
    url: string;
    keyword?: string;
    pageText: string;
    networkText: string;
  }>;
};

function hasPriorityKeywordMatch(
  text: string,
  keywords: string[],
) {
  const normalizedText = (text || "").toLowerCase().replace(/\s+/g, "");
  if (!normalizedText) return false;
  for (const kw of keywords) {
    const normalizedKw = (kw || "").toLowerCase().replace(/\s+/g, "");
    if (!normalizedKw) continue;
    if (normalizedText.includes(normalizedKw)) return true;
  }
  return false;
}

function pickSearchFormConfirmedUrl(
  info: Record<string, unknown> | null | undefined,
) {
  if (!info) return null;
  const resultUrl = typeof info.resultUrl === "string" ? info.resultUrl.trim() : "";
  if (resultUrl) return resultUrl;
  const action = typeof info.action === "string" ? info.action.trim() : "";
  return action || null;
}

async function collectSearchFormProducts(
  confirmedUrl: string,
  searchKeywords: string[],
  fallbackKeyword: string,
) {
  const keywords = Array.from(
    new Set(
      searchKeywords
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  );
  if (keywords.length === 0 && fallbackKeyword.trim()) {
    keywords.push(fallbackKeyword.trim());
  }
  if (keywords.length === 0) {
    return {
      items: [] as SearchFormProductItem[],
      debug: {
        stage: "search_form_products",
        reason: "no_keywords",
        confirmedUrl,
      } as SearchFormProductsDebug,
    };
  }

  const attempts: Array<{
    url: string;
    keyword: string;
    pageText: string;
    networkText: string;
    candidateProducts: Array<{
      detailUrl: string;
      thumbCandidates: string[];
      cardText: string;
    }>;
  }> = [];
  const base = new URL(confirmedUrl);
  const paramNames = ["q", "keyword", "search", "kwrd"];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  try {
    const page = await context.newPage();
    for (const kw of keywords) {
      const urls = new Set<string>();
      urls.add(confirmedUrl);
      for (const p of paramNames) {
        const u = new URL(base.toString());
        u.searchParams.set(p, kw);
        urls.add(u.toString());
      }

      for (const u of Array.from(urls).slice(0, 3)) {
        const networkChunks: string[] = [];
        const onResponse = async (response: any) => {
          try {
            const resUrl = response.url();
            if (!/^https?:/i.test(resUrl)) return;
            const lower = resUrl.toLowerCase();
            const looksRelevant =
              lower.includes("search") ||
              lower.includes("query") ||
              lower.includes("product") ||
              lower.includes("goods") ||
              lower.includes("graphql") ||
              lower.includes("api");
            if (!looksRelevant) return;

            const contentType = (response.headers()["content-type"] || "").toLowerCase();
            if (
              !contentType.includes("json") &&
              !contentType.includes("text") &&
              !contentType.includes("javascript")
            ) {
              return;
            }

            const body = await response.text();
            const compact = body.replace(/\s+/g, " ").trim();
            if (!compact) return;
            networkChunks.push(
              `URL=${resUrl}\nBODY=${compact.slice(0, 1200)}`,
            );
          } catch {
            // ignore
          }
        };

        page.on("response", onResponse);
        try {
          await page.goto(u, { waitUntil: "domcontentloaded", timeout: 15000 });
          await page.waitForTimeout(1200);
          const candidateProducts = await page.evaluate(() => {
            const toAbs = (href: string) => {
              try {
                return new URL(href, window.location.href).toString();
              } catch {
                return "";
              }
            };
            const looksLikeDetail = (href: string) => {
              const lower = href.toLowerCase();
              return (
                lower.includes("/product") ||
                lower.includes("/products") ||
                lower.includes("/item") ||
                lower.includes("/goods") ||
                lower.includes("product_no=") ||
                lower.includes("goodsno=") ||
                lower.includes("itemid=")
              );
            };
            const pickImage = (root: Element | null) => {
              if (!root) return "";
              const img = root.querySelector("img");
              if (!img) return "";
              const src =
                img.getAttribute("src") ||
                img.getAttribute("data-src") ||
                img.getAttribute("data-original") ||
                "";
              if (src) return toAbs(src);
              const srcset = img.getAttribute("srcset") || "";
              if (srcset) {
                const first = srcset.split(",")[0]?.trim().split(" ")[0] || "";
                return first ? toAbs(first) : "";
              }
              return "";
            };

            const anchors = Array.from(document.querySelectorAll("a[href]"))
              .map((a) => {
                const href = (a as HTMLAnchorElement).getAttribute("href") || "";
                const detailUrl = toAbs(href);
                const card =
                  a.closest("li, article, .item, .card, .product, div") ||
                  a.parentElement;
                const thumb = pickImage(card) || pickImage(a);
                const cardText = (card?.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 400);
                return { detailUrl, thumb, cardText };
              })
              .filter((x) => x.detailUrl && looksLikeDetail(x.detailUrl));

            const map = new Map<
              string,
              { detailUrl: string; thumbCandidates: string[]; cardText: string }
            >();
            for (const a of anchors) {
              const prev = map.get(a.detailUrl);
              if (!prev) {
                map.set(a.detailUrl, {
                  detailUrl: a.detailUrl,
                  thumbCandidates: a.thumb ? [a.thumb] : [],
                  cardText: a.cardText,
                });
              } else {
                if (a.thumb && !prev.thumbCandidates.includes(a.thumb)) {
                  prev.thumbCandidates.push(a.thumb);
                }
                if (!prev.cardText && a.cardText) prev.cardText = a.cardText;
              }
            }
            return Array.from(map.values()).slice(0, 30);
          });
          const pageText = await page.evaluate(() => {
            const main =
              document.querySelector("main")?.textContent ||
              document.querySelector("#container")?.textContent ||
              document.body?.textContent ||
              "";
            return main.replace(/\s+/g, " ").trim().slice(0, 8000);
          });
          const networkText = networkChunks.join("\n---\n").slice(0, 10000);
          if (!pageText && !networkText) continue;
          attempts.push({
            url: u,
            keyword: kw,
            pageText,
            networkText,
            candidateProducts,
          });
        } catch {
          // ignore
        } finally {
          page.off("response", onResponse);
        }
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (attempts.length === 0) {
    return {
      items: [] as SearchFormProductItem[],
      debug: {
        stage: "search_form_products",
        reason: "no_attempt_text",
        confirmedUrl,
      } as SearchFormProductsDebug,
    };
  }

  const parsedProducts = await parseSearchFormProductsWithGemini(
    fallbackKeyword,
    confirmedUrl,
    attempts,
    keywords,
  );

  const collected = parsedProducts
    .map((item) => {
      const productName = (item.productName || "").trim();
      const listPrice = (item.listPrice || "").trim();
      const salePrice = (item.salePrice || "").trim();
      const imageSrc = (item.imageSrc || "").trim();
      if (!productName || (!listPrice && !salePrice)) return null;
      const url = (() => {
        const raw = (item.url || "").trim();
        if (!raw) return "";
        try {
          return new URL(raw, confirmedUrl).toString();
        } catch {
          return raw;
        }
      })();

      return {
        url,
        productName,
        listPrice,
        salePrice,
        imageSrc,
        score: 0,
        reason: (item.reason || "search_form_text_parse") + (url ? "" : " | detail_url_not_resolved"),
        keywordUsed: keywords[0] || fallbackKeyword,
      } as SearchFormProductItem;
    })
    .filter((v): v is SearchFormProductItem => Boolean(v))
    .map((item) => {
      const haystack = `${item.productName} ${item.url} ${item.reason}`;
      return {
        ...item,
        score: hasPriorityKeywordMatch(haystack, keywords) ? 10 : 0,
      };
    })
    .sort((a, b) => b.score - a.score);

  const sliced = collected.slice(0, 10);

  return {
    items: sliced,
    debug: {
      stage: "search_form_products",
      reason: sliced.length > 0 ? "ok" : "no_products_after_parse",
      confirmedUrl,
      keyword: fallbackKeyword,
      attempts: attempts.map((a) => ({
        url: a.url,
        keyword: a.keyword,
        pageText: (a.pageText || "").slice(0, 3000),
        networkText: (a.networkText || "").slice(0, 3000),
      })),
    } as SearchFormProductsDebug,
  };
}

export async function POST(request: Request) {
  let debugBrand = "";
  let debugProductName = "";
  try {
    const tStart = Date.now();
    const body = await request.json();
    const brand = typeof body?.brand === "string" ? body.brand.trim() : "";
    const productNameRaw =
      typeof body?.product_name === "string" ? body.product_name.trim() : "";
    const productName =
      productNameRaw.split(",")[0]?.trim() || productNameRaw;
    debugBrand = brand;
    debugProductName = productNameRaw;
    const productNameEn =
      typeof body?.product_name_en === "string"
        ? body.product_name_en.trim()
        : typeof body?.product_name_english === "string"
          ? body.product_name_english.trim()
          : "";
    const keyword = `${brand} ${productName}`.trim();

    if (!brand || !productNameRaw) {
      return Response.json(
        { error: "brand and product_name are required" },
        { status: 400 },
      );
    }

    const t0 = Date.now();
    const items = await fetchOfficialSiteCandidates(keyword);
    console.log("[timing] serpapi_ms", Date.now() - t0);

    const t1 = Date.now();
    const verified = await verifyOfficialSiteWithGemini(
      brand,
      productName,
      productNameEn,
      items,
    );
    console.log("[timing] gemini_verify_ms", Date.now() - t1);
    const sourceUrl = verified.officialUrl ?? items[0]?.link ?? null;

    const candidatePool = items
      .map((item) => ({
        url: item.link ?? "",
        score:
          scoreProductUrl(item.link ?? "") +
          scoreKeywordMatch(item.link ?? "", keyword) +
          scoreKeywordText(item.snippet ?? "", keyword),
      }))
      .filter((item) => item.url)
      .slice(0, 5);

    const officialDetailUrl =
      verified.officialDetailUrl ||
      candidatePool
        .filter((item) => item.score >= MIN_PRODUCT_SCORE)
        .sort((a, b) => b.score - a.score)[0]?.url ||
      null;

    const t3 = Date.now();
    const candidateSignals: ProductSignals[] = [];
    const detailItem = items.find((item) => item.link === officialDetailUrl);
    if (officialDetailUrl) {
      const snippetText = detailItem?.snippet ?? "";
      const titleText = detailItem?.title ?? "";
      candidateSignals.push({
        url: officialDetailUrl,
        text: snippetText,
        priceBlockText: snippetText,
        titleBlockText: titleText,
        priceLines: snippetText,
        currencyHint: "",
        imageSrc: "",
        productName: titleText,
        listPrice: "",
        salePrice: "",
        score: 0,
      });
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

      const corrected = await parseProductInfoWithGemini(
        keyword,
        [candidate],
        "fill",
      );
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

      parsedCandidates.push(finalCandidate);
    }
    console.log("[timing] gemini_price_ms", Date.now() - t4);

    const parsedInfo = parsedCandidates[0] ?? null;

    const t5 = Date.now();
    const k0 = (verified.productKeywords?.[0] ?? "").trim();
    const k1 = (verified.productKeywords?.[1] ?? "").trim();
    const k2 = (verified.productKeywords?.[2] ?? "").trim();
    const searchKeywords = (() => {
      const picked: string[] = [];
      if (k0) picked.push(k0);
      if (k2 && k2.toLowerCase() !== k0.toLowerCase()) {
        picked.push(k2);
      } else if (k1 && k1.toLowerCase() !== k0.toLowerCase()) {
        picked.push(k1);
      }
      return picked.slice(0, 2);
    })();
    const searchFormInfo = sourceUrl
      ? await checkSearchFormAvailability(sourceUrl, searchKeywords, productName)
      : null;
    let searchFormConfirmedUrl = pickSearchFormConfirmedUrl(searchFormInfo?.info);
    const searchFormResult = searchFormConfirmedUrl
      ? await collectSearchFormProducts(
          searchFormConfirmedUrl,
          searchKeywords,
          productName,
        )
      : {
          items: [] as SearchFormProductItem[],
          debug: null as SearchFormProductsDebug | null,
        };
    const searchFormProductList = searchFormResult.items;
    if (searchFormConfirmedUrl && searchFormProductList.length > 0) {
      const firstResolved = searchFormProductList.find((item) => (item.url || "").trim());
      const pickedKeyword = (firstResolved?.keywordUsed || "").trim().toLowerCase();
      const attemptUrlByPickedKeyword =
        pickedKeyword && searchFormResult.debug?.attempts
          ? searchFormResult.debug.attempts.find(
              (a) => (a.keyword || "").trim().toLowerCase() === pickedKeyword,
            )?.url
          : null;
      if (attemptUrlByPickedKeyword) {
        searchFormConfirmedUrl = attemptUrlByPickedKeyword;
      }
    }
    const errorLog = searchFormResult.debug ?? {
      stage: "search_form_products",
      reason: searchFormConfirmedUrl
        ? searchFormProductList.length > 0
          ? "ok"
          : "empty_result"
        : "search_form_not_confirmed",
      confirmedUrl: searchFormConfirmedUrl ?? "",
      keyword: productName,
      attempts: [],
    };
    const targetTable =
      process.env.DISCOVERY_TABLE || "site_metadata_discovery";
    const { data, error } = await supabaseAdmin
      .from(targetTable)
      .insert({
        brand,
        product_name_input: productNameRaw,
        keyword,
        official_homepage: verified.officialUrl ?? null,
        business_alias: verified.businessAlias ?? null,
        official_en: verified.officialEn ?? null,
        official_ko: verified.officialKo ?? null,
        product_keyword1: verified.productKeywords?.[0] ?? null,
        product_keyword2: verified.productKeywords?.[1] ?? null,
        product_keyword3: verified.productKeywords?.[2] ?? null,
        search_form_available: searchFormInfo?.available ?? null,
        search_form_info: searchFormInfo?.info ?? null,
        search_form_confirmed_url: searchFormConfirmedUrl,
        search_form_product_list:
          searchFormProductList.length > 0 ? searchFormProductList : null,
        error_log: errorLog,
        source_url: sourceUrl,
        detail_url: parsedInfo?.url || officialDetailUrl || null,
        product_name: parsedInfo?.productName || null,
        list_price: parsedInfo?.listPrice || null,
        sale_price: parsedInfo?.salePrice || null,
        candidates: candidatePool,
        raw_data: {
          stage: "grounded_search",
          query: `${keyword} 공식 홈페이지`,
          items,
          grounded: verified,
        },
        raw_data_parse: {
          stage: "parse",
          parsed: parsedInfo,
          parsed_candidates: parsedCandidates,
        },
        status: "done",
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
    console.error("[collect_error]", {
      message,
      brand: debugBrand,
      product_name: debugProductName,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
