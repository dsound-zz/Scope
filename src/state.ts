import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { JobLead, MatchedJob, ContactResult } from "./types.js";

import { BaseMessage } from "@langchain/core/messages";

export const AgentState = Annotation.Root({
  // ── Core message history ─────────────────────────────────────
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // ── Candidate identity ────────────────────────────────────────
  candidateProfile: Annotation<string>(),

  // ── Structured job pipeline ───────────────────────────────────
  /** Raw job leads discovered by Tavily */
  jobs: Annotation<JobLead[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),

  /** Job IDs already processed (persisted via SqliteSaver) */
  processedJobIds: Annotation<string[]>({
    reducer: (x, y) => [...new Set([...(x ?? []), ...(y ?? [])])],
    default: () => [],
  }),

  /** Jobs scoring ≥ 7/10 after matchNode */
  matchedJobs: Annotation<MatchedJob[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),

  /** Contacts discovered for matched companies */
  contacts: Annotation<ContactResult[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),

  /** Companies flagged by the Sheets guardrail (already applied) */
  skippedCompanies: Annotation<string[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
});