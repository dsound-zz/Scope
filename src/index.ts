import { StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AgentState } from "./state.js";
import {
  callModel,
  checkAppliedHistoryNode,
  scrapeNode,
  matchNode,
  researchContactNode,
  draftOutreachNode,
  shouldContinue,
} from "./nodes.js";
import { toolNode } from "./tools.js";
import { HumanMessage } from "@langchain/core/messages";
import * as dotenv from "dotenv";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: SQLite checkpointer
// Re-runs on the same day (same thread_id) resume from last state —
// so already-processed job IDs are never re-queued.
// ─────────────────────────────────────────────────────────────────────────────
const checkpointer = SqliteSaver.fromConnString("./scope_memory.db");

// ─────────────────────────────────────────────────────────────────────────────
// Graph topology
//
//  __start__
//      ↓
//    agent  ←──────────────────────────────┐
//      ↓ (conditional)                     │
//   tools ─────────────────────────────────┘  (loop until no more tool calls)
//      ↓ (no tool calls → continue)
//  checkAppliedHistory   (Sheets guardrail — flags already-applied companies)
//      ↓
//    scrape              (stealth Playwright — grabs job description text)
//      ↓
//   matcher              (Gemini scoring ≥ 7/10 → populates matchedJobs)
//      ↓
//  researchContact       (Tavily + Gemini → finds EM/Recruiter names + LinkedIn)
//      ↓
//  draftOutreach         (Gemini drafts → Nodemailer digest email to you)
//      ↓
//  __end__
// ─────────────────────────────────────────────────────────────────────────────
const workflow = new StateGraph(AgentState)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addNode("checkAppliedHistory", checkAppliedHistoryNode)
  .addNode("scrape", scrapeNode)
  .addNode("matcher", matchNode)
  .addNode("researchContact", researchContactNode)
  .addNode("draftOutreach", draftOutreachNode)

  .addEdge("__start__", "agent")

  // After the agent responds: loop through tools or proceed to guardrail
  .addConditionalEdges("agent", shouldContinue, {
    tools: "tools",
    checkAppliedHistory: "checkAppliedHistory",
  })

  // Tool results always return to the agent for next reasoning step
  .addEdge("tools", "agent")

  // Linear pipeline after the guardrail
  .addEdge("checkAppliedHistory", "scrape")
  .addEdge("scrape", "matcher")
  .addEdge("matcher", "researchContact")
  .addEdge("researchContact", "draftOutreach")
  .addEdge("draftOutreach", "__end__");

export const app = workflow.compile({ checkpointer });

// ─────────────────────────────────────────────────────────────────────────────
// Direct execution (for ad-hoc / development use)
// For daily scheduled runs, use: npx ts-node src/cron.ts
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("--- SCOPE Agent — Dev Run ---");

  const threadId = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const input = {
    messages: [
      new HumanMessage(
        "Find 5 TypeScript / AI full-stack engineering jobs. Location MUST be strictly NYC area OR remote within the United States. Posted in the last 7 days. Focus on companies building LLMs, RAG pipelines, or AI agents. Include the full job URL for each."
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