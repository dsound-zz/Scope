import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from "dotenv";

dotenv.config();

async function listAllModels() {
    console.log("--- Fetching Available Models ---");
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
    
    try {
        // The listModels method isn't directly on the top-level genAI object in all versions, 
        // but it is available via the fetch API if needed.
        // Let's try the direct fetch to the endpoint that ListModels uses.
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_API_KEY}`);
        const data: any = await response.json();
        
        if (data.models) {
            console.log("Commonly Used Models found:");
            data.models
                .filter((m: any) => m.name.includes("gemini"))
                .forEach((m: any) => {
                    console.log(`- ${m.name.replace('models/', '')} (Supported: ${m.supportedGenerationMethods.join(', ')})`);
                });
        } else {
            console.log("No models returned. API Key might be invalid or restricted.");
            console.log("Response:", JSON.stringify(data));
        }
    } catch (error: any) {
        console.error("Failed to list models:", error.message);
    }
    console.log("---------------------------------");
}

listAllModels();
