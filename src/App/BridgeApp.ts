import { Bridge } from "../Bridge";
import { BridgeConfig, parseRegistrationFile } from "../config/Config";
import { MatrixSender } from "../MatrixSender";
import { UserNotificationWatcher } from "../notifications/UserNotificationWatcher";
import { ListenerService } from "../ListenerService";
import { Logger, getBridgeVersion } from "matrix-appservice-bridge";
import { IAppserviceRegistration, LogService } from "matrix-bot-sdk";
import { getAppservice } from "../Appservice";
import BotUsersManager from "../managers/BotUsersManager";
import * as Sentry from "@sentry/node";
import { GenericHookConnection } from "../Connections";
import { UserTokenStore } from "../tokens/UserTokenStore";
import { WebhookTransformer } from "../generic/WebhookTransformer";

Logger.configure({ console: "info" });
const log = new Logger("App");

export async function start(
  config: BridgeConfig,
  registration: IAppserviceRegistration,
) {
  const listener = new ListenerService(config.listeners);
  listener.start();
  Logger.configure({
    console: config.logging.level,
    colorize: config.logging.colorize,
    json: config.logging.json,
    timestampFormat: config.logging.timestampFormat,
  });
  LogService.setLogger(Logger.botSdkLogger);

  const { appservice, storage } = getAppservice(config, registration);

  if (!config.queue) {
    const matrixSender = new MatrixSender(config, appservice);
    matrixSender.listen();
    const userNotificationWatcher = new UserNotificationWatcher(config);
    userNotificationWatcher.start();
  }

  if (config.sentry) {
    Sentry.init({
      dsn: config.sentry.dsn,
      environment: config.sentry.environment,
      release: getBridgeVersion(),
      serverName: config.bridge.domain,
      includeLocalVariables: true,
    });
    log.info("Sentry reporting enabled");
  }

  if (config.generic?.allowJsTransformationFunctions) {
    await WebhookTransformer.initialiseQuickJS();
  }

  const botUsersManager = new BotUsersManager(config, appservice);

  const tokenStore = await UserTokenStore.fromKeyPath(
    config.passFile,
    appservice.botIntent,
    config,
  );
  const bridgeApp = new Bridge(
    config,
    tokenStore,
    listener,
    appservice,
    storage,
    botUsersManager,
  );

  return {
    appservice,
    bridgeApp,
    storage,
    listener,
  };
}

async function startFromFile() {
  const { configFiles, registrationFile } =
    BridgeConfig.getConfigOptionsFromArgv();
  const config = await BridgeConfig.parseConfig(configFiles, process.env);
  const registration = await parseRegistrationFile(registrationFile);
  const { bridgeApp, listener, storage } = await start(config, registration);
  process.once("SIGTERM", () => {
    log.error("Got SIGTERM");
    listener.stop();
    bridgeApp.stop();
    // Don't care to await this, as the process is about to end
    storage.disconnect?.();
  });
  await bridgeApp.start();
  listener.finaliseListeners();
}

if (require.main === module) {
  startFromFile().catch((ex) => {
    if (Logger.root.configured) {
      log.error("BridgeApp encountered an error and has stopped:", ex);
    } else {
      // eslint-disable-next-line no-console
      console.error("BridgeApp encountered an error and has stopped", ex);
    }
    process.exit(1);
  });
}
