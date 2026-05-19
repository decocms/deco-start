/**
 * CMS country name → ISO 3166-1 alpha-2 code mapping.
 *
 * The CMS stores countries as full names ("Brasil", "United States").
 * Cloudflare and other geo providers return ISO codes ("BR", "US").
 * Keys are case-sensitive as authored in the CMS — callers should
 * try both the raw value and a case-normalized lookup.
 */
export const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  // Latin America
  Brasil: "BR", Brazil: "BR",
  Argentina: "AR",
  Chile: "CL",
  Colombia: "CO",
  Mexico: "MX", "México": "MX",
  Peru: "PE", "Perú": "PE",
  Uruguay: "UY",
  Paraguay: "PY",
  Bolivia: "BO",
  Ecuador: "EC",
  Venezuela: "VE",
  "Costa Rica": "CR",
  Panama: "PA", "Panamá": "PA",
  "Dominican Republic": "DO",
  Guatemala: "GT",
  Honduras: "HN",
  "El Salvador": "SV",
  Nicaragua: "NI",
  Cuba: "CU",
  "Puerto Rico": "PR",

  // North America
  "United States": "US", USA: "US", "Estados Unidos": "US",
  Canada: "CA", "Canadá": "CA",

  // Europe
  Spain: "ES", "España": "ES",
  Portugal: "PT",
  Germany: "DE", Alemania: "DE", Deutschland: "DE",
  France: "FR", Francia: "FR",
  Italy: "IT", Italia: "IT",
  "United Kingdom": "GB", UK: "GB",
  Netherlands: "NL",
  Switzerland: "CH",
  Sweden: "SE",
  Norway: "NO",
  Denmark: "DK",
  Finland: "FI",
  Belgium: "BE",
  Austria: "AT",
  Ireland: "IE",
  Turkey: "TR", "Türkiye": "TR",
  Poland: "PL",
  "Czech Republic": "CZ", Czechia: "CZ",
  Romania: "RO",
  Hungary: "HU",
  Greece: "GR",
  Croatia: "HR",

  // Asia & Oceania
  Japan: "JP", "Japón": "JP",
  China: "CN",
  "South Korea": "KR",
  India: "IN",
  Australia: "AU",
  "New Zealand": "NZ",

  // Middle East & Africa
  Israel: "IL",
  "Saudi Arabia": "SA",
  "United Arab Emirates": "AE",
  "South Africa": "ZA",
};

/**
 * Resolve a country name (as stored in CMS) to its ISO code.
 * Tries exact match first, then case-insensitive lookup.
 */
export function resolveCountryCode(name: string): string {
  if (COUNTRY_NAME_TO_CODE[name]) return COUNTRY_NAME_TO_CODE[name];

  const lower = name.toLowerCase();
  for (const [key, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
    if (key.toLowerCase() === lower) return code;
  }

  // Assume it's already an ISO code
  return name.toUpperCase();
}

/**
 * Register an additional country name → ISO code mapping at runtime.
 * Useful for site-specific CMS values not covered by the built-in list.
 */
export function registerCountryMapping(name: string, code: string): void {
  COUNTRY_NAME_TO_CODE[name] = code;
}

/**
 * Register multiple country name → ISO code mappings at once.
 */
export function registerCountryMappings(mappings: Record<string, string>): void {
  Object.assign(COUNTRY_NAME_TO_CODE, mappings);
}
