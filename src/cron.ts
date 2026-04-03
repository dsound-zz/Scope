/**
 * SCOPE — Daily Cron Runner
 *
 * Entry point for scheduled/automated execution.
 * Thread ID is set to today's date (YYYY-MM-DD) so that:
 *   - Re-runs on the same day resume from the last checkpoint state
 *   - Each new day starts a fresh run automatically
 *
 * Run manually:   npm run cron
 * launchd:        see com.demiansims.scope.plist in the project root
 */
import { app, CANDIDATE_PROFILE } from "./index.js";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";

// ── Load .env from the project root (critical for launchd / "naked" envs) ───
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

async function runDailySearch(): Promise<void> {
  // ── Environment Validation ──────────────────────────────────────────────────
  const required = [
    "GOOGLE_API_KEY",
    "TAVILY_API_KEY",
    "GMAIL_USER",
    "GMAIL_PASS",
  ];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error("╔══════════════════════════════════════════╗");
    console.error("║  ❌ ERROR: Missing Configuration Keys   ║");
    console.error("╚══════════════════════════════════════════╝");
    console.error(
      `The following environment variables are required but missing:\n${missing.map((m) => `  - ${m}`).join("\n")}`
    );
    console.error("\nCheck your .env file or the launchd EnvironmentVariables block.");
    process.exit(1);
  }

  const threadId = new Date().toISOString().split("T")[0]; // e.g. "2026-04-03"
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  console.log("╔══════════════════════════════════════════╗");
  console.log("║        SCOPE — Daily Job Search          ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`Thread: ${threadId}`);
  console.log(`Start:  ${now}\n`);

  const input = {
    messages: [],
    candidateProfile: CANDIDATE_PROFILE,
    skippedCompanies: [],
    processedJobIds: [],
    matchedJobs: [],
    contacts: [],
    jobs: [],
  };

  try {
    const finalState = await app.invoke(input, {
      configurable: { thread_id: threadId },
    });

    const lastMsg = finalState.messages[finalState.messages.length - 1];
    console.log("\n── Final Message ──────────────────────────");
    console.log(lastMsg.content);

    const matched = finalState.matchedJobs ?? [];
    const contacts = finalState.contacts ?? [];

    if (matched.length > 0) {
      console.log(`\n✅ ${matched.length} high-scoring match(es):`);
      matched.forEach((j: any) => {
        const contact = contacts.find((c: any) => c.company === j.company);
        console.log(`  [${j.score}/10] ${j.title} @ ${j.company}`);
        if (contact?.contactName) {
          console.log(
            `          Contact: ${contact.contactName} — ${contact.linkedInUrl ?? "no LinkedIn"}`
          );
        }
      });
    } else {
      console.log("\nℹ️  No jobs scored ≥7/10 today.");
    }

    console.log("\n✅ Run complete. Check your inbox for the digest email.");
  } catch (err: any) {
    console.error("\n❌ SCOPE run failed:", err.message ?? err);
    process.exit(1);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

runDailySearch();
