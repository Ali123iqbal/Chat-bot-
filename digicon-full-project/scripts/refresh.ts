import { refreshDataset } from "../src/lib/data/source";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run refresh -- path/to/members.csv");
  process.exit(2);
}
const res = refreshDataset(file);
if (res.ok) {
  console.log(`Refreshed: ${res.memberCount} accepted members loaded.`);
  if (res.ignoredColumns.length) console.log(`Ignored columns (not imported): ${res.ignoredColumns.join(", ")}`);
} else {
  console.error("Refresh FAILED. The previous dataset is still active.\n");
  for (const e of res.errors.slice(0, 50)) console.error(" - " + e);
  if (res.errors.length > 50) console.error(` ...and ${res.errors.length - 50} more`);
  process.exit(1);
}
