type LogFieldValue = string | number | boolean | undefined | null;

type LogFields = Record<string, LogFieldValue>;

const timestamp = (): string => {
  return new Date().toISOString();
};

const formatValue = (value: Exclude<LogFieldValue, undefined | null>): string => {
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  return String(value);
};

const formatFields = (fields: LogFields | undefined): string => {
  if (!fields) {
    return "";
  }

  return Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => {
      const [, value] = entry;
      return value !== undefined && value !== null;
    })
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
};

const emit = (level: "info" | "warn", message: string, fields?: LogFields): void => {
  const details = formatFields(fields);
  const line = `${timestamp()} [pigeon] ${message}${details ? ` ${details}` : ""}`;

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logInfo = (message: string, fields?: LogFields): void => {
  emit("info", message, fields);
};

export const logWarning = (message: string, fields?: LogFields): void => {
  emit("warn", message, fields);
};

export const logError = (message: string, error: unknown): void => {
  console.error(`${timestamp()} [pigeon] ${message}`, error);
};
