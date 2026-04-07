import { createTestAppConfig } from "./config-fixtures.tsx";

export function createForwardFeatureConfig() {
  return createTestAppConfig({
    proxy: {
      http: {
        type: "http",
        host: "127.0.0.1",
        port: 7890
      }
    },
    llm: {
      providers: {
        test: {
          proxy: true
        }
      },
      models: {
        main: {
          supportsVision: true
        }
      }
    },
    shell: {
      enabled: true
    },
    search: {
      googleGrounding: {
        enabled: true,
        proxy: true
      }
    },
    browser: {
      enabled: true,
      playwright: {
        enabled: true,
        proxy: true
      }
    }
  });
}

export async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}
