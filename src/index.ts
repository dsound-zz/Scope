import { StateGraph } from "@langchain/langgraph";
import { AgentState } from "./state";
import { callModel, matchNode, scrapeNode, shouldContinue } from "./nodes";
import { toolNode } from "./tools";
import { HumanMessage } from "@langchain/core/messages";
import * as dotenv from "dotenv";

dotenv.config();

// 4. Wire it up
const workflow = new StateGraph(AgentState)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addNode("scrape", scrapeNode)   // New Node!
    .addNode("matcher", matchNode)

    .addEdge("__start__", "agent")

    .addConditionalEdges("agent", (state) => {
        const lastMessage = state.messages[state.messages.length - 1];
        if (lastMessage.tool_calls?.length) return "tools";
        return "scrape"; // After search is done, go SCRAPE the top result
    })

    .addEdge("tools", "agent")
    .addEdge("scrape", "matcher") // After scraping, go to the MATCHER
    .addEdge("matcher", "__end__");

const app = workflow.compile();

async function main() {
    console.log("--- Starting Agent Test ---");

    // IMPORTANT: ToolNode requires actual Message instances (HumanMessage, etc.)
    const input = {
        messages: [
            new HumanMessage("Find 3 software engineering roles in New York that involve RAG or LLMs. Check for startups specifically.")
        ],
        candidateProfile: "7 years experience in Typescript and Python. Expert in building AI agents (Signal, Trace). Previously worked at NowHere on email parsing pipelines."
    };

    try {
        // Run the graph
        console.log("Processing request...");
        const finalState = await app.invoke(input);
        const lastMessage = finalState.messages[finalState.messages.length - 1];

        console.log("\n--- AGENT FINAL RESPONSE ---");
        console.log(lastMessage.content);
    } catch (error: any) {
        console.error("\n❌ Oops! Something went wrong:");
        console.error(error.message || error);
    }
    console.log("\n--- Test Finished ---");
}

main();