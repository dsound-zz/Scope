import { TavilySearch } from "@langchain/tavily";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import * as dotenv from "dotenv";

dotenv.config();

// 1. Define the Tools
export const tools = [new TavilySearch({ maxResults: 3 })];

// 2. Define the Tool Node
export const toolNode = new ToolNode(tools);
