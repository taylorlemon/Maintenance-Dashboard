// Helpers shared by the server functions now that there's more than one
// company (see docs/archive/MULTI-COMPANY-PLAN.md and supabase/multi-company/). Every
// caller passes a client made with the service-role key.

// deno-lint-ignore no-explicit-any
type Client = any;

export type CompanyAsana = { token: string | null; capexProjectGid: string | null };

// Looks up (once per request) which Asana key and CapEx board a company uses —
// see 02-company-asana-settings.sql for where the key can live.
export function companyAsanaLookup(admin: Client) {
  const cache = new Map<string, Promise<CompanyAsana>>();
  async function load(companyId: string): Promise<CompanyAsana> {
    const { data: co, error } = await admin.from("companies")
      .select("asana_token_secret, asana_capex_project_gid").eq("id", companyId).single();
    if (error || !co) return { token: null, capexProjectGid: null };
    let token: string | null = null;
    if (co.asana_token_secret === "env:ASANA_TOKEN") {
      token = Deno.env.get("ASANA_TOKEN") ?? null;
    } else if (co.asana_token_secret) {
      const { data } = await admin.rpc("company_asana_token", { c: companyId });
      token = data ?? null;
    }
    return { token, capexProjectGid: co.asana_capex_project_gid };
  }
  return (companyId: string): Promise<CompanyAsana> => {
    if (!cache.has(companyId)) cache.set(companyId, load(companyId));
    return cache.get(companyId)!;
  };
}

// Companies the Executive has paused (see 04-pause-and-remove.sql): they get no
// emails and their Asana isn't read.
export async function pausedCompanyIds(admin: Client): Promise<Set<string>> {
  const { data, error } = await admin.from("companies").select("id").not("paused_at", "is", null);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((c: { id: string }) => c.id));
}

// Every company's Admins' email addresses, keyed by company id. Each company's
// emails go to its own Admins only, and a paused company's Admins get none.
// onlyTo (for test sends) keeps just that one address, wherever it appears.
export async function adminEmailsByCompany(admin: Client, onlyTo?: string): Promise<Map<string, string[]>> {
  const { data, error } = await admin.from("profiles").select("email, company_id").eq("role", "admin");
  if (error) throw new Error(error.message);
  const paused = await pausedCompanyIds(admin);
  const byCompany = new Map<string, string[]>();
  for (const p of data ?? []) {
    if (!p.email || !p.company_id || paused.has(p.company_id)) continue;
    if (onlyTo && p.email.toLowerCase() !== onlyTo.toLowerCase()) continue;
    byCompany.set(p.company_id, [...(byCompany.get(p.company_id) ?? []), p.email]);
  }
  return byCompany;
}

// "YYYY-MM-DD" for the calendar day an instant falls on in a building's own
// time zone (properties.time_zone).
const formatters = new Map<string, Intl.DateTimeFormat>();
export function dayIn(timeZone: string, when: string | Date = new Date()): string {
  const tz = timeZone || "America/Denver";
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  return formatters.get(tz)!.format(typeof when === "string" ? new Date(when) : when);
}
