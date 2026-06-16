import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const session = findSessionForExport(args);
    const events = loadPreviewEvents(session.provider, session.rollout_path);
    const payload = {
      session,
      events: events.map((event) => toHtmlEvent(event)),
      generated_at: new Date().toISOString(),
      codex_dir: args.codexDir,
    };
    const outputPath = path.resolve(
      args.output ?? defaultExportHtmlPath(session),
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, renderHtml(payload), "utf8");

    process.stdout.write(`output\t${outputPath}\n`);
    process.stdout.write(`provider\t${session.provider}\n`);
    process.stdout.write(`id\t${session.id}\n`);
    process.stdout.write(`events\t${events.length}\n`);
  } catch (error) {
    process.stderr.write(`错误: ${error.message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const homeDir = os.homedir();
  const out = {
    provider: undefined,
    codexDir: path.join(homeDir, ".codex"),
    claudeDir: path.join(homeDir, ".claude"),
    output: undefined,
    id: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--provider") {
      out.provider = requiredValue(argv[++i], "--provider");
      continue;
    }
    if (arg === "--codex-dir") {
      out.codexDir = path.resolve(requiredValue(argv[++i], "--codex-dir"));
      continue;
    }
    if (arg === "--claude-dir") {
      out.claudeDir = path.resolve(requiredValue(argv[++i], "--claude-dir"));
      continue;
    }
    if (arg === "--output" || arg === "--out") {
      out.output = requiredValue(argv[++i], arg);
      continue;
    }
    if (arg === "--id") {
      out.id = requiredValue(argv[++i], "--id");
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`未知参数: ${arg}`);
    }
    if (!out.id) {
      out.id = arg;
      continue;
    }
    throw new Error(`多余参数: ${arg}`);
  }

  if (!out.id) {
    throw new Error("需要 session id");
  }
  if (out.provider && !["codex", "claude"].includes(out.provider)) {
    throw new Error(`不支持的 provider: ${out.provider}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`agent-export

用法:
  agent-export <session-id> [--provider codex|claude] [--output session.html]

选项:
  --provider <codex|claude>  指定 provider，不传则自动在 codex / claude 中查找
  --codex-dir <path>         默认 ~/.codex
  --claude-dir <path>        默认 ~/.claude
  --output, --out <path>     输出 html 文件路径
  --id <session-id>          也可以用 --id 传
  -h, --help                 显示帮助
`);
}

function requiredValue(value, flag) {
  if (!value) {
    throw new Error(`${flag} 缺少值`);
  }
  return value;
}

function findSessionForExport(args) {
  const providers = args.provider ? [args.provider] : ["codex", "claude"];
  const matches = [];
  for (const provider of providers) {
    if (provider === "codex") {
      matches.push(...findCodexMatches(args.id, args.codexDir));
    } else {
      matches.push(...findClaudeMatches(args.id, args.claudeDir));
    }
  }

  const exact = matches.filter((session) => session.id === args.id);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw ambiguousSessionError(args.id, exact);
  }

  const prefixed = matches.filter((session) => session.id.startsWith(args.id));
  if (prefixed.length === 1) {
    return prefixed[0];
  }
  if (prefixed.length > 1) {
    throw ambiguousSessionError(args.id, prefixed);
  }
  throw new Error(`未找到 session id 或前缀: ${args.id}`);
}

function ambiguousSessionError(idOrPrefix, matches) {
  const preview = matches
    .slice(0, 8)
    .map((session) => `${session.provider}:${session.id}`)
    .join(", ");
  const suffix = matches.length > 8 ? ", ..." : "";
  return new Error(
    `session id 前缀不唯一: ${idOrPrefix}，匹配 ${matches.length} 条: ${preview}${suffix}`,
  );
}

function findCodexMatches(idOrPrefix, codexDir) {
  ensureSqlite3Available();
  const dbPath = path.join(codexDir, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const likeValue = `${escapeSqlLike(idOrPrefix)}%`;
  const sql = `
    SELECT
      id,
      rollout_path,
      cwd,
      title,
      COALESCE(first_user_message, '') AS first_user_message,
      model,
      reasoning_effort,
      COALESCE(tokens_used, 0) AS tokens_used,
      created_at,
      updated_at,
      COALESCE(archived, 0) AS archived,
      git_branch,
      source,
      agent_nickname,
      agent_role
    FROM threads
    WHERE id LIKE '${sqlQuote(likeValue)}' ESCAPE '\\'
    ORDER BY updated_at DESC
  `;
  return runSqliteJson(dbPath, sql).map((row) =>
    createCodexSessionSummary(row, codexDir),
  );
}

function ensureSqlite3Available() {
  try {
    execFileSync("sqlite3", ["--version"], { encoding: "utf8" });
  } catch {
    throw new Error("导出 codex session 需要本机安装 sqlite3 命令");
  }
}

function createCodexSessionSummary(row, codexDir) {
  const rolloutPath = hostPathStringFromCodexRecord(
    codexDir,
    row.rollout_path ?? "",
  );
  const cwd = hostPathStringFromCodexRecord(codexDir, row.cwd ?? "");
  const tokensUsed =
    toInt(row.tokens_used) > 0
      ? toInt(row.tokens_used)
      : readRolloutTokenTotal(rolloutPath);
  return {
    provider: "codex",
    id: String(row.id ?? ""),
    rollout_path: rolloutPath,
    cwd,
    cwd_display: basenameDisplay(cwd),
    title: String(row.title ?? row.id ?? ""),
    first_user_message: String(row.first_user_message ?? ""),
    model: asOptionalString(row.model),
    reasoning_effort: asOptionalString(row.reasoning_effort),
    source: asOptionalString(row.source),
    agent_nickname: asOptionalString(row.agent_nickname),
    agent_role: asOptionalString(row.agent_role),
    tokens_used: tokensUsed,
    created_at: toInt(row.created_at),
    updated_at: toInt(row.updated_at),
    archived: Boolean(toInt(row.archived)),
    git_branch: asOptionalString(row.git_branch),
    rollout_bytes: statSize(rolloutPath),
    logs_count: 0,
    has_backup: false,
    resume_command: `codex resume ${row.id}`,
  };
}

function runSqliteJson(dbPath, sql) {
  let stdout = "";
  try {
    stdout = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(stderr || `读取 sqlite 失败: ${dbPath}`);
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  return JSON.parse(trimmed);
}

function findClaudeMatches(idOrPrefix, claudeDir) {
  const root = path.join(claudeDir, "projects");
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  collectJsonlFiles(root, files);
  const matches = [];
  for (const file of files) {
    const session = parseClaudeSession(file);
    if (!session) {
      continue;
    }
    if (session.id === idOrPrefix || session.id.startsWith(idOrPrefix)) {
      matches.push(session);
    }
  }
  matches.sort((a, b) => b.updated_at - a.updated_at);
  return matches;
}

function collectJsonlFiles(root, out) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }
}

function parseClaudeSession(filePath) {
  const isSubagent = isAgentSession(filePath);
  const lines = readJsonlObjects(filePath);
  let sessionId;
  let agentId = inferAgentIdFromFilename(filePath);
  let agentRole;
  let cwd;
  let createdAt;
  let updatedAt;
  let firstUserMessage;
  let aiTitle;
  let customTitle;
  let sessionTitle;
  let summaryTitle;
  let lastPrompt;
  let tailSummary;
  let model;
  let tokensUsed = 0;
  let reasoningEffort;

  for (const value of lines) {
    if (!sessionId) {
      sessionId = asOptionalString(value.sessionId);
    }
    if (isSubagent) {
      if (!agentId) {
        agentId = asOptionalString(value.agentId);
      }
      agentRole = firstDefinedString(
        agentRole,
        asOptionalString(value.attributionAgent),
        asOptionalString(value.attributionSkill),
      );
    }
    if (!cwd) {
      cwd = asOptionalString(value.cwd);
    }
    const ts = parseTimestampToSeconds(value.timestamp);
    if (ts != null) {
      if (createdAt == null) {
        createdAt = ts;
      }
      updatedAt = ts;
    }

    sessionTitle = firstDefinedString(sessionTitle, hookSessionTitle(value));
    const eventType = asOptionalString(value.type) ?? "";
    if (eventType === "ai-title") {
      aiTitle = firstDefinedString(
        aiTitle,
        asOptionalString(value.aiTitle),
        asOptionalString(value.title),
      );
    } else if (eventType === "custom-title") {
      customTitle = firstDefinedString(
        customTitle,
        asOptionalString(value.customTitle),
        asOptionalString(value.title),
      );
    } else if (eventType === "summary") {
      summaryTitle = firstDefinedString(
        summaryTitle,
        asOptionalString(value.summary),
      );
    } else if (eventType === "last-prompt") {
      lastPrompt = firstDefinedString(
        lastPrompt,
        asOptionalString(value.lastPrompt),
      );
    }

    const message = value.message;
    if (!message || typeof message !== "object") {
      continue;
    }
    if (!model) {
      model = asOptionalString(message.model) ?? asOptionalString(value.model);
    }
    tokensUsed += usageTokens(message.usage);
    tokensUsed += usageTokens(value.usage);

    const role = asOptionalString(message.role) ?? "unknown";
    const text = extractText(message.content ?? "");
    const trimmed = text.trim();
    const isUser = eventType === "user" || role === "user";
    const isMeta = value.isMeta === true;
    const isSidechain = value.isSidechain === true;
    const visibleMessage = !isMeta && (isSubagent || !isSidechain);
    if (
      !firstUserMessage &&
      isUser &&
      visibleMessage &&
      trimmed &&
      !isGeneratedUserPrompt(trimmed)
    ) {
      firstUserMessage = trimmed;
    }
    if (visibleMessage && trimmed) {
      tailSummary = trimmed;
    }
    if (isUser) {
      const effort = parseEffortLevel(trimmed);
      if (effort) {
        reasoningEffort = effort;
      }
    }
  }

  const parentSessionId = sessionId;
  const id = isSubagent
    ? inferSessionIdFromFilename(filePath)
    : sessionId ?? inferSessionIdFromFilename(filePath);
  if (!id) {
    return null;
  }
  const cwdValue = cwd ?? "";
  const title =
    customTitle ??
    sessionTitle ??
    aiTitle ??
    summaryTitle ??
    firstUserMessage ??
    lastPrompt ??
    tailSummary ??
    pathBasename(cwdValue) ??
    id;

  return {
    provider: "claude",
    id,
    rollout_path: filePath,
    cwd: stripVerbatim(cwdValue),
    cwd_display: basenameDisplay(cwdValue),
    title: truncateSummary(title, 80),
    first_user_message: firstUserMessage ?? "",
    model: model ?? null,
    reasoning_effort: reasoningEffort ?? null,
    source: isSubagent ? "subagent" : null,
    agent_nickname: isSubagent ? agentId ?? null : null,
    agent_role: isSubagent ? agentRole ?? null : null,
    tokens_used: tokensUsed,
    created_at: createdAt ?? 0,
    updated_at: updatedAt ?? createdAt ?? 0,
    archived: false,
    git_branch: null,
    rollout_bytes: statSize(filePath),
    logs_count: 0,
    has_backup: false,
    resume_command: `claude --resume ${isSubagent ? parentSessionId ?? id : id}`,
  };
}

function loadPreviewEvents(provider, rolloutPath) {
  if (provider === "codex") {
    return readJsonlObjects(rolloutPath).map((raw, index) =>
      classifyCodexPreview(index, raw),
    );
  }
  return readJsonlObjects(rolloutPath)
    .map((raw, index) => classifyClaudePreview(index, raw))
    .filter(Boolean);
}

function classifyCodexPreview(index, raw) {
  const timestamp = asOptionalString(raw.timestamp) ?? "";
  const outerType = asOptionalString(raw.type) ?? "";
  const payloadType = asOptionalString(raw.payload?.type) ?? "";

  let role = "other";
  let kind = `${outerType}/${payloadType}`;
  let textSummary = "";

  if (outerType === "session_meta") {
    role = "meta";
    kind = "session_meta";
    textSummary = "会话元数据";
  } else if (outerType === "event_msg" && payloadType === "task_started") {
    role = "meta";
    kind = "task_started";
    textSummary = "任务开始";
  } else if (outerType === "event_msg" && payloadType === "token_count") {
    role = "meta";
    kind = "token_count";
    textSummary = `tokens: ${tokenTotalFromValue(raw) ?? 0}`;
  } else if (outerType === "event_msg" && payloadType === "agent_message") {
    role = "assistant";
    kind = "agent_message";
    textSummary = trimFlat(asOptionalString(raw.payload?.message) ?? "", 120);
  } else if (outerType === "event_msg" && payloadType === "user_message") {
    role = "user";
    kind = "user_message";
    textSummary = trimFlat(asOptionalString(raw.payload?.message) ?? "", 120);
  } else if (outerType === "response_item" && payloadType === "message") {
    role = asOptionalString(raw.payload?.role) ?? "assistant";
    kind = "message";
    textSummary = trimFlat(flattenContent(raw.payload?.content), 120);
  } else if (outerType === "response_item" && payloadType === "reasoning") {
    role = "reasoning";
    kind = "reasoning";
    textSummary = trimFlat(flattenContent(raw.payload?.content), 80);
  } else if (outerType === "response_item" && payloadType === "function_call") {
    role = "tool_call";
    kind = "function_call";
    textSummary = asOptionalString(raw.payload?.name) ?? "";
  } else if (
    outerType === "response_item" &&
    payloadType === "function_call_output"
  ) {
    role = "tool_result";
    kind = "function_call_output";
    textSummary = "工具返回";
  }

  return {
    index,
    timestamp,
    role,
    kind,
    text_summary: textSummary,
    raw,
  };
}

function flattenContent(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (item && typeof item === "object" && typeof item.text === "string") {
        return item.text;
      }
      if (typeof item === "string") {
        return item;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function classifyClaudePreview(index, raw) {
  const timestamp = asOptionalString(raw.timestamp) ?? "";
  const kind = asOptionalString(raw.type) ?? "message";
  if (raw.isMeta === true) {
    return {
      index,
      timestamp,
      role: "meta",
      kind,
      text_summary: claudeNonMessageSummary(raw),
      raw,
    };
  }
  const message = raw.message;
  if (!message || typeof message !== "object") {
    return {
      index,
      timestamp,
      role: kind === "summary" || kind === "custom-title" ? "meta" : "other",
      kind,
      text_summary: claudeNonMessageSummary(raw),
      raw,
    };
  }

  let role = asOptionalString(message.role) ?? "unknown";
  const content = message.content;
  if (role === "user" && contentIsAllToolResults(content)) {
    role = "tool_result";
  } else if (role === "assistant" && contentHasToolUse(content)) {
    role = "tool_call";
  } else if (role === "assistant" && contentIsOnlyThinking(content)) {
    role = "reasoning";
  }
  const text =
    role === "reasoning" ? extractThinkingText(content) : extractText(content ?? "");
  return {
    index,
    timestamp,
    role,
    kind,
    text_summary: truncateSummary(text, 120),
    raw,
  };
}

function toHtmlEvent(event) {
  return {
    index: event.index,
    timestamp: event.timestamp,
    role: event.role,
    kind: event.kind,
    text_summary: event.text_summary,
    text: previewEventText(event),
    conversation: previewEventIsConversation(event),
    event_message:
      rawType(event) === "event_msg" &&
      ["user_message", "agent_message"].includes(payloadType(event)),
    raw: event.raw,
  };
}

function previewEventIsConversation(event) {
  if (isInternalCodexContextMessage(event)) {
    return false;
  }
  if (!["user", "assistant"].includes(event.role)) {
    return false;
  }
  const rawMessageRole = asOptionalString(event.raw?.message?.role);
  if (rawMessageRole) {
    return true;
  }
  return rawType(event) === "response_item" && payloadType(event) === "message";
}

function isInternalCodexContextMessage(event) {
  if (event.role !== "user") {
    return false;
  }
  const text = previewEventText(event).trim();
  if (!text) {
    return false;
  }
  const firstLine = normalizePromptHeading(text.split("\n")[0] ?? "");
  return (
    (firstLine.startsWith("AGENTS.md instructions for ") &&
      text.includes("<INSTRUCTIONS>")) ||
    (firstLine === "<environment_context>" &&
      text.includes("</environment_context>"))
  );
}

function normalizePromptHeading(line) {
  return String(line ?? "").trim().replace(/^#+\s*/, "");
}

function previewEventText(event) {
  const message = event.raw?.message;
  if (message) {
    const text = flattenRichContent(message.content);
    if (text) {
      return text;
    }
  }

  const payload = event.raw?.payload;
  if (typeof payload?.message === "string") {
    return payload.message;
  }
  if (typeof payload?.text === "string") {
    return payload.text;
  }

  const text = flattenRichContent(payload?.content);
  return text || event.text_summary || "";
}

function flattenRichContent(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => flattenRichContentItem(item))
    .filter(Boolean)
    .join("\n\n");
}

function flattenRichContentItem(item) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return "";
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return flattenRichContent(item.content);
}

function rawType(event) {
  return asOptionalString(event.raw?.type) ?? "";
}

function payloadType(event) {
  return asOptionalString(event.raw?.payload?.type) ?? "";
}

function readRolloutTokenTotal(rolloutPath) {
  let total = 0;
  for (const raw of readJsonlObjects(rolloutPath)) {
    const next = tokenTotalFromValue(raw);
    if (next != null) {
      total = next;
    }
  }
  return total;
}

function tokenTotalFromValue(raw) {
  if (raw?.type !== "event_msg" || raw?.payload?.type !== "token_count") {
    return null;
  }
  return (
    nonnegativeInt(raw.payload?.info?.total_token_usage?.total_tokens) ??
    nonnegativeInt(raw.payload?.info?.total_tokens) ??
    nonnegativeInt(raw.payload?.total_tokens) ??
    nonnegativeInt(raw?.total_tokens)
  );
}

function contentIsAllToolResults(content) {
  return Array.isArray(content) && content.length > 0
    ? content.every((item) => item?.type === "tool_result")
    : false;
}

function contentHasToolUse(content) {
  return Array.isArray(content)
    ? content.some((item) => item?.type === "tool_use")
    : false;
}

function contentIsOnlyThinking(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  let hasThinking = false;
  for (const item of content) {
    if (item?.type === "thinking" || item?.type === "redacted_thinking") {
      hasThinking = true;
      continue;
    }
    return false;
  }
  return hasThinking;
}

function extractThinkingText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const item of content) {
    if (item?.type === "thinking" && typeof item.thinking === "string") {
      const trimmed = item.thinking.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    } else if (item?.type === "redacted_thinking") {
      parts.push("(加密推理)");
    }
  }
  if (parts.length === 0) {
    return "(加密推理)";
  }
  return parts.join("\n\n");
}

function extractText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextFromItem(item))
      .filter((text) => text && text.trim())
      .join("\n");
  }
  if (value && typeof value === "object") {
    return typeof value.text === "string" ? value.text : "";
  }
  return "";
}

function extractTextFromItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  if (item.type === "tool_use") {
    return `[Tool: ${item.name ?? "unknown"}]`;
  }
  if (item.type === "tool_result") {
    const text = extractText(item.content);
    return text || null;
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  if ("content" in item) {
    const text = extractText(item.content);
    return text || null;
  }
  return null;
}

function claudeNonMessageSummary(raw) {
  for (const key of [
    "customTitle",
    "aiTitle",
    "sessionTitle",
    "summary",
    "content",
    "text",
    "stdout",
    "stderr",
    "command",
  ]) {
    if (typeof raw?.[key] === "string") {
      const trimmed = raw[key].trim();
      if (trimmed) {
        return truncateSummary(trimmed, 120);
      }
    }
  }
  return asOptionalString(raw?.type) ?? "事件";
}

function hookSessionTitle(value) {
  return (
    hookOutputTitle(value) ??
    hookOutputTitle(value?.attachment) ??
    parseHookStdoutSessionTitle(value?.attachment?.stdout) ??
    parseHookStdoutSessionTitle(value?.stdout)
  );
}

function hookOutputTitle(value) {
  return (
    asOptionalString(value?.sessionTitle) ??
    asOptionalString(value?.hookSpecificOutput?.sessionTitle)
  );
}

function parseHookStdoutSessionTitle(stdout) {
  if (typeof stdout !== "string" || !stdout.trim()) {
    return null;
  }
  try {
    return hookOutputTitle(JSON.parse(stdout.trim()));
  } catch {
    return null;
  }
}

function parseTimestampToSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n > 1_000_000_000_000 ? Math.trunc(n / 1000) : n;
  }
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.trunc(date.getTime() / 1000);
}

function usageTokens(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  return [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]
    .map((key) => toInt(value[key]))
    .reduce((sum, next) => sum + next, 0);
}

function parseEffortLevel(text) {
  return parseEffortCommandArgs(text) ?? parseEffortStdout(text);
}

function parseEffortCommandArgs(text) {
  if (tagContent(text, "command-name")?.trim() !== "/effort") {
    return null;
  }
  return normalizeEffortLevel(tagContent(text, "command-args"));
}

function parseEffortStdout(text) {
  const marker = "Set effort level to ";
  const index = text.indexOf(marker);
  if (index < 0) {
    return null;
  }
  const rest = text.slice(index + marker.length);
  const matched = rest.match(/^[A-Za-z0-9_-]+/);
  return normalizeEffortLevel(matched?.[0] ?? "");
}

function normalizeEffortLevel(level) {
  if (typeof level !== "string") {
    return null;
  }
  const trimmed = level.trim();
  return trimmed ? trimmed : null;
}

function tagContent(text, tag) {
  if (typeof text !== "string") {
    return null;
  }
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) {
    return null;
  }
  const from = start + open.length;
  const end = text.indexOf(close, from);
  if (end < 0) {
    return null;
  }
  return text.slice(from, end);
}

function isGeneratedUserPrompt(text) {
  const trimmed = String(text ?? "").trimStart();
  return (
    trimmed.startsWith("Caveat:") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("# AGENTS.md") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<command-message>") ||
    trimmed.startsWith("<command-args>") ||
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("<local-command-stdout>") ||
    trimmed.startsWith("<local-command-stderr>") ||
    trimmed.startsWith("<bash-input>") ||
    trimmed.startsWith("<bash-stdout>") ||
    trimmed.startsWith("<bash-stderr>")
  );
}

function inferSessionIdFromFilename(filePath) {
  const ext = path.extname(filePath);
  return path.basename(filePath, ext) || null;
}

function inferAgentIdFromFilename(filePath) {
  const id = inferSessionIdFromFilename(filePath);
  if (!id || !id.startsWith("agent-")) {
    return null;
  }
  return id.slice("agent-".length);
}

function isAgentSession(filePath) {
  return path.basename(filePath).startsWith("agent-");
}

function basenameDisplay(value) {
  const stripped = stripVerbatim(value ?? "");
  const name = path.basename(stripped);
  return name || stripped;
}

function pathBasename(value) {
  const trimmed = String(value ?? "").trim().replace(/[\\/]+$/, "");
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function truncateSummary(text, maxChars) {
  const trimmed = String(text ?? "").trim();
  if (Array.from(trimmed).length <= maxChars) {
    return trimmed;
  }
  return `${Array.from(trimmed).slice(0, maxChars).join("")}...`;
}

function trimFlat(text, limit) {
  const flat = Array.from(String(text ?? ""))
    .filter((ch) => ch !== "\n")
    .join("");
  if (Array.from(flat).length <= limit) {
    return flat;
  }
  return `${Array.from(flat).slice(0, limit).join("")}…`;
}

function readJsonlObjects(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const out = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      // 损坏行直接跳过
    }
  }
  return out;
}

function defaultExportHtmlPath(session) {
  return `${sanitizeFilenamePart(session.provider)}-${sanitizeFilenamePart(session.id)}.html`;
}

function sanitizeFilenamePart(value) {
  const cleaned = String(value ?? "")
    .split("")
    .map((ch) => (/^[A-Za-z0-9_-]$/.test(ch) ? ch : "-"))
    .join("")
    .replace(/^-+|-+$/g, "");
  return cleaned || "session";
}

function escapeSqlLike(value) {
  return String(value ?? "").replace(/[\\%_]/g, "\\$&");
}

function sqlQuote(value) {
  return String(value ?? "").replace(/'/g, "''");
}

function hostPathStringFromCodexRecord(codexDir, raw) {
  const cleaned = stripVerbatim(String(raw ?? "").trim());
  if (cleaned.startsWith("/")) {
    const mapping = wslUncMapping(codexDir);
    if (mapping) {
      return mapping.hostPathForLinuxPath(cleaned);
    }
  }
  return cleaned;
}

function stripVerbatim(value) {
  const text = String(value ?? "");
  if (text.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${text.slice("\\\\?\\UNC\\".length)}`;
  }
  if (text.startsWith("\\\\?\\")) {
    return text.slice("\\\\?\\".length);
  }
  return text;
}

function wslUncMapping(filePath) {
  const raw = stripVerbatim(path.resolve(filePath)).replace(/\//g, "\\");
  const match = raw.match(/^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i);
  if (!match) {
    return null;
  }
  return {
    hostPathForLinuxPath(linuxPath) {
      const segments = linuxPath
        .replace(/^\/+/, "")
        .split("/")
        .filter(Boolean);
      return `\\\\${match[1]}\\${match[2]}${segments.length ? `\\${segments.join("\\")}` : ""}`;
    },
  };
}

function statSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function nonnegativeInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 ? Math.trunc(value) : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
  }
  return null;
}

function toInt(value) {
  return nonnegativeInt(value) ?? 0;
}

function asOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstDefinedString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function renderHtml(payload) {
  const payloadJson = JSON.stringify(payload).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Export Preview</title>
<style>
:root {
  color-scheme: light;
  --background: #ffffff;
  --foreground: #111113;
  --card: #ffffff;
  --muted: #f4f4f5;
  --muted-2: #fafafa;
  --muted-foreground: #71717a;
  --border: #e4e4e7;
  --primary: #16a34a;
  --primary-foreground: #f0fdf4;
  --assistant: #059669;
  --purple: #7c3aed;
  --amber: #d97706;
  --sky: #0284c7;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, rgba(34, 197, 94, 0.12), transparent 24rem),
    linear-gradient(180deg, #f8fafc 0%, #f4f4f5 100%);
  color: var(--foreground);
}
button, input { font: inherit; }
button { cursor: pointer; }
.page { min-height: 100vh; }
.dialog {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: transparent;
}
.header {
  position: sticky;
  top: 0;
  z-index: 10;
  flex: 0 0 auto;
  border-bottom: 1px solid rgba(228, 228, 231, 0.72);
  padding: 18px 24px 14px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(12px);
}
.header::after {
  content: "";
  position: absolute;
  inset: auto 0 -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(161, 161, 170, 0.45), transparent);
}
.title-row { display: flex; align-items: flex-start; gap: 14px; min-width: 0; }
.mark {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid rgba(228, 228, 231, 0.9);
  border-radius: 8px;
  background: linear-gradient(135deg, #f4f4f5, rgba(244, 244, 245, 0.45));
  color: var(--muted-foreground);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
.title-wrap { min-width: 0; flex: 1; }
h1 {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  line-height: 1.35;
  letter-spacing: 0;
}
.meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 8px;
  min-width: 0;
  color: var(--muted-foreground);
  font-size: 12px;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
.dot { width: 4px; height: 4px; border-radius: 999px; background: #a1a1aa; opacity: 0.7; }
.badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  max-width: 100%;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--muted);
  color: #3f3f46;
  line-height: 1;
}
.toolbar {
  margin-top: 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.filter {
  width: min(330px, 100%);
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 12px;
  outline: none;
  color: var(--foreground);
  background: var(--card);
}
.filter:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.14); }
.toggle {
  height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(244, 244, 245, 0.45);
  padding: 0 10px;
  color: #27272a;
  font-size: 12px;
}
.switch {
  width: 36px;
  height: 20px;
  border: 0;
  border-radius: 999px;
  padding: 2px;
  background: #d4d4d8;
  transition: background 160ms ease;
}
.switch::before {
  content: "";
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.18);
  transition: transform 160ms ease;
}
.switch[aria-pressed="true"] { background: var(--primary); }
.switch[aria-pressed="true"]::before { transform: translateX(16px); }
.count { color: var(--muted-foreground); font-size: 11px; }
.actions { margin-left: auto; display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.btn {
  height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 0 10px;
  color: #27272a;
  font-size: 12px;
}
.btn:hover { background: var(--muted); }
.sep { width: 1px; height: 16px; margin: 0 4px; background: var(--border); }
.content { min-height: 0; flex: 1; background: transparent; }
.stream {
  width: 100%;
  max-width: 768px;
  margin: 0 auto;
  padding: 28px 24px 56px;
}
.event { display: flex; gap: 12px; margin-bottom: 16px; }
.event.user { justify-content: flex-end; }
.event.user .bubble-wrap { align-items: flex-end; }
.bubble-wrap { min-width: 0; max-width: 85%; display: flex; flex-direction: column; }
.event.event-msg .bubble-wrap, .event.meta .bubble-wrap, .event.tool .bubble-wrap, .event.other .bubble-wrap { max-width: none; flex: 1; }
.event-head {
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted-foreground);
  font-size: 11px;
}
.source {
  height: 16px;
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--card);
  color: var(--muted-foreground);
  font-size: 10px;
}
.avatar {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 999px;
}
.avatar.user { background: var(--primary); color: var(--primary-foreground); }
.avatar.assistant { background: rgba(16, 185, 129, 0.15); color: var(--assistant); }
.avatar.tool-call { background: rgba(124, 58, 237, 0.14); color: var(--purple); }
.avatar.tool-result { background: rgba(217, 119, 6, 0.15); color: var(--amber); }
.avatar.event-message { background: rgba(2, 132, 199, 0.14); color: var(--sky); }
.avatar.other { background: rgba(100, 116, 139, 0.14); color: #475569; }
.bubble {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
  border-radius: 16px;
  padding: 10px 16px;
  font-size: 14px;
  line-height: 1.65;
}
.bubble.user { border-top-right-radius: 4px; background: var(--primary); color: var(--primary-foreground); }
.bubble.assistant { border: 1px solid var(--border); border-top-left-radius: 4px; background: var(--card); color: var(--foreground); box-shadow: 0 1px 2px rgba(15,23,42,0.05); }
.bubble pre {
  max-width: 100%;
  overflow: auto;
  border: 1px solid rgba(161, 161, 170, 0.32);
  border-radius: 6px;
  padding: 10px;
  white-space: pre-wrap;
}
.bubble code { border-radius: 4px; background: rgba(113, 113, 122, 0.14); padding: 1px 4px; font-size: 12.5px; }
.bubble.user code { background: rgba(240, 253, 244, 0.16); color: inherit; }
.bubble p { margin: 8px 0; }
.bubble > :first-child { margin-top: 0; }
.bubble > :last-child { margin-bottom: 0; }
.fold {
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  padding: 8px 12px;
  color: #27272a;
  text-align: left;
  box-shadow: 0 1px 2px rgba(15,23,42,0.05);
}
.fold:hover { background: #f8fafc; }
.fold .summary { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); }
.chev { transition: transform 160ms ease; }
.open .chev { transform: rotate(180deg); }
.raw {
  display: none;
  margin-top: 6px;
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  padding: 12px;
  color: #27272a;
  font-size: 12px;
  line-height: 1.45;
}
.open + .raw, .raw.open { display: block; }
.reasoning {
  border: 1px dashed var(--border);
  border-radius: 6px;
  background: rgba(244, 244, 245, 0.68);
  padding: 9px 12px;
  color: var(--muted-foreground);
  white-space: pre-wrap;
  font-size: 12px;
}
.meta-line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0;
  color: var(--muted-foreground);
  font-size: 11px;
}
.meta-line::before, .meta-line::after { content: ""; height: 1px; flex: 1; background: var(--border); }
.empty { padding: 64px 16px; text-align: center; color: var(--muted-foreground); font-size: 14px; }
.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%) translateY(18px);
  opacity: 0;
  z-index: 20;
  border-radius: 8px;
  background: #18181b;
  color: #fafafa;
  padding: 9px 12px;
  font-size: 12px;
  box-shadow: 0 12px 30px rgba(15,23,42,0.25);
  transition: opacity 160ms ease, transform 160ms ease;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
@media (max-width: 760px) {
  .header { padding: 14px; }
  .stream { padding: 18px 12px; }
  .bubble-wrap { max-width: 88%; }
  .actions { width: 100%; margin-left: 0; }
}
</style>
</head>
<body>
<main class="page">
  <section class="dialog" aria-label="会话预览">
    <header class="header">
      <div class="title-row">
        <div class="mark" aria-hidden="true">${icon("sparkles")}</div>
        <div class="title-wrap">
          <h1 id="title"></h1>
          <div class="meta" id="meta"></div>
        </div>
      </div>
      <div class="toolbar">
        <input id="filter" class="filter" placeholder="在事件中过滤..." autocomplete="off">
        <button id="onlyMsg" class="toggle" type="button">
          <span class="switch" aria-pressed="true"></span>
          <span>仅看对话消息</span>
        </button>
        <span id="count" class="count"></span>
        <div class="actions">
          <button class="btn" type="button" data-action="copy-id">${icon("copy")}复制会话 ID</button>
          <button class="btn" type="button" data-action="copy-resume">${icon("copy")}复制 resume</button>
          <button class="btn" type="button" data-action="open-dir">${icon("folder")}打开目录</button>
          <span class="sep" aria-hidden="true"></span>
          <button class="btn" type="button" data-action="copy-path">${icon("file")}复制路径</button>
        </div>
      </div>
    </header>
    <div class="content">
      <div id="stream" class="stream"></div>
    </div>
  </section>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script id="session-data" type="application/json">${payloadJson}</script>
<script>
const data = JSON.parse(document.getElementById("session-data").textContent);
const session = data.session;
let onlyMessages = true;
let filterText = "";

const icons = {
  user: ${JSON.stringify(icon("user"))},
  assistant: ${JSON.stringify(icon("bot"))},
  tool: ${JSON.stringify(icon("wrench"))},
  terminal: ${JSON.stringify(icon("terminal"))},
  event: ${JSON.stringify(icon("sparkles"))},
  file: ${JSON.stringify(icon("file"))},
  down: ${JSON.stringify(icon("chevron"))}
};

function init() {
  document.title = \`\${session.provider} \${session.id.slice(0, 8)} - Agent Export\`;
  document.getElementById("title").textContent = session.title || "预览会话";
  renderMeta();
  bindActions();
  render();
}

function renderMeta() {
  const meta = document.getElementById("meta");
  const parts = [];
  parts.push(\`<span class="mono">\${escapeHtml(session.id.slice(0, 8))}</span>\`);
  if (session.model) {
    parts.push(\`<span class="dot"></span><span class="badge">\${escapeHtml(session.model + (session.reasoning_effort ? " · " + session.reasoning_effort : ""))}</span>\`);
  }
  if (session.tokens_used > 0) {
    parts.push(\`<span class="dot"></span><span>\${humanTokens(session.tokens_used)} token</span>\`);
  }
  if (session.cwd_display) {
    parts.push(\`<span class="dot"></span><span title="\${escapeAttr(session.cwd)}">\${escapeHtml(session.cwd_display)}</span>\`);
  }
  meta.innerHTML = parts.join("");
}

function bindActions() {
  document.getElementById("filter").addEventListener("input", (event) => {
    filterText = event.target.value.trim().toLowerCase();
    render();
  });
  document.getElementById("onlyMsg").addEventListener("click", () => {
    onlyMessages = !onlyMessages;
    document.querySelector("#onlyMsg .switch").setAttribute("aria-pressed", String(onlyMessages));
    render();
  });
  document.querySelector('[data-action="copy-id"]').addEventListener("click", () => copyText(session.id, "已复制会话 ID"));
  document.querySelector('[data-action="copy-resume"]').addEventListener("click", () => copyText(session.resume_command, "已复制 resume"));
  document.querySelector('[data-action="open-dir"]').addEventListener("click", () => copyText(session.cwd || "", "浏览器不能直接打开本地目录，已复制目录路径"));
  document.querySelector('[data-action="copy-path"]').addEventListener("click", () => copyText(session.rollout_path, "已复制 rollout 路径"));
}

function render() {
  const filtered = data.events.filter((event) => {
    if (onlyMessages && !event.conversation) return false;
    if (!filterText) return true;
    return [event.text_summary, event.text, event.role, event.kind, JSON.stringify(event.raw)]
      .join("\\n")
      .toLowerCase()
      .includes(filterText);
  });
  document.getElementById("count").innerHTML =
    \`显示 <span class="mono">\${filtered.length}</span> / 已加载 <span class="mono">\${data.events.length}</span> 条 · 已到末尾\`;
  const stream = document.getElementById("stream");
  stream.innerHTML = filtered.length ? filtered.map(renderEvent).join("") : '<div class="empty">无匹配事件</div>';
  stream.querySelectorAll("[data-toggle-raw]").forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.toggle("open");
      button.nextElementSibling.classList.toggle("open");
    });
  });
}

function renderEvent(event) {
  if (event.event_message) return renderFoldEvent(event, "event-msg", "event-message", "事件消息", icons.event);
  if (event.role === "user") return renderUser(event);
  if (event.role === "assistant") return renderAssistant(event);
  if (event.role === "reasoning") return renderReasoning(event);
  if (event.role === "tool_call" || event.role === "tool_result") return renderFoldEvent(event, "tool", event.role === "tool_call" ? "tool-call" : "tool-result", event.role === "tool_call" ? "工具调用" : "工具返回", event.role === "tool_call" ? icons.tool : icons.terminal);
  if (event.role === "meta") return renderMetaLine(event);
  return renderFoldEvent(event, "other", "other", event.role || "事件", icons.file);
}

function renderUser(event) {
  return \`<article class="event user">
    <div class="bubble-wrap">
      <div class="event-head"><span>你</span>\${sourceBadge(event)}\${timePart(event)}</div>
      <div class="bubble user">\${renderMarkdown(event.text || event.text_summary || "(空消息)")}</div>
    </div>
    <div class="avatar user">\${icons.user}</div>
  </article>\`;
}

function renderAssistant(event) {
  return \`<article class="event">
    <div class="avatar assistant">\${icons.assistant}</div>
    <div class="bubble-wrap">
      <div class="event-head"><span>Assistant</span>\${sourceBadge(event)}\${timePart(event)}</div>
      <div class="bubble assistant">\${renderMarkdown(event.text || event.text_summary || "(空消息)")}</div>
    </div>
  </article>\`;
}

function renderReasoning(event) {
  return \`<article class="event other">
    <div class="avatar other">\${icons.event}</div>
    <div class="bubble-wrap">
      <button class="fold" type="button" data-toggle-raw>\${icons.down}<strong>推理过程</strong><span class="summary">\${escapeHtml(event.text_summary || "")}</span>\${timePart(event)}</button>
      <pre class="raw reasoning">\${escapeHtml(event.text || event.text_summary || "")}</pre>
    </div>
  </article>\`;
}

function renderFoldEvent(event, className, avatarClass, label, icon) {
  return \`<article class="event \${className}">
    <div class="avatar \${avatarClass}">\${icon}</div>
    <div class="bubble-wrap">
      <button class="fold" type="button" data-toggle-raw>
        <span class="chev">\${icons.down}</span><strong>\${escapeHtml(label)}</strong>\${sourceBadge(event)}<span class="summary">\${escapeHtml(event.text_summary || event.kind || "")}</span>\${timePart(event)}
      </button>
      <pre class="raw">\${escapeHtml(JSON.stringify(event.raw, null, 2))}</pre>
    </div>
  </article>\`;
}

function renderMetaLine(event) {
  return \`<div class="meta-line"><span class="badge">\${escapeHtml(event.kind)}</span><span>\${escapeHtml(event.text_summary || "")}</span>\${timePart(event)}</div>\`;
}

function sourceBadge(event) {
  const outer = event.raw && event.raw.type ? event.raw.type : "";
  const payload = event.raw && event.raw.payload && event.raw.payload.type ? event.raw.payload.type : "";
  if (outer !== "event_msg" && outer !== "response_item") return "";
  if (!["user_message", "agent_message", "message"].includes(payload)) return "";
  return \`<span class="source">\${escapeHtml(outer + "/" + payload)}</span>\`;
}

function timePart(event) {
  const value = formatTime(event.timestamp);
  return value ? \`<span class="mono">· \${escapeHtml(value)}</span>\` : "";
}

function renderMarkdown(text) {
  const escaped = escapeHtml(String(text || ""));
  const blocks = escaped.split(/\\n{2,}/);
  return blocks.map((block) => {
    if (/^\\\`\\\`\\\`/.test(block.trim())) {
      return \`<pre><code>\${block.replace(/^\\\`\\\`\\\`[^\\n]*\\n?/, "").replace(/\\\`\\\`\\\`$/, "")}</code></pre>\`;
    }
    const lines = block.split("\\n");
    if (lines.every((line) => /^\\s*[-*]\\s+/.test(line))) {
      return \`<ul>\${lines.map((line) => \`<li>\${inlineMarkdown(line.replace(/^\\s*[-*]\\s+/, ""))}</li>\`).join("")}</ul>\`;
    }
    if (lines.every((line) => /^\\s*\\d+\\.\\s+/.test(line))) {
      return \`<ol>\${lines.map((line) => \`<li>\${inlineMarkdown(line.replace(/^\\s*\\d+\\.\\s+/, ""))}</li>\`).join("")}</ol>\`;
    }
    return \`<p>\${inlineMarkdown(lines.join("<br>"))}</p>\`;
  }).join("");
}

function inlineMarkdown(value) {
  return value
    .replace(/\\\`([^\\\`]+)\\\`/g, "<code>$1</code>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

async function copyText(text, okMessage) {
  if (!text) {
    showToast("没有可复制的内容");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMessage);
  } catch (_) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    showToast(okMessage);
  }
}

let toastTimer = 0;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { hour12: false });
}

function humanTokens(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return \`\${(n / 1000000).toFixed(1)}M\`;
  if (n >= 1000) return \`\${(n / 1000).toFixed(1)}K\`;
  return String(n);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\\\`/g, "&#96;");
}

init();
</script>
</body>
</html>`;
}

function icon(name) {
  if (name === "sparkles") {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>';
  }
  if (name === "copy") {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  }
  if (name === "folder") {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
  }
  if (name === "file") {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12h4"/><path d="M10 16h4"/></svg>';
  }
  if (name === "user") {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20a6 6 0 0 0-12 0"/><circle cx="12" cy="10" r="4"/></svg>';
  }
  if (name === "bot") {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M9 13v2"/><path d="M15 13v2"/></svg>';
  }
  if (name === "wrench") {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a5 5 0 0 0 6.9 6.9L13 21.8a2.4 2.4 0 1 1-3.4-3.4l8.6-8.6a5 5 0 0 0-3.5-3.5Z"/></svg>';
  }
  if (name === "terminal") {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';
  }
  if (name === "chevron") {
    return '<svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>';
  }
  return "";
}
