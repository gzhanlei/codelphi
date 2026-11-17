#!/usr/bin/env node
/* Claude Code host adapter: use the user's configured Claude model without selecting one. */
const { spawn } = require("node:child_process");

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let messages;
  try {
    const request = JSON.parse(input);
    if (!Array.isArray(request.messages)) throw new Error("messages must be an array");
    messages = request.messages;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const prompt = messages.map((message) => {
    const role = message.role === "system" ? "SYSTEM" : message.role === "assistant" ? "ASSISTANT" : "USER";
    return `[${role}]\n${message.content}`;
  }).join("\n\n");
  const args = [
    "-p",
    "--output-format", "text",
    "--tools", "",
    "--no-session-persistence",
    "--system-prompt", "You are a structured completion service. Follow the supplied SYSTEM and USER messages exactly. Return only the requested content without commentary.",
  ];
  const child = spawn(process.env.CLAUDE_CODE_BIN || "claude", args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let size = 0;
  let timedOut = false;
  const timeoutMs = Number(process.env.CODELPHI_HOST_AI_TIMEOUT_MS) || 180_000;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) child.kill();
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      console.error(timedOut ? `Claude Code exceeded ${timeoutMs}ms` : `Claude Code exited with code ${code ?? "unknown"}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(Buffer.concat(stdout));
  });
  child.stdin.on("error", (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exitCode = 1;
  });
  child.stdin.end(prompt);
});
