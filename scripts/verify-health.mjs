const base = (process.env.QUOTEPRO_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const url = `${base}/health`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`Health check failed: ${res.status} ${url}`);
  process.exit(1);
}
const body = await res.json();
if (!body?.ok) {
  console.error("Health body missing ok:true", body);
  process.exit(1);
}
console.log(`OK ${url}`);
