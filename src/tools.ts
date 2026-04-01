import { TavilySearch } from "@langchain/tavily";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Factory function to get initialized tools.
 * Using a factory prevents the app from crashing on import if the TAVILY_API_KEY is missing.
 */
export function getTools() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("[SCOPE] TAVILY_API_KEY not found — Tavily search features will be disabled.");
    return [];
  }
  return [new TavilySearch({ maxResults: 3 })];
}

// Default tools for backward compatibility if needed, but getTools() is preferred
export const tools = getTools();

// 2. Define the Tool Node
/**
 * Custom tool node wrapper.
 * We manually wrap the ToolNode to ensure it receives a plain object containing 'messages',
 * which resolves the validation error when using Annotation.Root in modern LangGraph.js.
 */
export const toolNode = async (state: any) => {
  const activeTools = getTools();
  const node = new ToolNode(activeTools);
  return await node.invoke({ messages: state.messages });
};
