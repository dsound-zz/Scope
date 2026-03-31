import { Annotation } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
    messages: Annotation<any[]>({
        reducer: (x, y) => x.concat(y),
    }),
    candidateProfile: Annotation<string>(),
});