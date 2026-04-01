/**
 * SCOPE — Daily Cron Runner
 *
 * This is the entry point for scheduled/automated execution.
 * Thread ID is set to today's date (YYYY-MM-DD) so that:
 *   - Re-runs on the same day resume from the last checkpoint state
 *   - Each new day starts a fresh run automatically
 *
 * Run manually:   npx ts-node src/cron.ts
 * GitHub Actions: see .github/workflows/daily_scope.yml
 */
import { app } from "./index.js";
import { HumanMessage } from "@langchain/core/messages";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

async function runDailySearch(): Promise<void> {
  // ── Environment Validation ──────────────────────────────────────────────────
  const required = [
    "GOOGLE_API_KEY",
    "TAVILY_API_KEY",
    "GMAIL_USER",
    "GMAIL_PASS",
    "GOOGLE_SHEET_ID",
  ];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error("╔══════════════════════════════════════════╗");
    console.error("║  ❌ ERROR: Missing Configuration Keys   ║");
    console.error("╚══════════════════════════════════════════╝");
    console.error(`The following environment variables are required but missing:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
    console.error("\nCheck your .env file or GitHub Secrets.");
    process.exit(1);
  }

  const threadId = new Date().toISOString().split("T")[0]; // e.g. "2026-04-01"
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  console.log("╔══════════════════════════════════════════╗");
  console.log("║        SCOPE — Daily Job Search          ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`Thread: ${threadId}`);
  console.log(`Start:  ${now}\n`);

  const input = {
    messages: [
      new HumanMessage(
        `Find 5 TypeScript / AI full-stack engineering jobs. Location MUST be strictly NYC area OR remote within the United States. 
Posted in the last 7 days. Focus on companies building with LLMs, RAG pipelines, 
or AI agents. Include the full public URL for each job posting.`
      ),
    ],
    candidateProfile: `
      Name: Demian Sims
      Role: Full-Stack Engineer & AI Architect

      Key Projects:
        - SIGNAL: Production RAG pipeline for UAP documents (LangChain, vector search, TypeScript)
        - TRACE: Behavioral AI / agentic study framework
        - NOWHERE: LLM-powered email parsing pipeline
        - LINR: AI-assisted liner note inference app

      Recent Experience:
        - NEC Laboratories America — AI-assisted research workflows
        - Avandar Labs — DuckDB-WASM in-browser analytics platform

      Core Stack: TypeScript, Node.js, Express, React, Next.js, React Native,
                  LangChain, LangGraph, Playwright, Supabase, AWS, PostgreSQL
    `,
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
          console.log(`          Contact: ${contact.contactName} — ${contact.linkedInUrl ?? "no LinkedIn"}`);
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
