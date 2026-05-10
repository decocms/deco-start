import { findPageByPath, registerSectionsSync } from "@decocms/start/cms";
import { cacheHeaders } from "@decocms/start/sdk/cacheHeaders";

export default async function SmokePage() {
  const types = [typeof findPageByPath, typeof registerSectionsSync, typeof cacheHeaders];
  return <pre>{JSON.stringify({ types }, null, 2)}</pre>;
}
