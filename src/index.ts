import { ConfigError, readConfig } from "./config.js";
import { createGateway } from "./server.js";

const HOST = "0.0.0.0";

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
  gateway.server.listen(config.listenPort, HOST, () => {
    const address = gateway.server.address();
    if (address === null || typeof address === "string") {
      console.error("Server failed");
      void gateway.drain().then(() => process.exit(1));
      return;
    }
    console.log(`happ2mihomo listening on ${HOST}:${address.port}`);
  });

  const stop = (): void => {
    void gateway.drain().then((code) => process.exit(code));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
};

main();
