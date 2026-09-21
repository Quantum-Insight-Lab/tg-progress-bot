type LogFields = Record<string, unknown>;

function write(level: "debug" | "info" | "warn" | "error", message: string, fields?: LogFields): void {
  const payload =
    fields === undefined ? { level, message } : { level, message, ...fields };
  const sink = level === "error" ? process.stderr : process.stdout;
  sink.write(`${JSON.stringify(payload)}\n`);
}

/** Единственный логгер (S-4). */
export const logger = {
  debug(message: string, fields?: LogFields): void {
    write("debug", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    write("info", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    write("warn", message, fields);
  },
  error(message: string, fields?: LogFields): void {
    write("error", message, fields);
  },
};
