import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { TavilySearch } from "@langchain/tavily";
import { AgentState } from "./state.js";
import { AIMessage } from "@langchain/core/messages";
import { chromium } from "playwright";
import { google } from "googleapis";
import * as nodemailer from "nodemailer";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { MatchedJob, ContactResult } from "./types.js";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Sheet ID for the applied/rejection tracker */
const REJECTION_SHEET_ID = "1ip0NQkpQi3ovk2OeNy9aPbRpeIEs7ZNRwz5EtHDvZgU";

/** Approved job board domains — all other sites are ignored */
const APPROVED_DOMAINS = [
  "linkedin.com",
  "indeed.com",
  "builtinnyc.com",
  "jobs.google.com",
];

/** Domains that should never be scraped (error pages, auth redirects, API consoles) */
const SCRAPE_BLOCKLIST = [
  "console.developers.google.com",
  "console.cloud.google.com",
  "accounts.google.com",
  "googleapis.com",
  "oauth2.googleapis.com",
];

// ─────────────────────────────────────────────────────────────────────────────
// Shared LLM instance (no tools bound — used for scoring/drafting)
// ─────────────────────────────────────────────────────────────────────────────
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
  apiVersion: "v1beta",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getGoogleAuth(): InstanceType<typeof google.auth.GoogleAuth> | null {
  let credentials: Record<string, unknown>;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      console.warn("[SCOPE] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — skipping Sheets guardrail.");
      return null;
    }
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_PATH) {
    try {
      credentials = JSON.parse(
        fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH, "utf8")
      );
    } catch {
      console.warn("[SCOPE] Could not read GOOGLE_SERVICE_ACCOUNT_PATH — skipping Sheets guardrail.");
      return null;
    }
  } else {
    const defaultPath = path.resolve(process.cwd(), "service-account.json");
    if (fs.existsSync(defaultPath)) {
      try {
        credentials = JSON.parse(fs.readFileSync(defaultPath, "utf8"));
        console.log(`[SCOPE] Loaded service account from ${defaultPath}`);
      } catch {
        console.warn("[SCOPE] Could not parse ./service-account.json — skipping Sheets guardrail.");
        return null;
      }
    } else {
      console.warn("[SCOPE] No Google service account configured — skipping Sheets guardrail.");
      return null;
    }
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

function buildDigestHtml(
  drafts: Array<{ job: MatchedJob; contact?: ContactResult; emailBody: string }>,
  date: Date
): string {
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const items = drafts
    .map(
      (d, i) => `
      <div style="background:#f9fafb;border-left:4px solid #6366f1;padding:20px;margin:20px 0;border-radius:6px;">
        <h2 style="margin:0 0 6px;color:#1e1b4b;font-size:18px;">
          ${i + 1}. ${d.job.title} @ <span style="color:#6366f1;">${d.job.company}</span>
          <span style="font-size:14px;color:#059669;margin-left:8px;">Score: ${d.job.score}/10</span>
        </h2>
        <p style="margin:4px 0;color:#6b7280;font-size:13px;">&#x1F4A1; ${d.job.matchReason}</p>
        ${
          d.contact?.contactName
            ? `<p style="margin:6px 0;font-size:13px;">
                &#x1F464; Contact: <strong>${d.contact.contactName}</strong> (${d.contact.contactRole ?? "Engineering"})
                ${d.contact.linkedInUrl ? `&#x2014; <a href="${d.contact.linkedInUrl}" style="color:#6366f1;">LinkedIn</a>` : ""}
               </p>`
            : ""
        }
        ${
          d.job.url
            ? `<p style="margin:4px 0;font-size:13px;">&#x1F517; <a href="${d.job.url}" style="color:#6366f1;">View Job Posting</a></p>`
            : ""
        }
        <hr style="margin:14px 0;border:none;border-top:1px solid #e5e7eb;">
        <h3 style="margin:0 0 8px;color:#374151;font-size:15px;">&#x2709;&#xFE0F; Draft Outreach Email</h3>
        <div style="background:white;padding:16px;border-radius:4px;font-family:ui-monospace,monospace;font-size:13px;white-space:pre-wrap;border:1px solid #e5e7eb;line-height:1.6;">${d.emailBody
          .trim()
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</div>
        <p style="margin:10px 0 0;font-size:12px;color:#9ca3af;">Review, personalize, and send manually if you approve.</p>
      </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:32px;color:#111827;background:#fff;">
  <div style="border-bottom:2px solid #6366f1;padding-bottom:16px;margin-bottom:24px;">
    <h1 style="color:#4f46e5;margin:0 0 6px;font-size:24px;">SCOPE Daily Report</h1>
    <p style="color:#6b7280;margin:0;">${dateStr} &middot; ${drafts.length} high-scoring match${drafts.length !== 1 ? "es" : ""} ready for your review</p>
  </div>
  ${items}
  <p style="color:#d1d5db;font-size:11px;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px;">
    Generated by SCOPE Autonomous Job Agent &middot; Do not reply to this message.
  </p>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node 1: searchNode — Controlled Tavily queries scoped to approved job boards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs 4 deterministic Tavily queries — one per approved job board — each
 * hard-coded to "New York City" so location drift is impossible.
 * Results are concatenated into one message and passed downstream.
 */
export const searchNode = async (_state: typeof AgentState.State) => {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    const msg = "[Search] TAVILY_API_KEY missing — cannot run job search.";
    console.error(`[SCOPE] ${msg}`);
    return { messages: [new AIMessage(msg)] };
  }

  // Each query targets exactly one approved site and hard-pins New York City.
  // Broader roles (software/frontend/fullstack engineer) require TypeScript to filter signal from noise.
  const queries: string[] = [
    'site:linkedin.com/jobs "New York City" ("AI engineer" OR (TypeScript AND ("software engineer" OR "frontend engineer" OR "full stack engineer" OR "fullstack engineer")) OR LangChain OR "machine learning engineer")',
    'site:indeed.com "New York, NY" ("AI engineer" OR (TypeScript AND ("software engineer" OR "frontend engineer" OR "full stack engineer" OR "fullstack engineer")) OR LangChain)',
    'site:builtinnyc.com ("AI engineer" OR (TypeScript AND ("software engineer" OR "frontend engineer" OR "full stack engineer" OR "fullstack engineer")) OR LangChain OR "machine learning")',
    'site:jobs.google.com "New York City" ("AI engineer" OR (TypeScript AND ("software engineer" OR "frontend engineer" OR "full stack engineer" OR "fullstack engineer")) OR LangChain)',
  ];

  const tavily = new TavilySearch({
    maxResults: 5,
    includeDomains: APPROVED_DOMAINS,
  });

  const allResults: string[] = [];

  for (const query of queries) {
    try {
      console.log(`[SCOPE] Searching: ${query.slice(0, 80)}…`);
      const result = await tavily.invoke({ query });
      const text = typeof result === "string" ? result : JSON.stringify(result);
      allResults.push(`--- Query: ${query}\n${text}`);
    } catch (err: any) {
      console.warn(`[SCOPE] Search query failed: ${err.message ?? err}`);
    }
  }

  if (allResults.length === 0) {
    return {
      messages: [
        new AIMessage("[Search] All queries failed. Check TAVILY_API_KEY and network connectivity."),
      ],
    };
  }

  const combined = allResults.join("\n\n");
  console.log(
    `[SCOPE] Search complete — ${allResults.length}/${queries.length} queries succeeded.`
  );
  return {
    messages: [
      new AIMessage(
        `[Search] Job listings from LinkedIn, Indeed, BuiltInNYC, and Google Jobs (NYC only):\n\n${combined}`
      ),
    ],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 2: checkAppliedHistoryNode — Google Sheets guardrail
// Reads Column A of "By Company" tab in the rejection tracker sheet.
// ─────────────────────────────────────────────────────────────────────────────
export const checkAppliedHistoryNode = async (_state: typeof AgentState.State) => {
  const auth = getGoogleAuth();

  if (!auth) {
    return {
      skippedCompanies: [] as string[],
      messages: [
        new AIMessage("[Sheets guardrail] No credentials configured — skipping duplicate check."),
      ],
    };
  }

  try {
    const sheets = google.sheets({ version: "v4", auth });

    // Column A only — company names are the source of truth for rejections
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: REJECTION_SHEET_ID,
      range: "By Company!A:A",
    });

    const rows = response.data.values ?? [];

    // Skip header row (row 0); read only column A (index 0)
    const appliedCompanies: string[] = [
      ...new Set(
        rows
          .slice(1)
          .map((row: string[]) => row[0]?.toString().toLowerCase().trim())
          .filter(Boolean)
      ),
    ];

    const msg =
      appliedCompanies.length > 0
        ? `[Sheets guardrail] Already applied/rejected at ${appliedCompanies.length} companies. Skipping: ${appliedCompanies.slice(0, 8).join(", ")}${appliedCompanies.length > 8 ? "…" : ""}`
        : "[Sheets guardrail] No previously-applied companies found — all leads are eligible.";

    console.log(`[SCOPE] ${msg}`);
    return { skippedCompanies: appliedCompanies, messages: [new AIMessage(msg)] };
  } catch (err: any) {
    const msg = `[Sheets guardrail] Could not read sheet: ${err.message ?? err}. Continuing without filter.`;
    console.warn(`[SCOPE] ${msg}`);
    return { skippedCompanies: [] as string[], messages: [new AIMessage(msg)] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 3: scrapeNode — Stealth Playwright scraper (multi-URL, per-URL try-catch)
// ─────────────────────────────────────────────────────────────────────────────

const STEALTH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const scrapeNode = async (state: typeof AgentState.State) => {
  // Collect all URLs mentioned in any message so far
  const allContent = state.messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    )
    .join("\n");

  const rawUrls = [...allContent.matchAll(/https?:\/\/[^\s)"<\]]+/g)].map(
    (m) => m[0].replace(/[.,;]+$/, "") // strip trailing punctuation
  );

  const eligibleUrls = [
    ...new Set(
      rawUrls.filter(
        (url) =>
          APPROVED_DOMAINS.some((d) => url.includes(d)) &&
          !SCRAPE_BLOCKLIST.some((d) => url.includes(d))
      )
    ),
  ].slice(0, 5); // cap at 5 to avoid excessive run time

  if (eligibleUrls.length === 0) {
    return {
      messages: [
        new AIMessage(
          "[Scrape] No eligible job URLs found in search results — proceeding with snippets only."
        ),
      ],
    };
  }

  console.log(`[SCOPE] Scraping ${eligibleUrls.length} URLs…`);

  const browser = await chromium.launch({ headless: true });

  let context: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  try {
    context = await browser.newContext({
      userAgent: STEALTH_UA,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Google Chrome";v="124", "Not:A-Brand";v="8", "Chromium";v="124"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "Upgrade-Insecure-Requests": "1",
      },
    });

    // Remove all Playwright fingerprints before any page script runs
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // @ts-ignore
      delete window.__playwright;
      // @ts-ignore
      delete window.__pw_manual;
    });
  } catch (err: any) {
    console.warn(`[SCOPE] Failed to create browser context: ${err.message}`);
    await browser.close();
    return {
      messages: [new AIMessage("[Scrape] Browser context creation failed — proceeding with snippets.")],
    };
  }

  const scrapedPages: string[] = [];

  for (const url of eligibleUrls) {
    const page = await context.newPage();
    try {
      console.log(`[SCOPE] Scraping: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const bodyText = await page.innerText("body");
      const cleanText = bodyText.replace(/\s+/g, " ").slice(0, 4_000);
      scrapedPages.push(`URL: ${url}\n${cleanText}`);
      console.log(`[SCOPE]  → ${cleanText.length} chars`);
    } catch (err: any) {
      console.warn(`[SCOPE] Scrape failed for ${url}: ${err.message}`);
      scrapedPages.push(`URL: ${url}\n[Scrape failed — using search snippet only]`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});

  const combined = scrapedPages.join("\n\n===\n\n");
  return {
    messages: [new AIMessage(`SCRAPED JOB PAGES:\n\n${combined}`)],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 4: matchNode — Score jobs and populate matchedJobs state
// ─────────────────────────────────────────────────────────────────────────────
export const matchNode = async (state: typeof AgentState.State) => {
  const skipped = state.skippedCompanies ?? [];

  const jobLeadsText = state.messages
    .filter((m: any) => {
      const role = m?.role ?? (m?.constructor?.name === "AIMessage" ? "assistant" : "");
      return role === "assistant" || role === "tool";
    })
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    )
    .filter((c: string) => c.trim().length > 20)
    .join("\n\n---\n\n");

  if (!jobLeadsText) {
    console.warn("[SCOPE] matchNode: No job lead content found in messages.");
    return { messages: [new AIMessage("[Match] No job content to score.")], matchedJobs: [] };
  }

  const skipNote =
    skipped.length > 0
      ? `IMPORTANT: Skip any jobs from these companies (already applied or rejected): ${skipped.join(", ")}.`
      : "";

  const prompt = `You are a technical recruiter scoring job-to-candidate fit.

CANDIDATE PROFILE:
${state.candidateProfile}

${skipNote}

JOB LEADS (from search results and scraped pages):
${jobLeadsText.slice(0, 14_000)}

Score each eligible job 1–10 based on alignment with the candidate. Scoring criteria:
- LLM orchestration / RAG pipelines (SIGNAL project — LangChain, TypeScript, vector search)
- Behavioral / agentic AI systems (TRACE project)
- Email parsing with LLMs (NOWHERE project)
- Full-stack TypeScript / React / React Native / Node.js / Express (Olivie, Rethink)
- AI-assisted research tooling (NEC Laboratories America, 2026)
- LOCATION FILTER: MUST be New York City metro area OR US-remote. Penalize non-NYC, non-remote roles to ≤3.
- SITE FILTER: MUST come from LinkedIn, Indeed, BuiltInNYC, or Google Jobs. Ignore all others.

Output EXACTLY this JSON block first (raw JSON, no markdown fences):

MATCHES_JSON_START
[
  {
    "id": "unique-slug-derived-from-url",
    "title": "Job Title",
    "company": "Company Name",
    "url": "https://...",
    "score": 8,
    "matchReason": "One sentence: why this is a strong fit."
  }
]
MATCHES_JSON_END

Then write your full narrative analysis below.`;

  const response = await llm.invoke([
    { role: "system", content: prompt },
    { role: "user", content: "Score and rank these roles." },
  ]);

  const content = typeof response.content === "string" ? response.content : "";

  let matchedJobs: MatchedJob[] = [];
  const jsonMatch = content.match(/MATCHES_JSON_START\s*([\s\S]*?)\s*MATCHES_JSON_END/);
  if (jsonMatch) {
    try {
      const parsed: MatchedJob[] = JSON.parse(jsonMatch[1]);
      matchedJobs = parsed.filter((j) => (j.score ?? 0) >= 7);
      console.log(
        `[SCOPE] matchNode: ${parsed.length} jobs scored, ${matchedJobs.length} qualify (≥7/10).`
      );
    } catch (e) {
      console.warn("[SCOPE] matchNode: Failed to parse MATCHES_JSON:", e);
    }
  } else {
    console.warn("[SCOPE] matchNode: No MATCHES_JSON block found in response.");
  }

  return { messages: [response], matchedJobs };
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 5: researchContactNode — Tavily contact discovery
// ─────────────────────────────────────────────────────────────────────────────
export const researchContactNode = async (state: typeof AgentState.State) => {
  const { matchedJobs = [], skippedCompanies = [] } = state;

  if (matchedJobs.length === 0) {
    return {
      contacts: [] as ContactResult[],
      messages: [
        new AIMessage("[Contact Research] No high-scoring matches to research — skipping."),
      ],
    };
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    const msg = "[Contact Research] TAVILY_API_KEY missing — skipping.";
    console.warn(`[SCOPE] ${msg}`);
    return { contacts: [] as ContactResult[], messages: [new AIMessage(msg)] };
  }

  const tavilySearch = new TavilySearch({ maxResults: 3 });
  const contacts: ContactResult[] = [];

  for (const job of matchedJobs) {
    if (
      skippedCompanies.some((c) =>
        c.toLowerCase().includes(job.company.toLowerCase())
      )
    ) {
      console.log(`[SCOPE] Skipping contact research for ${job.company} (already applied).`);
      continue;
    }

    try {
      console.log(`[SCOPE] Researching contacts at ${job.company}…`);
      const query = `${job.company} "Engineering Manager" OR "Technical Recruiter" OR "Head of Engineering" site:linkedin.com/in`;
      const rawResults = await tavilySearch.invoke({ query });
      const resultsText =
        typeof rawResults === "string" ? rawResults : JSON.stringify(rawResults);

      const parseResponse = await llm.invoke([
        {
          role: "user",
          content: `Extract the most relevant Engineering Manager or Recruiter at "${job.company}" from the text below.
Respond with ONLY a JSON object (no markdown):
{"name": "Full Name or null", "role": "their job title or null", "linkedInUrl": "https://linkedin.com/in/... or null"}

TEXT:
${resultsText.slice(0, 4_000)}`,
        },
      ]);

      const parseContent =
        typeof parseResponse.content === "string" ? parseResponse.content : "";
      const match = parseContent.match(/\{[\s\S]*?\}/);

      if (match) {
        const parsed = JSON.parse(match[0]);
        contacts.push({
          company: job.company,
          jobTitle: job.title,
          contactName: parsed.name ?? null,
          contactRole: parsed.role ?? null,
          linkedInUrl: parsed.linkedInUrl ?? null,
        });
        console.log(
          `[SCOPE]  → Found: ${parsed.name ?? "unknown"} (${parsed.role ?? "?"}) at ${job.company}`
        );
      }
    } catch (err: any) {
      console.warn(`[SCOPE] Contact research failed for ${job.company}: ${err.message}`);
      contacts.push({ company: job.company, jobTitle: job.title });
    }
  }

  const summary = `[Contact Research] Found contacts for ${contacts.filter((c) => c.contactName).length} / ${matchedJobs.length} companies.`;
  console.log(`[SCOPE] ${summary}`);
  return { contacts, messages: [new AIMessage(summary)] };
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 6: draftOutreachNode — Gemini drafts + Nodemailer digest email
// ─────────────────────────────────────────────────────────────────────────────
export const draftOutreachNode = async (state: typeof AgentState.State) => {
  const { matchedJobs = [], contacts = [] } = state;

  if (matchedJobs.length === 0) {
    return {
      messages: [new AIMessage("[Draft Outreach] No matched jobs — nothing to draft.")],
    };
  }

  const drafts: Array<{ job: MatchedJob; contact?: ContactResult; emailBody: string }> = [];

  for (const job of matchedJobs) {
    const contact = contacts.find(
      (c) => c.company.toLowerCase() === job.company.toLowerCase()
    );
    const greeting = contact?.contactName
      ? `Hi ${contact.contactName.split(" ")[0]},`
      : "Hi there,";

    const draftPrompt = `Write a short cold outreach email (120–150 words) for a software engineer applying to the ${job.title} role at ${job.company}.

Candidate: Demian Sims — Full-Stack Engineer & AI Architect
Key projects:
- SIGNAL: Production RAG pipeline for UAP (Unidentified Aerial Phenomena) documents (LangChain, TypeScript, vector search)
- TRACE: Behavioral AI / agent study framework (agent orchestration, TypeScript)
- NOWHERE: LLM-powered email parsing and triage pipeline
Recent experience: NEC Laboratories America 2026 (AI-assisted research tooling), Olivie (React, React Native, Express), Rethink (React, React Native, Express)
Stack: TypeScript, Node.js, Express, React, Next.js, React Native, LangChain, LangGraph, Playwright, Supabase, PostgreSQL, AWS

Why this role is a strong fit: ${job.matchReason}
${contact?.contactName ? `Contact name: ${contact.contactName} (${contact.contactRole ?? ""})` : ""}

Start with: "${greeting}"
Tone: confident, sincere, direct — no buzzwords or sycophancy.
End with a single low-pressure CTA (e.g., "Happy to share more if this seems like a fit.").
Do NOT include a subject line.`;

    try {
      const response = await llm.invoke([{ role: "user", content: draftPrompt }]);
      const emailBody = typeof response.content === "string" ? response.content : "";
      drafts.push({ job, contact, emailBody });
      console.log(`[SCOPE] Drafted email for ${job.company}`);
    } catch (err: any) {
      console.warn(`[SCOPE] Draft failed for ${job.company}: ${err.message}`);
      drafts.push({ job, contact, emailBody: "[Draft generation failed — write manually.]" });
    }
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.warn("[SCOPE] GMAIL_USER or GMAIL_PASS not set — skipping email send.");
    return {
      messages: [
        new AIMessage(
          `[Draft Outreach] Generated ${drafts.length} draft(s) but GMAIL credentials not configured. Set GMAIL_USER and GMAIL_PASS (App Password).`
        ),
      ],
    };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: (process.env.GMAIL_PASS ?? "").replace(/\s+/g, ""),
    },
  });

  const dateLabel = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const subject = `SCOPE: ${drafts.length} Job Match${drafts.length !== 1 ? "es" : ""} for Your Review — ${dateLabel}`;

  await transporter.sendMail({
    from: `"SCOPE Agent" <${process.env.GMAIL_USER}>`,
    to: process.env.GMAIL_USER,
    subject,
    html: buildDigestHtml(drafts, new Date()),
  });

  const successMsg = `[Draft Outreach] Digest email sent to ${process.env.GMAIL_USER} with ${drafts.length} draft(s).`;
  console.log(`[SCOPE] ${successMsg}`);
  return { messages: [new AIMessage(successMsg)] };
};
