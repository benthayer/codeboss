import { getAllBossifications, type Bossification } from "../db.js";

// =============================================================================
// History Command
// =============================================================================

export async function history(): Promise<void> {
  const bossifications = getAllBossifications();

  if (bossifications.length === 0) {
    console.log("No bossifications recorded yet.");
    return;
  }

  console.log(`📜 Bossification History (${bossifications.length} entries)\n`);

  for (const b of bossifications) {
    const date = new Date(b.createdAt * 1000).toISOString().slice(0, 19).replace("T", " ");
    console.log(`${date}`);
    console.log(`  Tree:     ${b.treeHash.slice(0, 12)}...`);
    console.log(`  Author:   ${b.authorName} <${b.authorEmail}>`);
    console.log(`  Template: ${b.template}`);
    console.log();
  }
}

