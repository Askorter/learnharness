import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { isEmptyAssistantStop, runPiTurn } from "../src/server/pi/ui-stream.ts";

function makeAssistant(partial: Partial<{
	stopReason: string;
	content: unknown[];
	errorMessage: string;
}>): AgentMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "chatgpt",
		model: "gpt-6-astra",
		stopReason: partial.stopReason ?? "stop",
		content: partial.content ?? [{ type: "text", text: "" }],
		...(partial.errorMessage ? { errorMessage: partial.errorMessage } : {}),
		timestamp: Date.now(),
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as unknown as AgentMessage;
}

function createFakeAgent(steps: Array<() => AgentMessage>) {
	const listeners = new Set<(event: AgentEvent) => void>();
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};
	let callCount = 0;
	let aborted = false;
	const state = {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }] as AgentMessage[],
	};
	const agent = {
		state,
		subscribe(listener: (event: AgentEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		abort() {
			aborted = true;
		},
		async continue() {
			emit({ type: "agent_start" } as AgentEvent);
			const producer = steps[callCount++];
			if (!producer) throw new Error("unexpected extra continue() call");
			const msg = producer();
			state.messages = [...state.messages, msg];
			emit({ type: "message_start", message: msg } as AgentEvent);
			emit({ type: "message_end", message: msg } as AgentEvent);
			emit({ type: "agent_end", messages: [...state.messages] } as AgentEvent);
		},
	} as unknown as Agent;
	return { agent, getCallCount: () => callCount, wasAborted: () => aborted };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	return text;
}

describe("isEmptyAssistantStop", () => {
	it("detects empty stopReason:stop assistant replies and ignores valid or non-stop replies", () => {
		assert.equal(isEmptyAssistantStop(makeAssistant({ content: [{ type: "text", text: "" }] })), true);
		assert.equal(isEmptyAssistantStop(makeAssistant({ content: [{ type: "text", text: "   \n " }] })), true);
		assert.equal(isEmptyAssistantStop(makeAssistant({ content: [] })), true);
		assert.equal(isEmptyAssistantStop(makeAssistant({ content: [{ type: "thinking", thinking: "hmm" }] })), true);

		assert.equal(isEmptyAssistantStop(makeAssistant({ content: [{ type: "text", text: "hello" }] })), false);
		assert.equal(isEmptyAssistantStop(makeAssistant({ content: [{ type: "toolCall", id: "c1", name: "quiz", arguments: {} }] })), false);
		assert.equal(isEmptyAssistantStop(makeAssistant({ stopReason: "error", content: [] })), false);
		assert.equal(isEmptyAssistantStop(makeAssistant({ stopReason: "aborted", content: [] })), false);
		assert.equal(isEmptyAssistantStop({ role: "user", content: "" } as unknown as AgentMessage), false);
	});
});

describe("runPiTurn empty-response retry", () => {
	it("retries empty stop responses, strips empty attempts from history, and settles with the recovered reply", async () => {
		const { agent, getCallCount } = createFakeAgent([
			() => makeAssistant({ content: [{ type: "text", text: "" }] }),
			() => makeAssistant({ content: [{ type: "text", text: "   " }] }),
			() => makeAssistant({ content: [{ type: "text", text: "Here is the next step." }] }),
		]);
		let settledMessages: AgentMessage[] = [];
		let settledAborted = false;
		const handle = runPiTurn({
			agent,
			emptyRetryDelaysMs: [0, 0, 0],
			updateFlushMs: 5,
			onFinish(messages, isAborted) {
				settledMessages = messages;
				settledAborted = isAborted;
			},
		});
		await drain(handle.subscribe());

		assert.equal(getCallCount(), 3);
		assert.equal(settledAborted, false);
		// Only the original user message + the single non-empty assistant reply survive.
		assert.equal(settledMessages.length, 2);
		const reply = settledMessages[1] as unknown as { stopReason: string; content: Array<{ text?: string }> };
		assert.equal(reply.stopReason, "stop");
		assert.equal(reply.content[0]?.text, "Here is the next step.");
	});

	it("converts the final empty response to a retryable error after 3 retries are exhausted", async () => {
		const { agent, getCallCount } = createFakeAgent([
			() => makeAssistant({ content: [{ type: "text", text: "" }] }),
			() => makeAssistant({ content: [{ type: "text", text: "" }] }),
			() => makeAssistant({ content: [{ type: "text", text: "" }] }),
			() => makeAssistant({ content: [{ type: "text", text: "" }] }),
		]);
		let settledMessages: AgentMessage[] = [];
		const handle = runPiTurn({
			agent,
			emptyRetryDelaysMs: [0, 0, 0],
			updateFlushMs: 5,
			onFinish(messages) {
				settledMessages = messages;
			},
		});
		const wire = await drain(handle.subscribe());

		assert.equal(getCallCount(), 4);
		assert.equal(settledMessages.length, 2);
		const reply = settledMessages[1] as unknown as { stopReason: string; errorMessage?: string };
		assert.equal(reply.stopReason, "error");
		assert.match(reply.errorMessage ?? "", /empty response after 3 retries/i);
		assert.match(wire, /"stopReason":"error"/);
	});

	it("aborts immediately during retry backoff sleep without running further retries", async () => {
		const { agent, getCallCount } = createFakeAgent([
			() => makeAssistant({ content: [{ type: "text", text: "" }] }),
			() => makeAssistant({ content: [{ type: "text", text: "should not run" }] }),
		]);
		let settledAborted = false;
		const handle = runPiTurn({
			agent,
			emptyRetryDelaysMs: [60_000, 60_000, 60_000],
			updateFlushMs: 5,
			onFinish(_messages, isAborted) {
				settledAborted = isAborted;
			},
		});
		const streamPromise = drain(handle.subscribe());
		await new Promise((r) => setTimeout(r, 20));
		handle.abort();
		await streamPromise;

		assert.equal(getCallCount(), 1);
		assert.equal(settledAborted, true);
	});
});
