import { isIP } from "node:net";

export interface MinecraftServerTarget {
  host: string;
  port: number;
  address: string;
  key: string;
}

const DEFAULT_MINECRAFT_PORT = 25565;

export function parseMinecraftServerAddress(input: string): MinecraftServerTarget {
  const value = input.trim();
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Minecraft 服务器地址无效");
  }
  if (value.includes("://") || value.includes("/") || value.includes("@") || value.includes("?") || value.includes("#")) {
    throw new Error("Minecraft 服务器地址只能是主机名或 host:port，不能是 URL");
  }

  let host: string;
  let portText: string | null = null;
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    if (closing <= 1) throw new Error("Minecraft IPv6 地址格式无效");
    host = value.slice(1, closing);
    const suffix = value.slice(closing + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) throw new Error("Minecraft IPv6 地址格式无效");
      portText = suffix.slice(1);
    }
    if (isIP(host) !== 6) throw new Error("Minecraft IPv6 地址格式无效");
  } else {
    const colonCount = [...value].filter(character => character === ":").length;
    if (colonCount > 1) throw new Error("IPv6 地址必须使用 [address]:port 格式");
    const separator = value.lastIndexOf(":");
    if (separator >= 0) {
      host = value.slice(0, separator);
      portText = value.slice(separator + 1);
    } else {
      host = value;
    }
  }

  const normalizedHost = normalizeHost(host);
  const port = portText == null
    ? DEFAULT_MINECRAFT_PORT
    : parsePort(portText);
  const address = isIP(normalizedHost) === 6
    ? `[${normalizedHost}]:${port}`
    : `${normalizedHost}:${port}`;
  return { host: normalizedHost, port, address, key: address };
}

function normalizeHost(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/u, "");
  if (!value) throw new Error("Minecraft 服务器主机名不能为空");
  const ipKind = isIP(value);
  if (ipKind !== 0) return value;
  if (value.length > 253) throw new Error("Minecraft 服务器主机名过长");
  const labels = value.split(".");
  if (labels.some(label => (
    !label
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ))) {
    throw new Error("Minecraft 服务器主机名格式无效");
  }
  return value;
}

function parsePort(input: string): number {
  if (!/^\d{1,5}$/u.test(input)) throw new Error("Minecraft 服务器端口无效");
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Minecraft 服务器端口必须在 1 到 65535 之间");
  }
  return port;
}
