import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from "dotenv";

dotenv.config();

async function testModel(modelName: string) {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
    try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent("Say 'Success with " + modelName + "'");
        console.log("✅ " + modelName + " works!");
        return true;
    } catch (error: any) {
        console.log("❌ " + modelName + " failed: " + error.message);
        return false;
    }
}

async function main() {
    const modelsToTry = [
        "gemini-1.5-flash",
        "gemini-1.5-flash-latest",
        "gemini-1.5-pro",
        "gemini-2.0-flash",
        "gemini-2.0-flash-exp",
        "gemini-2.0-flash-lite-preview-02-05",
        "gemini-pro"
    ];

    console.log("--- Testing Gemini Models ---");
    for (const model of modelsToTry) {
        await testModel(model);
    }
    console.log("-----------------------------");
}

main();
