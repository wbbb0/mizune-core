import pino from "pino";

export function createSilentLogger() {
  return pino({ level: "silent" });
}
