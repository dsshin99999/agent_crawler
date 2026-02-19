"use client";

import { useState } from "react";

type ParsedCandidate = {
  url?: string;
  productName?: string;
  listPrice?: string;
  salePrice?: string;
  score?: number;
  reason?: string;
};

type SearchFormProductItem = {
  url?: string;
  productName?: string;
  listPrice?: string;
  salePrice?: string;
  imageSrc?: string;
  score?: number;
  reason?: string;
  keywordUsed?: string;
};

export default function Home() {
  const [brand, setBrand] = useState("");
  const [productName, setProductName] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string>("");
  const [result, setResult] = useState<any>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage("");

    try {
      const res = await fetch("/api/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, product_name: productName }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? "Request failed");
      }

      if (data?.id) {
        const resultRes = await fetch(`/api/products?id=${data.id}`);
        const resultJson = await resultRes.json();
        if (resultRes.ok) {
          setResult(resultJson.data);
        }
      }

      setStatus("done");
      setMessage("요청이 저장되었습니다. 결과를 확인하세요.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setStatus("error");
      setMessage(msg);
    }
  }

  const parsedCandidates: ParsedCandidate[] =
    result?.raw_data_parse?.parsed_candidates ?? [];
  const searchFormProducts: SearchFormProductItem[] = (
    result?.search_form_product_list ?? []
  ).slice(0, 5);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
        <header className="flex flex-col gap-3">
          <p className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            상품 정보 수집 에이전트
          </p>
          <h1 className="text-3xl font-semibold leading-tight">
            브랜드와 제품명을 입력하면 공식몰과 제품 정보를 확인할 수 있습니다.
          </h1>
        </header>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm font-medium">
            브랜드
            <input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="예: 비에날"
              className="h-12 rounded-lg border border-zinc-200 bg-white px-4 text-base shadow-sm focus:border-zinc-400 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium">
            제품명
            <input
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="예: 비에날씬"
              className="h-12 rounded-lg border border-zinc-200 bg-white px-4 text-base shadow-sm focus:border-zinc-400 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={!brand || !productName || status === "loading"}
            className="h-12 rounded-lg bg-black text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {status === "loading" ? "요청 중..." : "수집 시작"}
          </button>
        </form>

        {message ? (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              status === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {message}
          </div>
        ) : null}

        {status === "loading" ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            결과가 나오기까지 최대 30초가 소요될수 있습니다.
          </div>
        ) : null}

        {result ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">수집 결과</h2>

            {parsedCandidates.length > 0 ? (
              <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-900">
                    검색 결과 상위 3개
                  </h3>
                  {result.official_homepage ? (
                    <a
                      className="inline-flex items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                      href={result.official_homepage}
                      target="_blank"
                      rel="noreferrer"
                    >
                      공식몰 열기
                    </a>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-4">
                  {parsedCandidates.map((item, index) => (
                    <div
                      key={`${item.url ?? index}`}
                      className="rounded-lg border border-zinc-200 bg-zinc-50 p-4"
                    >
                      <div className="text-sm text-zinc-500">#{index + 1}</div>
                      <div className="mt-2 text-sm text-zinc-700">
                        <div>
                          <span className="font-medium text-zinc-900">
                            제품명:
                          </span>{" "}
                          {item.productName || "-"}
                        </div>
                        <div>
                          <span className="font-medium text-zinc-900">정가:</span>{" "}
                          {item.listPrice || "-"}
                        </div>
                        {item.salePrice && item.salePrice !== item.listPrice ? (
                          <div>
                            <span className="font-medium text-zinc-900">
                              할인가:
                            </span>{" "}
                            {item.salePrice}
                          </div>
                        ) : null}
                        <div className="mt-2">
                          {item.url ? (
                            <a
                              className="inline-flex items-center justify-center rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              상세페이지 열기
                            </a>
                          ) : (
                            "-"
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-2 text-sm text-zinc-700">
                <div>
                  <span className="font-medium text-zinc-900">제품명:</span>{" "}
                  {result.product_name || result.product_name_input || "-"}
                </div>
                <div>
                  <span className="font-medium text-zinc-900">정가:</span>{" "}
                  {result.list_price || "-"}
                </div>
                {result.sale_price && result.sale_price !== result.list_price ? (
                  <div>
                    <span className="font-medium text-zinc-900">할인가:</span>{" "}
                    {result.sale_price}
                  </div>
                ) : null}
                <div>
                  <span className="font-medium text-zinc-900">공식몰:</span>{" "}
                  {result.official_homepage ? (
                    <a
                      className="inline-flex items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                      href={result.official_homepage}
                      target="_blank"
                      rel="noreferrer"
                    >
                      공식몰 열기
                    </a>
                  ) : (
                    "-"
                  )}
                </div>
                <div>
                  <span className="font-medium text-zinc-900">상세페이지:</span>{" "}
                  {result.detail_url ? (
                    <a
                      className="inline-flex items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                      href={result.detail_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      상세페이지 열기
                    </a>
                  ) : (
                    "-"
                  )}
                </div>
                <div>
                  <span className="font-medium text-zinc-900">수집 시각:</span>{" "}
                  {result.created_at || "-"}
                </div>
                <div>
                  <span className="font-medium text-zinc-900">
                    검색폼 사용 가능:
                  </span>{" "}
                  {result.search_form_available === true
                    ? "가능"
                    : result.search_form_available === false
                      ? "불가"
                      : "-"}
                </div>
              </div>
            )}

            {searchFormProducts.length > 0 ? (
              <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-900">
                    검색폼 기준 제품 목록 (최대 5개)
                  </h3>
                  {result.search_form_confirmed_url ? (
                    <a
                      className="inline-flex items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                      href={result.search_form_confirmed_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      검색 결과 페이지 열기
                    </a>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-4">
                  {searchFormProducts.map((item, index) => (
                    <div
                      key={`${item.url ?? item.productName ?? index}`}
                      className="rounded-lg border border-zinc-200 bg-zinc-50 p-4"
                    >
                      <div className="text-sm text-zinc-500">#{index + 1}</div>
                      {item.imageSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.imageSrc}
                          alt={item.productName || `product-${index + 1}`}
                          className="mt-2 h-24 w-24 rounded-md border border-zinc-200 object-cover bg-white"
                        />
                      ) : null}
                      <div className="mt-2 text-sm text-zinc-700">
                        <div>
                          <span className="font-medium text-zinc-900">
                            제품명:
                          </span>{" "}
                          {item.productName || "-"}
                        </div>
                        <div>
                          <span className="font-medium text-zinc-900">정가:</span>{" "}
                          {item.listPrice || "-"}
                        </div>
                        {item.salePrice && item.salePrice !== item.listPrice ? (
                          <div>
                            <span className="font-medium text-zinc-900">
                              할인가:
                            </span>{" "}
                            {item.salePrice}
                          </div>
                        ) : null}
                        {item.keywordUsed ? (
                          <div>
                            <span className="font-medium text-zinc-900">
                              검색어:
                            </span>{" "}
                            {item.keywordUsed}
                          </div>
                        ) : null}
                        <div className="mt-2">
                          {item.url ? (
                            <a
                              className="inline-flex items-center justify-center rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              상세페이지 열기
                            </a>
                          ) : (
                            "-"
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <details className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
              <summary className="cursor-pointer text-sm font-medium text-zinc-800">
                수집 로그 보기 1 (전체)
              </summary>
              <pre className="mt-3 whitespace-pre-wrap break-words">
                {JSON.stringify(result.raw_data, null, 2)}
              </pre>
            </details>

            <details className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
              <summary className="cursor-pointer text-sm font-medium text-zinc-800">
                수집 로그 보기 2 (score 3 이상만)
              </summary>
              <pre className="mt-3 whitespace-pre-wrap break-words">
                {JSON.stringify(
                  result.raw_data_parse
                    ? {
                        ...result.raw_data_parse,
                        parsed_candidates:
                          result.raw_data_parse?.parsed_candidates?.filter(
                            (item: any) => item?.score >= 3,
                          ) ?? [],
                      }
                    : result.raw_data_parse,
                  null,
                  2,
                )}
              </pre>
            </details>
          </section>
        ) : null}
      </main>
    </div>
  );
}
