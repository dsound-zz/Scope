import { StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AgentState } from "./state.js";
import {
  searchNode,
  checkAppliedHistoryNode,
  scrapeNode,
  matchNode,
  researchContactNode,
  draftOutreachNode,
} from "./nodes.js";
import * as dotenv from "dotenv";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: SQLite checkpointer
// Re-runs on the same day (same thread_id) resume from last state —
// so already-processed job IDs are never re-queued.
// ─────────────────────────────────────────────────────────────────────────────
const checkpointer = SqliteSaver.fromConnString("./scope_memory.db");

// ─────────────────────────────────────────────────────────────────────────────
// Graph topology — linear pipeline, no LLM-gated branching
//
//  __start__
//      ↓
//   search              (4 controlled Tavily queries — LinkedIn/Indeed/BuiltInNYC/Google Jobs, NYC-only)
//      ↓
//  checkAppliedHistory  (Sheets guardrail — flags already-applied/rejected companies)
//      ↓
//    scrape             (stealth Playwright — grabs full job description text)
//      ↓
//   matcher             (Gemini scoring ≥7/10 → populates matchedJobs)
//      ↓
//  researchContact      (Tavily + Gemini → finds EM/Recruiter names + LinkedIn)
//      ↓
//  draftOutreach        (Gemini drafts → Nodemailer digest email to you)
//      ↓
//  __end__
// ─────────────────────────────────────────────────────────────────────────────
const workflow = new StateGraph(AgentState)
  .addNode("search", searchNode)
  .addNode("checkAppliedHistory", checkAppliedHistoryNode)
  .addNode("scrape", scrapeNode)
  .addNode("matcher", matchNode)
  .addNode("researchContact", researchContactNode)
  .addNode("draftOutreach", draftOutreachNode)

  .addEdge("__start__", "search")
  .addEdge("search", "checkAppliedHistory")
  .addEdge("checkAppliedHistory", "scrape")
  .addEdge("scrape", "matcher")
  .addEdge("matcher", "researchContact")
  .addEdge("researchContact", "draftOutreach")
  .addEdge("draftOutreach", "__end__");

export const app = workflow.compile({ checkpointer });

// ─────────────────────────────────────────────────────────────────────────────
// Candidate profile — single source of truth used by both dev runs and cron
// ─────────────────────────────────────────────────────────────────────────────
export const CANDIDATE_PROFILE = `
Name: Demian Sims
Role: TypeScript Engineer — Agentic AI, RAG Systems & Frontend

Key Projects:
  - SIGNAL: Production RAG pipeline for UAP (Unidentified Aerial Phenomena) documents
            (LangChain, TypeScript, vector search, embeddings)
  - TRACE:  Behavioral AI / agentic study framework — agent orchestration, TypeScript
  - NOWHERE: LLM-powered email parsing and triage pipeline
  - LINR:  AI-assisted liner note inference app

Recent Experience:
  - NEC Laboratories America (2026) — AI-assisted research workflows and internal tooling
  - Olivie — React, React Native, Express product engineering
  - Rethink — React, React Native, Express engineering

Core Stack: TypeScript, Node.js, LangChain, LangGraph, Playwright,
            React, Next.js, React Native, Express, Supabase, PostgreSQL, AWS
`;

// ─────────────────────────────────────────────────────────────────────────────
// Direct execution (for ad-hoc / development use)
// For daily scheduled runs, use: npm run cron
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("--- SCOPE Agent — Dev Run ---");

  // Dev runs use a full timestamp so each run is independent (no checkpoint replay).
  // Cron runs (cron.ts) still use YYYY-MM-DD so same-day re-runs resume from checkpoint.
  const threadId = new Date().toISOString().replace(/[:.]/g, "-"); // e.g. 2026-04-08T11-30-00-000Z

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
    console.log(`Thread ID: ${threadId}`);
    console.log("Processing… (this may take a minute)\n");

    const finalState = await app.invoke(input, {
      configurable: { thread_id: threadId },
    });

    const lastMessage = finalState.messages[finalState.messages.length - 1];
    console.log("\n--- SCOPE FINAL RESPONSE ---");
    console.log(lastMessage.content);

    if (finalState.matchedJobs?.length) {
      console.log(`\n✅ Matched Jobs (≥7/10):`);
      finalState.matchedJobs.forEach((j: any) =>
        console.log(`  [${j.score}/10] ${j.title} @ ${j.company} — ${j.url}`)
      );
    }
  } catch (error: any) {
    console.error("\n❌ Error:", error.message || error);
    process.exit(1);
  }

  console.log("\n--- Run Finished ---");
}

import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
