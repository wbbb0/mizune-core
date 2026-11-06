import os from "node:os";
import { after, mock } from "node:test";

// Import before modules that enumerate NICs at module initialization (e.g. ali-oss).
// These offline tests exercise service behavior independently of the runner's host NICs.
const interfaces = mock.method(os, "networkInterfaces", () => ({
  lo: [{
    address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" as const,
    mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8"
  }]
}));

after(() => interfaces.mock.restore());
