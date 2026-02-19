import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  const targetTable =
    process.env.DISCOVERY_TABLE || "site_metadata_discovery";
  const { data, error } = await supabaseAdmin
    .from(targetTable)
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ data, product: data });
}
