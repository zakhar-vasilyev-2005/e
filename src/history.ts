import type { ChatRole } from "u-llm-server";


export type Message = { role: ChatRole, content: string };
export class History extends Array<Message> {
    public add(role: ChatRole, content: string) {
        const last = this.at(-1);
        if (last?.role === role) {
            this.pop();
            content = last.content + content;
        }
        this.push({ role, content });
    }
}