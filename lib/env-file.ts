/**
 * 环境文件（.env 风格）的读写。雷达快照的 `--env-file` 和客户端分析的凭证文件共用这一份解析。
 *
 * 一行一项：`KEY=值`，可以有 `export ` 前缀。`#` 开头是注释。值可以用单引号、双引号包起来（双引号里按 JSON 规则转义），
 * 不加引号时末尾的 ` # 注释` 不算值的一部分。格式不对的行不解析，由调用方决定要不要报错。
 */
export function parseEnvFile(content: string): { values: Record<string, string>; invalid: string[] } {
  const values: Record<string, string> = {};
  const invalid: string[] = [];
  for (const row of content.split(/\r?\n/)) {
    const line = row.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const raw = rawValue.trim();
    if (raw.startsWith('"')) {
      try {
        values[key] = JSON.parse(raw) as string;
      } catch {
        invalid.push(key);
      }
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      if (end < 0) invalid.push(key);
      else values[key] = raw.slice(1, end);
    } else {
      values[key] = raw.split(/\s+#/, 1)[0].trim();
    }
  }
  return { values, invalid };
}

/** 把一组值写成上面的格式。需要时用双引号包起来（JSON 转义），保证读回来一字不差。 */
export function serializeEnvFile(entries: Record<string, string>, order: readonly string[] = []): string {
  const keys = [...order.filter((key) => key in entries), ...Object.keys(entries).filter((key) => !order.includes(key))];
  return keys.map((key) => {
    const value = entries[key];
    const needsQuotes = value === "" || /[\s"'\\#=$]/.test(value) || value !== value.trim();
    return `${key}=${needsQuotes ? JSON.stringify(value) : value}`;
  }).join("\n") + (keys.length > 0 ? "\n" : "");
}
