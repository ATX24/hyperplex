/**
 * Hyperplex for pi: puts every pi session on the network as an agent of this machine.
 *
 * - Registers the session (platform "pi"; shown as "pi-learning" once it teaches with the learn extension).
 * - Keeps its state current: working while the agent runs, waiting when it settles.
 * - Polls its inbox while open; messages arrive as follow-up prompts in this session.
 * - When it settles after being driven through Hyperplex, it tells whoever drove it.
 *
 * Talks to Hyperplex through the hpx CLI (which holds this machine's signing key).
 * Installed by `hpx install pi`; does nothing if hpx isn't connected.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HPX = process.env.HPX_BIN || join(homedir(), ".local/bin/hpx");

function hpx(args: string[], timeoutMs = 20_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(HPX, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export default function hyperplex(pi: ExtensionAPI) {
	let handle: string | undefined;
	let remote = false;
	let learning = false;
	let polling = false;
	let stopped = false;
	let lastReply = "";

	async function register(ctx: ExtensionContext, extra: Record<string, unknown> = {}) {
		const id = ctx.sessionManager?.getSessionId?.();
		if (!id) return;
		const meta: Record<string, unknown> = { transcript: ctx.sessionManager.getSessionFile?.(), pid: process.pid, ...extra };
		if (process.env.TMUX_PANE) meta.tmux_pane = process.env.TMUX_PANE;
		if (process.env.HPX_LAUNCH_ID) Object.assign(meta, { launched_by: process.env.HPX_LAUNCH_ID, tmux_session: process.env.HPX_TMUX_SESSION, remote: true });
		const args = ["session", "--platform", "pi", "--ref", id, "--cwd", ctx.cwd, "--meta", JSON.stringify(meta)];
		const name = pi.getSessionName();
		if (name) args.push("--title", name);
		if (process.env.HPX_REPLY_TO) args.push("--reply-to", process.env.HPX_REPLY_TO);
		try {
			const s = JSON.parse(await hpx(args));
			handle = s.handle;
			remote = Boolean(s.meta?.remote);
			learning = Boolean(s.meta?.learning);
		} catch {
			handle = undefined; // hpx missing or not connected: stay quiet
		}
	}
	const status = (state: string, summary?: string) => {
		if (handle) hpx(["status", state, ...(summary ? [clip(summary, 300)] : []), "--as", handle]).catch(() => {});
	};

	// Long-poll the inbox while the session is open; each message becomes a follow-up prompt.
	async function pollLoop() {
		if (polling) return;
		polling = true;
		while (!stopped && handle) {
			try {
				const out = JSON.parse(await hpx(["inbox", "--as", handle, "--wait", "25", "--json"], 45_000));
				for (const m of out.messages ?? []) {
					remote = true;
					pi.sendUserMessage(`Message from ${m.from} through Hyperplex${m.kind === "request" ? " (needs an answer)" : ""} [id ${m.id}]:\n${m.body}`, { deliverAs: "followUp" });
				}
			} catch {
				await new Promise((r) => setTimeout(r, 15_000));
			}
		}
		polling = false;
	}

	pi.on("session_start", async (_event, ctx) => {
		stopped = false;
		await register(ctx);
		if (handle) { status("idle"); void pollLoop(); }
	});
	pi.on("session_info_changed", (event) => {
		if (handle && event.name) hpx(["status", "idle", "--as", handle]).catch(() => {});
	});
	pi.on("agent_start", () => status("working"));
	pi.on("message_end", async (event, ctx) => {
		const m: any = event.message;
		if (m.role === "assistant") {
			const text = (m.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n\n");
			if (text) lastReply = text;
		}
		// a session that teaches with the learn extension is a learning session
		if (!learning && m.role === "toolResult" && (m.toolName === "md_log" || m.toolName === "quiz")) {
			learning = true;
			await register(ctx, { learning: true, ...(m.details?.path ? { note: m.details.path } : {}) });
		}
	});
	pi.on("agent_settled", () => {
		status("waiting", lastReply || "Finished its turn.");
		if (remote && handle && lastReply) {
			hpx(["send", "reply_to", `Pi session ${handle} finished:\n\n${clip(lastReply, 1800)}\n\nReply to this message with the next prompt.`,
				"--as", handle, "--kind", "event", "--collapse", `done:${handle}`]).catch(() => {});
		}
	});
	pi.on("session_shutdown", async () => {
		stopped = true;
		if (handle) await hpx(["status", "ended", "--as", handle]).catch(() => {});
	});
}
