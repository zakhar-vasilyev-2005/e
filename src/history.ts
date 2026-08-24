import type { ChatRole } from "u-llm-server";
import type { AgentDocStored, AgentFactStored, AgentRuleStored, AgentTaskStored } from "./agent.js";


export type Message = {
    role: ChatRole,
    content: string,
    memo?: AgentDocStored[],
};
export class History extends Array<Message> {
    public getMemories() {
        return this.flatMap(e => e.memo ?? []);
    }
    public add(role: ChatRole, content: string, memo: AgentDocStored[] = []) {
        const last = this.at(-1);
        if (last?.role === role) {
            this.pop();
            content = last.content + content;
            memo = [...(last.memo ?? []), ...memo];
        }
        this.push({ role, content, memo });
    }
}