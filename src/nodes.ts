import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AgentState } from "./state";
import { tools } from "./tools";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { chromium } from "playwright";
import { TavilySearch } from "@langchain/tavily";
import { google } from "googleapis";
import * as nodemailer from "nodemailer";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { MatchedJob, ContactResult } from "./types";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Shared LLM instance
// ─────────────────────────────────────────────────────────────────────────────
const model = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
  apiVersion: "v1beta",
}).bindTools(tools);

// Unbound model for tasks that don't need tool calling
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
  apiVersion: "v1beta",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve Google service-account credentials.
 *
 * Resolution order:
 *  1. GOOGLE_SERVICE_ACCOUNT_JSON   – raw JSON string in env
 *  2. GOOGLE_SERVICE_ACCOUNT_PATH   – path to a JSON key file
 *  3. ./service-account.json        – file placed at the project root (default)
 */
function getGoogleAuth(): InstanceType<typeof google.auth.GoogleAuth> | null {
  let credentials: any;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      console.warn("[SCOPE] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — skipping Sheets guardrail.");
      return null;
    }
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_PATH) {
    try {
      credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH, "utf8"));
    } catch {
      console.warn("[SCOPE] Could not read GOOGLE_SERVICE_ACCOUNT_PATH — skipping Sheets guardrail.");
      return null;
    }
  } else {
    // Default: look for service-account.json in the project root
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

/** Build the HTML body for the digest email */
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
        <p style="margin:4px 0;color:#6b7280;font-size:13px;">💡 ${d.job.matchReason}</p>
        ${
          d.contact?.contactName
            ? `<p style="margin:6px 0;font-size:13px;">
                👤 Contact: <strong>${d.contact.contactName}</strong> (${d.contact.contactRole || "Engineering"})
                ${d.contact.linkedInUrl ? `— <a href="${d.contact.linkedInUrl}" style="color:#6366f1;">LinkedIn</a>` : ""}
               </p>`
            : ""
        }
        ${
          d.job.url
            ? `<p style="margin:4px 0;font-size:13px;">🔗 <a href="${d.job.url}" style="color:#6366f1;">View Job Posting</a></p>`
            : ""
        }
        <hr style="margin:14px 0;border:none;border-top:1px solid #e5e7eb;">
        <h3 style="margin:0 0 8px;color:#374151;font-size:15px;">✉️ Draft Outreach Email</h3>
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
    <h1 style="color:#4f46e5;margin:0 0 6px;font-size:24px;">🎯 SCOPE Daily Report</h1>
    <p style="color:#6b7280;margin:0;">${dateStr} · ${drafts.length} high-scoring match${drafts.length !== 1 ? "es" : ""} ready for your review</p>
  </div>
  ${items}
  <p style="color:#d1d5db;font-size:11px;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px;">
    Generated by SCOPE Autonomous Job Agent · Do not reply to this message.
  </p>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node 1: callModel — Main LLM orchestrator
// ─────────────────────────────────────────────────────────────────────────────
export const callModel = async (state: typeof AgentState.State) => {
  const systemPrompt = new SystemMessage(
    "You are a professional recruiter assistant. After using tools to find jobs, list them clearly and always include the full HTTP URL for each job so it can be scraped for details."
  );

  // Strip any accumulated system messages from previous node runs —
  // LangChain requires the system message to be at index 0 only.
  const safeMessages = state.messages.filter(
    (m: any) => !(m instanceof SystemMessage) && m?.role !== "system"
  );

  const response = await model.invoke([systemPrompt, ...safeMessages]);
  return { messages: [response] };
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 2: checkAppliedHistoryNode — Google Sheets guardrail
// ─────────────────────────────────────────────────────────────────────────────
export const checkAppliedHistoryNode = async (state: typeof AgentState.State) => {
  const auth = getGoogleAuth();

  if (!auth) {
    // Graceful no-op — continue without filtering
    return {
      skippedCompanies: [],
      messages: [new AIMessage("[Sheets guardrail] No credentials configured — skipping duplicate check.")],
    };
  }

  try {
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      // Reads all columns from the applied/rejected tracking sheet
      range: "By Company!A:Z",
    });

    const rows = response.data.values ?? [];
    // Normalize: flatten all cells, lower-case, de-dupe, drop header row
    const appliedCompanies = [
      ...new Set(
        rows
          .slice(1) // skip header
          .flat()
          .map((c: string) => c?.toString().toLowerCase().trim())
          .filter(Boolean)
      ),
    ] as string[];

    const msg =
      appliedCompanies.length > 0
        ? `[Sheets guardrail] Already applied to ${appliedCompanies.length} companies. Will skip matches from: ${appliedCompanies.slice(0, 8).join(", ")}${appliedCompanies.length > 8 ? "…" : ""}`
        : "[Sheets guardrail] No previously-applied companies found — all leads are eligible.";

    console.log(`[SCOPE] ${msg}`);
    return {
      skippedCompanies: appliedCompanies,
      messages: [new AIMessage(msg)],
    };
  } catch (err: any) {
    const msg = `[Sheets guardrail] Could not read sheet: ${err.message ?? err}. Continuing without filter.`;
    console.warn(`[SCOPE] ${msg}`);
    return {
      skippedCompanies: [],
      messages: [new AIMessage(msg)],
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 3: scrapeNode — Stealth Playwright scraper
// ─────────────────────────────────────────────────────────────────────────────
// Domains that should never be scraped (error pages, auth redirects, API consoles, etc.)
const SCRAPE_BLOCKLIST = [
  "console.developers.google.com",
  "console.cloud.google.com",
  "accounts.google.com",
  "googleapis.com",
  "oauth2.googleapis.com",
];

export const scrapeNode = async (state: typeof AgentState.State) => {
  const lastMessage = state.messages[state.messages.length - 1].content;
  const urlMatch = (lastMessage as string).match(/https?:\/\/[^\s)"<]+/);
  if (!urlMatch) {
    return { messages: [{ role: "assistant", content: "No URL found to scrape." }] };
  }

  const url = urlMatch[0];

  // Guard: skip non-job URLs that leaked from error messages
  if (SCRAPE_BLOCKLIST.some((domain) => url.includes(domain))) {
    console.warn(`[SCOPE] Blocked scrape of non-job URL: ${url}`);
    return { messages: [new AIMessage(`[Scrape] Skipped blocked domain: ${url}`)] };
  }

  console.log(`[SCOPE] Scraping: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    // Stealth: realistic fingerprint
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
  });

  // Stealth: remove webdriver flag before any page script runs
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-ignore
    delete window.__playwright;
    // @ts-ignore
    delete window.__pw_manual;
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const bodyText = await page.innerText("body");
    const cleanText = bodyText.replace(/\s+/g, " ").slice(0, 10000);
    await browser.close();
    console.log(`[SCOPE] Scraped ${cleanText.length} chars from ${url}`);
    return { messages: [new AIMessage(`PAGE CONTENT:\n\n${cleanText}`)] };
  } catch (error: any) {
    await browser.close();
    console.warn(`[SCOPE] Scrape failed for ${url}: ${error.message}`);
    return {
      messages: [{ role: "assistant", content: `Scrape failed for ${url}. Proceeding with search snippet.` }],
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Node 4: matchNode — Score jobs and populate matchedJobs state
// ─────────────────────────────────────────────────────────────────────────────
export const matchNode = async (state: typeof AgentState.State) => {
  const skipped = state.skippedCompanies ?? [];

  // Collect job lead content from ALL messages — agent responses, tool outputs, and scraped pages.
  // This ensures Tavily results are included even when scraping partially fails.
  const jobLeadsText = state.messages
    .filter((m: any) => {
      const role = m?.role ?? (m?.constructor?.name === "AIMessage" ? "assistant" : "");
      return role === "assistant" || role === "tool";
    })
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .filter((c: string) => c.trim().length > 20)
    .join("\n\n---\n\n");

  if (!jobLeadsText) {
    console.warn("[SCOPE] matchNode: No job lead content found in messages.");
    return { messages: [new AIMessage("[Match] No job content to score.")], matchedJobs: [] };
  }

  const skipNote =
    skipped.length > 0
      ? `IMPORTANT: Skip any jobs from these companies (already applied): ${skipped.join(", ")}.`
      : "";

  const prompt = `You are a technical recruiter scoring job-to-candidate fit.

CANDIDATE PROFILE:
${state.candidateProfile}

${skipNote}

JOB LEADS (from search results and scraped pages):
${jobLeadsText.slice(0, 12000)}

Score each eligible job 1–10 based on alignment with:
- RAG pipelines & LLM orchestration (SIGNAL project)
- Behavioral / agentic AI (TRACE project)
- Email parsing with LLMs (NOWHERE project)
- Full-stack TypeScript / React / Node.js

Output EXACTLY this JSON block first (no markdown fences needed, use raw JSON), then your narrative:

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

  // Parse the structured block
  let matchedJobs: MatchedJob[] = [];
  const jsonMatch = content.match(/MATCHES_JSON_START\s*([\s\S]*?)\s*MATCHES_JSON_END/);
  if (jsonMatch) {
    try {
      const parsed: any[] = JSON.parse(jsonMatch[1]);
      matchedJobs = parsed.filter((j) => (j.score ?? 0) >= 7) as MatchedJob[];
      console.log(`[SCOPE] matchNode: ${parsed.length} jobs scored, ${matchedJobs.length} qualify (≥7/10).`);
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
      contacts: [],
      messages: [new AIMessage("[Contact Research] No high-scoring matches to research — skipping.")],
    };
  }

  // TavilySearch reads TAVILY_API_KEY from process.env automatically
  const tavilySearch = new TavilySearch({ maxResults: 3 });

  const contacts: ContactResult[] = [];

  for (const job of matchedJobs) {
    // Skip already-applied companies
    if (
      skippedCompanies.some((c) => c.toLowerCase().includes(job.company.toLowerCase()))
    ) {
      console.log(`[SCOPE] Skipping contact research for ${job.company} (already applied).`);
      continue;
    }

    try {
      console.log(`[SCOPE] Researching contacts at ${job.company}…`);
      const query = `${job.company} "Engineering Manager" OR "Technical Recruiter" OR "Head of Engineering" site:linkedin.com/in`;
      const rawResults = await tavilySearch.invoke({ query });
      const resultsText = typeof rawResults === "string" ? rawResults : JSON.stringify(rawResults);

      // Ask Gemini to extract structured contact from the Tavily blurb
      const parseResponse = await llm.invoke([
        {
          role: "user",
          content: `Extract the most relevant Engineering Manager or Recruiter at "${job.company}" from the text below.
Respond with ONLY a JSON object (no markdown):
{"name": "Full Name or null", "role": "their job title or null", "linkedInUrl": "https://linkedin.com/in/... or null"}

TEXT:
${resultsText.slice(0, 4000)}`,
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
      // Still add a stub so draftOutreach doesn't miss this company
      contacts.push({ company: job.company, jobTitle: job.title });
    }
  }

  const summary = `[Contact Research] Found contacts for ${contacts.filter((c) => c.contactName).length} / ${matchedJobs.length} companies.`;
  console.log(`[SCOPE] ${summary}`);

  return {
    contacts,
    messages: [new AIMessage(summary)],
  };
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
    const contact = contacts.find((c) => c.company.toLowerCase() === job.company.toLowerCase());
    const greeting = contact?.contactName
      ? `Hi ${contact.contactName.split(" ")[0]},`
      : "Hi there,";

    const draftPrompt = `Write a short cold outreach email (120–150 words) for a software engineer applying to the ${job.title} role at ${job.company}.

Candidate: Demian Sims — Full-Stack Engineer & AI Architect
Key projects:
- SIGNAL: Production RAG pipeline (LangChain, vector search, TypeScript)
- TRACE: Behavioral AI / agent study framework
- NOWHERE: LLM-powered email parsing pipeline  
- LINR: AI-assisted liner note inference app
Recent experience: NEC Laboratories America (AI-assisted workflows), Avandar Labs (DuckDB-WASM analytics)
Stack: TypeScript, Node.js, React/Next.js, LangChain, LangGraph, Playwright, Supabase, AWS

Why this role is a strong fit: ${job.matchReason}
${contact?.contactName ? `Contact name: ${contact.contactName} (${contact.contactRole})` : ""}

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

  // ── Send digest email ───────────────────────────────────────────────────────
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.warn("[SCOPE] GMAIL_USER or GMAIL_PASS not set — skipping email send.");
    return {
      messages: [
        new AIMessage(`[Draft Outreach] Generated ${drafts.length} draft(s) but GMAIL credentials not configured. Set GMAIL_USER and GMAIL_PASS (App Password).`),
      ],
    };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      // Google displays App Passwords with spaces — strip them before passing to SMTP
      pass: (process.env.GMAIL_PASS ?? "").replace(/\s+/g, ""),
    },
  });

  const dateLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const subject = `🎯 SCOPE: ${drafts.length} Job Match${drafts.length !== 1 ? "es" : ""} for Your Review — ${dateLabel}`;

  await transporter.sendMail({
    from: `"SCOPE Agent" <${process.env.GMAIL_USER}>`,
    to: process.env.GMAIL_USER,
    subject,
    html: buildDigestHtml(drafts, new Date()),
  });

  const successMsg = `[Draft Outreach] ✅ Digest email sent to ${process.env.GMAIL_USER} with ${drafts.length} draft(s).`;
  console.log(`[SCOPE] ${successMsg}`);

  return {
    messages: [new AIMessage(successMsg)],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Conditional edge helper
// ─────────────────────────────────────────────────────────────────────────────
export const shouldContinue = (state: typeof AgentState.State) => {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
    return "tools";
  }
  return "checkAppliedHistory";
};