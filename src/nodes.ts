import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AgentState } from "./state";
import { tools } from "./tools";
import { AIMessage } from "@langchain/core/messages";
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import * as dotenv from "dotenv";

dotenv.config();

// 2. Initialize the Brain
const model = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    apiKey: process.env.GOOGLE_API_KEY,
    apiVersion: "v1beta",
}).bindTools(tools);

export const callModel = async (state: typeof AgentState.State) => {
    const systemPrompt = { 
        role: "system", 
        content: "You are a professional recruiter. After using tools to find jobs, list them clearly and ensure you always include the full HTTP URL for each job so I can scrape more details." 
    };
    const response = await model.invoke([systemPrompt, ...state.messages]);
    return { messages: [response] };
};

export const scrapeNode = async (state: typeof AgentState.State) => {
    // 1. Get the URL from the last message (Found by Tavily)
    const lastMessage = state.messages[state.messages.length - 1];
    
    // Ensure content is a string
    const content = typeof lastMessage.content === 'string' 
        ? lastMessage.content 
        : JSON.stringify(lastMessage.content);

    const urlMatch = content.match(/https?:\/\/[^\s)]+/);
    
    if (!urlMatch) {
        return { 
            messages: [{ role: "assistant", content: "No URL found to scrape." }] 
        };
    }
    
    const url = urlMatch[0];

    try {
        // 2. Fetch and Parse using Playwright (Handles JavaScript)
        const browser = await chromium.launch();
        const page = await browser.newPage();
        
        // Wait for network to be idle to ensure JS rendering is complete
        await page.goto(url, { waitUntil: 'networkidle' });
        const html = await page.content();
        await browser.close();

        const $ = cheerio.load(html);
        
        // 3. Extract the "Meat" (Remove scripts, nav, footer)
        $('script, style, nav, footer').remove();
        const cleanText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);

        return { 
            messages: [{ 
                role: "system", 
                content: `FULL JOB DESCRIPTION FROM ${url}:\n\n${cleanText}` 
            }] 
        };
    } catch (error: any) {
        return {
            messages: [{ role: "assistant", content: `Failed to scrape ${url} using Playwright: ${error.message}` }]
        };
    }
};

export const matchNode = async (state: typeof AgentState.State) => {
    // ... your matching logic ...
    const lastMessage = state.messages[state.messages.length - 1].content;

    const prompt = `You are a technical recruiter. Compare these jobs to the candidate's background:
    ${state.candidateProfile}
    
    Jobs found:
    ${lastMessage}
    
    Rate each job 1-10 based on their experience with RAG (Signal), behavioral AI (Trace), and email parsing (NowHere). Explain why.`;

    const response = await model.invoke([
        { role: "system", content: prompt },
        { role: "user", content: "Analyze these matches." }
    ]);

    return { messages: [response] };
};

export const shouldContinue = (state: typeof AgentState.State) => {
    const { messages } = state;
    const lastMessage = messages[messages.length - 1];

    // Check if the last message has tool calls
    if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
        return "tools";
    }
    return "__end__";
};