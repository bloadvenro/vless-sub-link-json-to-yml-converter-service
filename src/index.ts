import { ConfigError, readConfig } from "./config.js";
import { createGateway } from "./server.js";

const HOST = "0.0.0.0";
const PORT = 17_890;

const main = (): void => {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof ConfigError
        ? `Invalid configuration: ${error.key}`
        : "Invalid configuration",
    );
    process.exitCode = 1;
    return;
  }

  const gateway = createGateway(config);
  gateway.server.on("error", () => {
    console.error("Server failed");
    process.exit(1);
  });
  gateway.server.listen(PORT, HOST, () => {
    console.log("happ2mihomo listening on 0.0.0.0:17890");
  });

  const stop = (): void => {
    void gateway.drain().then((code) => process.exit(code));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
};

main();
